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
const { runLog } = require("./run-log");
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
/** Brotli quality: Full packages smallest (packQuality), Month packages fast (packQualityMonth). */
function packQualityFor(planKind, config) {
  return planKind === "full" ? config.packQuality : config.packQualityMonth;
}

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
class StallError extends Error {
  constructor(database, seconds) {
    super(`${database} made no progress for ${Math.round(seconds / 60)} minute(s)`);
    this.code = "STALLED";
    this.database = database;
  }
}

async function runExport(options) {
  const { source, config, databases, kind, period, operator, outputDir, websitePublicKeyPem, exporterKeys } = options;
  const dryrunOf = options.dryrunOf || "month";
  const userOnEvent = options.onEvent || (() => {});
  const started = Date.now();

  // ── Watchdog ───────────────────────────────────────────────────────────
  // Every database must show activity (a table started, a batch of rows, a
  // table finished) at least every stallSeconds (default 3 min). If one goes
  // silent, nothing more will come from it (a worker that never started, a
  // read that never returns): the whole export is stopped with STALLED and
  // the caller starts it again once. Each event is also written to
  // export-log.txt, so a hang can be looked at afterwards.
  const stallMs = (Number(config.stallSeconds) || 180) * 1000;
  const lastActivity = new Map(); // database → time of its last event
  const running = new Set();
  let stallReject = null;
  const stalled = new Promise((_, reject) => {
    stallReject = reject;
  });
  stalled.catch(() => {});
  const onEvent = (e) => {
    if (e && e.database) lastActivity.set(e.database, Date.now());
    if (e && e.type !== "table-progress") runLog(`${e.type} ${e.database || ""} ${e.table || ""} ${e.rows != null ? e.rows + " rows" : ""}`.trim());
    userOnEvent(e);
  };
  runLog(`export start: kind=${kind}${kind === "dryrun" ? `/${dryrunOf}` : ""} period=${period} databases=${databases.map((d) => d.website).join(",")} processes=${config.useProcesses !== false}`);

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
    packQuality: packQualityFor(plan.planKind, config),
  };

  const waitingShown = new Map(); // database → minutes already reported
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const dbName of running) {
      const idle = now - (lastActivity.get(dbName) || now);
      if (idle >= stallMs && !firstError) {
        firstError = new StallError(dbName, idle / 1000);
        runLog(`STALLED: ${dbName} silent for ${Math.round(idle / 1000)} s; stopping this attempt`);
        for (const c of children) c.kill();
        if (!useProcesses && source) source.close().catch(() => {}); // breaks a read that never returns
        stallReject(firstError);
        return;
      }
      if (idle >= 60000) {
        const minutes = Math.floor(idle / 60000);
        if (minutes !== (waitingShown.get(dbName) || 0)) {
          waitingShown.set(dbName, minutes);
          userOnEvent({ type: "waiting", database: dbName, seconds: Math.round(idle / 1000) });
          runLog(`waiting: ${dbName} silent for ${Math.round(idle / 1000)} s`);
        }
      }
    }
  }, 5000);

  let perDb;
  try {
    perDb = await Promise.race([stalled, runLimited(databases, config.concurrency, async (db) => {
      try {
        if (firstError) throw firstError;
        running.add(db.website);
        lastActivity.set(db.website, Date.now());
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
              packQuality: job.packQuality,
              addBatch: (name, buf) => writer.addBatch(name, buf),
              onEvent,
              isCancelled,
            });
        running.delete(db.website);
        onEvent({ type: "db-done", database: db.website, ms: r.ms, totals: r.totals });
        return r;
      } catch (err) {
        running.delete(db.website);
        if (!firstError) firstError = new Error(`${db.website} (${db.source}): ${err.message}`);
        for (const c of children) {
          if (c.connected) c.send({ type: "cancel" });
        }
        throw firstError;
      }
    })]);
  } catch (err) {
    clearInterval(watchdog);
    for (const c of children) c.kill();
    await writer.abort();
    runLog(`export failed: ${(firstError || err).message}`);
    throw firstError || err;
  }
  clearInterval(watchdog);

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

  runLog(`export done: ${fileName} ${result.bytes} bytes in ${seconds} s`);
  return { ...result, plan, manifest, seconds };
}

module.exports = { planExport, runExport, StallError };
