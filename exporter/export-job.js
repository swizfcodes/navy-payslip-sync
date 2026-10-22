"use strict";

/**
 * One export = one package file covering the configured databases.
 * Databases are read in parallel (config.concurrency) into a single writer.
 * With config.useProcesses (default) each database runs in its own process (worker.js),
 * so the export uses one CPU core per database.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { MANIFEST_VERSION } = require("../shared/manifest");
const { packageFileName } = require("../shared/package-format");
const { PackageWriter } = require("../shared/package-writer");
const { extractDatabase } = require("./extract/extractor");
const { closedMonthsSince } = require("./extract/months");
const { readLedger, lastKept, nextSeq, appendLedger } = require("./ledger");
const pkg = require("../package.json");

async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index;
      index += 1;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Work out seq / baseSeq / payhistory months before anything is read, so the
 * confirmation screen can show them.
 */
async function planExport({ kind, period, dryrunOf = "month" }) {
  const ledger = await readLedger();
  const last = lastKept(ledger);
  const seq = kind === "dryrun" ? 0 : nextSeq(ledger);
  const baseSeq = last ? last.seq : null;
  const planKind = kind === "dryrun" ? dryrunOf : kind; // which tables/scopes to read
  let payhistoryMonths = null;
  if (planKind === "month") {
    if (kind === "month" && !last) {
      throw new Error("No package has been exported yet: the first package must be a full package.");
    }
    payhistoryMonths = closedMonthsSince(last ? last.period : null, period);
  }
  return { seq, baseSeq, last, planKind, payhistoryMonths };
}

/** How to start a copy of this program: the .exe itself, or node + main.js in development. */
function selfCommand() {
  let isSea = false;
  try {
    // eslint-disable-next-line global-require
    isSea = require("node:sea").isSea();
  } catch (_) {
    isSea = false;
  }
  return isSea
    ? { command: process.execPath, args: [] }
    : { command: process.execPath, args: [path.join(__dirname, "main.js")] };
}

/** Export one database in a child process; resolves with the per-database manifest part. */
function extractInProcess({ db, job, writer, onEvent, registerChild }) {
  return new Promise((resolve, reject) => {
    const { command, args } = selfCommand();
    const child = spawn(command, args, {
      env: { ...process.env, NAVY_SYNC_WORKER: "1", NAVY_SYNC_NO_PAUSE: "1" },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
      windowsHide: true,
    });
    registerChild(child);
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result);
    };

    child.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "batch") {
        const buf = Buffer.isBuffer(msg.buffer)
          ? msg.buffer
          : Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
        writer
          .addBatch(msg.name, buf)
          .then(() => child.connected && child.send({ type: "ack", id: msg.id }))
          .catch((err) => {
            if (child.connected) child.send({ type: "ack", id: msg.id, error: err.message });
            finish(err);
          });
      } else if (msg.type === "event") {
        onEvent(msg.event);
      } else if (msg.type === "done") {
        finish(null, msg.result);
      } else if (msg.type === "error") {
        finish(new Error(msg.message));
      }
    });
    child.on("error", (err) => finish(new Error(`Could not start a worker: ${err.message}`)));
    child.on("exit", (code) => finish(new Error(`Worker for ${db.website} stopped unexpectedly (exit code ${code})`)));
    child.send({ type: "start", ...job, db });
  });
}

/**
 * options: { source, password, config, databases: [{website, source}], kind, period, operator, outputDir,
 *            websitePublicKeyPem, exporterKeys, onEvent }
 */
async function runExport(options) {
  const { source, config, databases, kind, period, operator, outputDir, websitePublicKeyPem, exporterKeys } = options;
  const dryrunOf = options.dryrunOf || "month";
  const onEvent = options.onEvent || (() => {});
  const started = Date.now();

  const plan = await planExport({ kind, period, dryrunOf });
  const createdAt = new Date();
  const fileName = packageFileName({ kind, period, seq: plan.seq, createdAt });
  const filePath = path.join(outputDir, fileName);
  if (fs.existsSync(filePath)) throw new Error(`${filePath} already exists`);
  await fsp.rm(`${filePath}.part`, { force: true });

  const writer = await PackageWriter.create({ filePath, websitePublicKeyPem });
  let firstError = null;
  const isCancelled = () => Boolean(firstError);
  const children = new Set();
  const useProcesses = config.useProcesses !== false && databases.length > 1 && Boolean(options.password);
  const job = {
    sourceConfig: config.source,
    password: options.password,
    kind: plan.planKind,
    period,
    payhistoryMonths: plan.payhistoryMonths,
    batchRows: config.batchRows,
  };

  let perDb;
  try {
    perDb = await runLimited(databases, config.concurrency, async (db) => {
      try {
        if (firstError) throw firstError;
        onEvent({ type: "db-start", database: db.website });
        const r = useProcesses
          ? await extractInProcess({
              db,
              job,
              writer,
              onEvent,
              registerChild: (c) => {
                children.add(c);
                c.on("exit", () => children.delete(c));
              },
            })
          : await extractDatabase({
              source,
              db,
              kind: plan.planKind,
              period,
              payhistoryMonths: plan.payhistoryMonths,
              batchRows: config.batchRows,
              addBatch: (name, buf) => writer.addBatch(name, buf),
              onEvent,
              isCancelled,
            });
        onEvent({ type: "db-done", database: db.website, ms: r.ms, totals: r.totals });
        return r;
      } catch (err) {
        if (!firstError) firstError = new Error(`${db.website} (${db.source}): ${err.message}`);
        for (const c of children) {
          if (c.connected) c.send({ type: "cancel" });
        }
        throw firstError;
      }
    });
  } catch (err) {
    for (const c of children) c.kill();
    await writer.abort();
    throw firstError || err;
  }

  const exportMs = Date.now() - started;
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    kind,
    dryrunOf: kind === "dryrun" ? dryrunOf : undefined,
    period,
    seq: plan.seq,
    baseSeq: plan.baseSeq,
    payhistoryMonths: plan.payhistoryMonths,
    exporterVersion: pkg.version,
    databases: Object.fromEntries(databases.map((db, i) => [db.website, perDb[i]])),
    timings: { exportMs, processes: useProcesses ? Math.min(config.concurrency, databases.length) : 1 },
  };

  let result;
  try {
    result = await writer.finish({
      headerFields: {
        kind,
        exporterId: config.exporterId,
        seq: plan.seq,
        baseSeq: plan.baseSeq,
        period,
        databases: databases.map((d) => d.website),
        createdAt: createdAt.toISOString(),
        operator,
        manifestVersion: MANIFEST_VERSION,
        exporterVersion: pkg.version,
      },
      manifest,
      exporterPrivateKeyPem: exporterKeys.privateKeyPem,
      exporterPublicKeyPem: exporterKeys.publicKeyPem,
    });
  } catch (err) {
    await writer.abort();
    throw err;
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  if (kind !== "dryrun") {
    await appendLedger({
      seq: plan.seq,
      baseSeq: plan.baseSeq,
      kind,
      period,
      file: fileName,
      bytes: result.bytes,
      fingerprint: result.fingerprint,
      payloadSha256: result.header.payloadSha256,
      operator,
      createdAt: result.header.createdAt,
      databases: databases.map((d) => d.website),
      seconds,
    });
  }

  return { ...result, plan, manifest, seconds };
}

module.exports = { planExport, runExport };
