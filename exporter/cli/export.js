"use strict";

const fs = require("fs");
const path = require("path");
const { planExport, runExport } = require("../export-job");
const { MssqlSource } = require("../sources/mssql-source");
const { logPath } = require("../run-log");
const { saveConfig } = require("../config");
const { dots, num, col, rcol, mb, formatDuration } = require("./format");

function prettyPeriod(p) {
  return `${p.slice(0, 4)}-${p.slice(4, 6)}`;
}

function scopeLabel(scope) {
  if (!scope) return "";
  return Object.entries(scope)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/**
 * IPPIS rows for the period in each database. Prints one line per database and returns
 * the databases that have an IPPIS table but no rows for the period.
 */
async function checkIppis(source, databases, period) {
  console.log(`  IPPIS for ${prettyPeriod(period)}:`);
  const missing = [];
  for (const db of databases) {
    let r;
    try {
      r = await source.ippisForPeriod(db.source, period);
    } catch (err) {
      console.log(`    ${col(db.website, 15)} could not check (${err.message})`);
      missing.push(db.website);
      continue;
    }
    if (r == null) {
      console.log(`    ${col(db.website, 15)} no IPPIS table in this database (skipped)`);
    } else if (r.rows === 0) {
      console.log(`    ${col(db.website, 15)} NONE`);
      missing.push(db.website);
    } else {
      const staff = r.staff != null ? `, ${num(r.staff)} staff` : "";
      console.log(`    ${col(db.website, 15)} ${num(r.rows)} rows${staff}`);
    }
  }
  return missing;
}

/** STEP 2 — Export. Returns the export result. */
const PROGRESS_EVERY = 250000; // print a running count for long tables

async function stepExport(prompt, { config, source, databases, period, password, dryRun, keys }) {
  console.log("\nSTEP 2 of 3 — Export");

  let kind = "dryrun";
  let dryrunOf;
  const i = await prompt.choose(`  ${dots("Kind", 15)}`, ["Month", "Full"], 0);
  if (dryRun) {
    dryrunOf = i === 0 ? "month" : "full";
    console.log(`  Dry run of a ${dryrunOf} package: timing test only, the website never applies it.`);
  } else {
    kind = i === 0 ? "month" : "full";
  }
  console.log(`  ${dots("Period", 15)} ${prettyPeriod(period)}  (current processing period, BT05)`);

  let outputDir;
  for (;;) {
    outputDir = path.resolve(await prompt.ask(`  ${dots("Save to", 15)}`, config.outputDir || process.cwd()));
    try {
      fs.accessSync(outputDir, fs.constants.W_OK);
      break;
    } catch (_) {
      console.log(`    Cannot write to ${outputDir}. Insert the drive or choose another folder.`);
    }
  }
  const operator = await prompt.ask(`  ${dots("Your name", 15)}`, config.lastOperator || "");

  const plan = await planExport({ kind, period, dryrunOf });
  console.log("");
  if (kind !== "dryrun") {
    const follows = plan.baseSeq == null ? "first package" : `follows ${plan.baseSeq}`;
    console.log(`  Package seq ${plan.seq} (${follows}), ${kind}, ${prettyPeriod(period)}, ${databases.length} database(s)`);
  }
  if (plan.payhistoryMonths) {
    const m = plan.payhistoryMonths.length
      ? plan.payhistoryMonths.map((g) => `${g.year}: month ${g.months.join(",")}`).join("; ")
      : "none (no month closed since the last package)";
    console.log(`  py_payhistory closed months to send: ${m}`);
  }
  if (config.useProcesses !== false && databases.length > 1) {
    console.log(`  Using ${Math.min(config.concurrency, databases.length)} processes (one per database).`);
  }

  // IPPIS is part of every payslip: a Month package should be exported after this month's
  // IPPIS upload. Full packages are not checked (they carry every period there is).
  let startByDefault = true;
  if (plan.planKind === "month") {
    const missing = await checkIppis(source, databases, period);
    if (missing.length) {
      console.log("");
      console.log(`  ! WARNING: no IPPIS for ${prettyPeriod(period)} in: ${missing.join(", ")}`);
      console.log("    IPPIS is part of every payslip. Staff in these databases would get payslips without");
      console.log("    their IPPIS earnings and deductions. Upload this month's IPPIS in payroll first,");
      console.log("    then export.");
      if (kind === "dryrun") {
        console.log("    (Dry run: timing only, so you can carry on.)");
      } else {
        startByDefault = false;
        if (!(await prompt.confirm("  Export without IPPIS anyway", false))) {
          throw new Error(`Export stopped: upload IPPIS for ${prettyPeriod(period)} first`);
        }
      }
    }
  }
  if (!(await prompt.confirm("  Start export", startByDefault))) throw new Error("Export cancelled");

  config.outputDir = outputDir;
  config.lastOperator = operator;
  await saveConfig(config);

  console.log("  Exporting...  (do not click inside this window while it works; if you did, press Esc)");
  const printed = new Map();
  const runOnce = (src) => runExport({
    source: src,
    password,
    config,
    databases,
    kind,
    dryrunOf,
    period,
    operator,
    outputDir,
    websitePublicKeyPem: keys.websitePublicKeyPem,
    exporterKeys: keys.exporter,
    onEvent: (e) => {
      if (e.type === "waiting") {
        const mins = Math.floor(e.seconds / 60);
        console.log(`    ${col(e.database, 15)} still waiting for SQL Server (${mins} min with no new rows)…`);
        return;
      }
      if (e.type === "table-progress") {
        const k = `${e.database}.${e.table}`;
        const step = Math.floor(e.rows / PROGRESS_EVERY);
        if (step > (printed.get(k) || 0)) {
          printed.set(k, step);
          console.log(`    ${col(e.database, 15)} ${col(`${e.table} …`, 36)} ${rcol(num(e.rows), 11)} rows so far`);
        }
      } else if (e.type === "table-skipped") {
        console.log(`    ${col(e.database, 15)} ${col(e.table, 36)} ${rcol("-", 11)}  ${e.reason}`);
      } else if (e.type === "table-done") {
        const label = `${e.table}${e.scope ? ` (${scopeLabel(e.scope)})` : ""}`;
        console.log(
          `    ${col(e.database, 15)} ${col(label, 36)} ${rcol(num(e.rows), 11)} rows ${rcol(formatDuration(e.ms), 10)}`,
        );
      } else if (e.type === "db-done") {
        console.log(`    ${col(e.database, 15)} done in ${formatDuration(e.ms)}`);
      }
    },
  });

  // A database that goes silent (no rows for config.stallSeconds, default 3 min) stops the
  // run with STALLED. Starting again is what fixed it by hand, so it is done once here,
  // on a fresh SQL connection. Nothing from the stopped attempt is kept.
  let result;
  try {
    result = await runOnce(source);
  } catch (err) {
    if (err.code !== "STALLED") throw err;
    console.log(`\n  ${err.database} stopped responding. Starting the export again automatically...`);
    console.log(`  (details are written to ${logPath()})\n`);
    printed.clear();
    const fresh = new MssqlSource(config.source, password, { maxConnections: config.concurrency + 2 });
    await fresh.connect();
    try {
      result = await runOnce(fresh);
    } catch (err2) {
      if (err2.code !== "STALLED") throw err2;
      throw new Error(
        `${err2.database} stopped responding twice. Check that SQL Server is running and that no payroll ` +
          `calculation or backup is running, then export again. Details: ${logPath()}`,
      );
    } finally {
      await fresh.close().catch(() => {});
    }
  }

  if (dryRun) printDryRunReport(result);
  return { ...result, kind };
}

function printDryRunReport(result) {
  console.log("\n  Dry run report (per table)");
  console.log(`    ${col("database", 15)} ${col("table", 30)} ${rcol("rows", 11)} ${rcol("raw", 9)} ${rcol("packed", 9)} ${rcol("time", 9)}`);
  let allRaw = 0;
  let allPacked = 0;
  for (const [dbName, db] of Object.entries(result.manifest.databases)) {
    let dbRaw = 0;
    let dbPacked = 0;
    for (const t of db.tables) {
      const label = `${t.table}${t.scope ? ` (${scopeLabel(t.scope)})` : ""}`;
      dbRaw += t.rawBytes || 0;
      dbPacked += t.packedBytes || 0;
      console.log(
        `    ${col(dbName, 15)} ${col(label.slice(0, 30), 30)} ${rcol(num(t.rows), 11)} ${rcol(mb(t.rawBytes), 9)} ${rcol(mb(t.packedBytes), 9)} ${rcol(formatDuration(t.ms), 9)}`,
      );
    }
    console.log(`    ${col(dbName, 15)} ${col("= database total", 30)} ${rcol("", 11)} ${rcol(mb(dbRaw), 9)} ${rcol(mb(dbPacked), 9)}`);
    allRaw += dbRaw;
    allPacked += dbPacked;
  }
  console.log(`    ${col("all databases", 15)} ${col("", 30)} ${rcol("", 11)} ${rcol(mb(allRaw), 9)} ${rcol(mb(allPacked), 9)}`);
}

module.exports = { stepExport };
