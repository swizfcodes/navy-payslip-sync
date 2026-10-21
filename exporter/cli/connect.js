"use strict";

const { MssqlSource } = require("../sources/mssql-source");
const { activeDatabases } = require("../config");
const { checkDatabase } = require("../checks");
const { dots, num, col, rcol } = require("./format");

/** STEP 1 — Connect. Returns { source, databases, period } or throws. knownPassword: from setup, this run only. */
async function stepConnect(prompt, config, knownPassword) {
  console.log("\nSTEP 1 of 3 — Connect");
  console.log(`  ${dots("Server", 18)} ${config.source.server}`);
  console.log(`  ${dots("Read-only user", 18)} ${config.source.user}`);
  const password = knownPassword || (await prompt.askHidden(`  ${dots("Password", 18)}`));

  const databases = activeDatabases(config);
  if (!databases.length) throw new Error("No databases configured. Run with --setup.");

  const source = new MssqlSource(config.source, password, { maxConnections: config.concurrency + 2 });
  try {
    await source.connect();
  } catch (err) {
    throw new Error(`Could not connect to ${config.source.server}: ${err.message}`);
  }

  console.log("  Testing databases...");
  const results = [];
  for (const db of databases) {
    const r = await checkDatabase(source, db);
    results.push(r);
    const status = r.ok ? "ok" : "FAILED";
    const staff = r.staff == null ? "" : `${num(r.staff)} staff`;
    const per = r.period ? `period ${r.period.year}-${String(r.period.month).padStart(2, "0")}` : "";
    console.log(`    ${col(db.website, 15)} ${col(status, 7)} ${rcol(staff, 14)}   ${per}`);
    for (const p of r.problems) console.log(`        - ${p}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    await source.close();
    throw new Error(`${failed.length} database(s) failed the checks above. Fix them and run again.`);
  }

  const periods = [...new Set(results.map((r) => r.period.period))];
  if (periods.length > 1) {
    await source.close();
    throw new Error(`Databases are on different periods (${periods.join(", ")}). All must be on the same BT05 period.`);
  }

  return { source, databases, period: periods[0] };
}

module.exports = { stepConnect };
