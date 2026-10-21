"use strict";

/**
 * One export = one package file covering the configured databases.
 * Databases are read in parallel (config.concurrency) into a single writer.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { MANIFEST_VERSION } = require("../shared/manifest");
const { packageFileName } = require("../shared/package-format");
const { PackageWriter } = require("../shared/package-writer");
const { extractDatabase } = require("./extract/extractor");
const { monthsBetween } = require("./extract/months");
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
    payhistoryMonths = monthsBetween(last ? last.period : null, period);
  }
  return { seq, baseSeq, last, planKind, payhistoryMonths };
}

/**
 * options: { source, config, databases: [{website, source}], kind, period, operator, outputDir,
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

  let perDb;
  try {
    perDb = await runLimited(databases, config.concurrency, async (db) => {
      try {
        onEvent({ type: "db-start", database: db.website });
        const r = await extractDatabase({
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
        throw firstError;
      }
    });
  } catch (err) {
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
    timings: { exportMs },
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
