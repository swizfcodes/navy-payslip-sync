"use strict";

const fs = require("fs");
const path = require("path");
const { planExport, runExport } = require("../export-job");
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

/** STEP 2 — Export. Returns the export result. */
async function stepExport(prompt, { config, source, databases, period, dryRun, keys }) {
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
    const m = plan.payhistoryMonths.map((g) => `${g.year}: months ${g.months.join(",")}`).join("; ");
    console.log(`  py_payhistory month columns: ${m}`);
  }
  if (!(await prompt.confirm("  Start export", true))) throw new Error("Export cancelled");

  config.outputDir = outputDir;
  config.lastOperator = operator;
  await saveConfig(config);

  console.log("  Exporting...");
  const result = await runExport({
    source,
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
      if (e.type === "table-done") {
        const label = `${e.table}${e.scope ? ` (${scopeLabel(e.scope)})` : ""}`;
        console.log(
          `    ${col(e.database, 15)} ${col(label, 36)} ${rcol(num(e.rows), 11)} rows ${rcol(formatDuration(e.ms), 10)}`,
        );
      } else if (e.type === "db-done") {
        console.log(`    ${col(e.database, 15)} done in ${formatDuration(e.ms)}`);
      }
    },
  });

  if (dryRun) printDryRunReport(result);
  return { ...result, kind };
}

function printDryRunReport(result) {
  console.log("\n  Dry run report (per table)");
  console.log(`    ${col("database", 15)} ${col("table", 30)} ${rcol("rows", 11)} ${rcol("raw", 9)} ${rcol("packed", 9)} ${rcol("time", 9)}`);
  for (const [dbName, db] of Object.entries(result.manifest.databases)) {
    for (const t of db.tables) {
      const label = `${t.table}${t.scope ? ` (${scopeLabel(t.scope)})` : ""}`;
      console.log(
        `    ${col(dbName, 15)} ${col(label.slice(0, 30), 30)} ${rcol(num(t.rows), 11)} ${rcol(mb(t.rawBytes), 9)} ${rcol(mb(t.packedBytes), 9)} ${rcol(formatDuration(t.ms), 9)}`,
      );
    }
  }
}

module.exports = { stepExport };
