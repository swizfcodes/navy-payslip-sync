"use strict";

/**
 * First run (or --setup). Everything the officer needs, in the app:
 *   - server and connection options
 *   - sign in with the read-only login, or create it now with an admin login (never saved)
 *   - find the payroll databases on the server and pick which is which class from a list
 * Passwords are never saved.
 */

const { DATABASES, MASTER_DATABASE } = require("../../shared/manifest");
const { DEFAULTS, saveConfig } = require("../config");
const { num } = require("./format");

/** Map a class description or database name to a website database key, or null. */
function matchClassKey(text) {
  const t = String(text || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (/junior|trainee/.test(t)) return "juniorTrainee";
  if (/warrant|wofficer|^wo$/.test(t)) return "wofficers";
  if (/ratingsa$|ratinga$/.test(t)) return "ratingsA";
  if (/ratingsb$|ratingb$/.test(t)) return "ratingsB";
  if (/rating/.test(t)) return "ratings";
  if (/officer/.test(t)) return "officers";
  return null;
}

function pickColumn(row, candidates) {
  const keys = Object.keys(row || {});
  for (const c of candidates) {
    const k = keys.find((x) => x.toLowerCase() === c);
    if (k) return k;
  }
  return null;
}

/** Suggested source database for each website database, from py_payrollclass and database names. */
async function suggestMapping(source, found) {
  const suggestion = {};
  const names = new Map(found.map((d) => [d.name.toLowerCase(), d.name]));
  const masters = found.filter((d) => d.hasPayrollClass);

  if (masters.length) {
    const rows = await source.payrollClasses(masters[0].name);
    if (rows.length) {
      const nameCol = pickColumn(rows[0], ["classname", "description", "classdesc", "name"]);
      const dbCol = pickColumn(rows[0], ["db_name", "dbname", "database", "databasename"]);
      if (nameCol && dbCol) {
        for (const r of rows) {
          const key = matchClassKey(r[nameCol]);
          const db = names.get(String(r[dbCol] || "").trim().toLowerCase());
          if (key && db && !suggestion[key]) suggestion[key] = db;
        }
      }
    }
  }
  for (const d of found) {
    const key = matchClassKey(d.name);
    if (key && !suggestion[key] && !Object.values(suggestion).includes(d.name)) suggestion[key] = d.name;
  }
  if (!suggestion[MASTER_DATABASE] && masters.length === 1 && !Object.values(suggestion).includes(masters[0].name)) {
    suggestion[MASTER_DATABASE] = masters[0].name;
  }
  return suggestion;
}

async function askNewPassword(prompt) {
  for (;;) {
    const a = await prompt.askHidden("  New password for the read-only login");
    if (a.length < 10) {
      console.log("    Use at least 10 characters.");
      continue;
    }
    const b = await prompt.askHidden("  Type it again");
    if (a === b) return a;
    console.log("    The two entries differ. Try again.");
  }
}

async function chooseDatabases(prompt, found, suggestion, current) {
  console.log(`\n  Found ${found.length} payroll database(s) on this server:`);
  found.forEach((d, i) => {
    const per = d.period ? `period ${d.period.year}-${String(d.period.month).padStart(2, "0")}` : "no BT05";
    const staff = d.staff == null ? "" : `${num(d.staff)} ${d.staffLabel || "staff"}`;
    const master = d.hasPayrollClass ? "  (has py_payrollclass)" : "";
    console.log(`    [${i + 1}] ${d.name.padEnd(24)} ${staff.padStart(14)}   ${per}${master}`);
  });
  console.log("    [0] skip this class\n");

  const map = {};
  for (const key of DATABASES) {
    const preferred = current[key] || suggestion[key] || "";
    const idx = found.findIndex((d) => d.name.toLowerCase() === preferred.toLowerCase());
    const label = key === MASTER_DATABASE ? `${key} (master)` : key;
    for (;;) {
      const a = await prompt.ask(`  ${label.padEnd(20)} database number`, idx >= 0 ? String(idx + 1) : "0");
      const n = Number(a);
      if (Number.isInteger(n) && n >= 0 && n <= found.length) {
        map[key] = n === 0 ? "" : found[n - 1].name;
        break;
      }
      console.log(`    Enter a number from 0 to ${found.length}.`);
    }
  }
  const chosen = Object.values(map).filter(Boolean);
  if (new Set(chosen).size !== chosen.length) {
    throw new Error("The same database was chosen for two classes. Run --setup again.");
  }
  if (!chosen.length) throw new Error("No database chosen. Run --setup again.");
  return map;
}

/** Returns { config, password } — the read-only login's password for this run only. */
async function runSetup(prompt, existing) {
  const cfg = JSON.parse(JSON.stringify(existing || DEFAULTS));
  console.log("\nSetup — saved on this machine only. Passwords are never saved.\n");

  cfg.exporterId = await prompt.ask("  Exporter name (shown on the website)", cfg.exporterId);
  cfg.source.server = await prompt.ask("  SQL Server (e.g. HICAD-THREEONE\\SQL2022)", cfg.source.server);
  if (!cfg.source.server) throw new Error("A server name is needed.");
  if (!cfg.source.server.includes("\\")) {
    cfg.source.port = Number(await prompt.ask("  Port", cfg.source.port || 1433)) || 1433;
  } else {
    cfg.source.port = null; // named instance: SQL Browser finds the port
  }
  cfg.source.encrypt = await prompt.confirm("  Encrypt the SQL connection", Boolean(cfg.source.encrypt));

  const mode = await prompt.choose(
    "  Read-only login:",
    ["Already created, sign in with it", "Create it now (needs an admin login, not saved)"],
    cfg.source.user ? 0 : 1,
  );

  const { MssqlSource } = require("../sources/mssql-source"); // loaded here so tests need no driver
  let source;
  let readOnlyPassword;
  if (mode === 0) {
    cfg.source.user = await prompt.ask("  Read-only login", cfg.source.user || "sync_reader");
    readOnlyPassword = await prompt.askHidden("  Password");
    source = new MssqlSource(cfg.source, readOnlyPassword);
  } else {
    const adminUser = await prompt.ask("  Admin login", "sa");
    const adminPassword = await prompt.askHidden("  Admin password");
    source = new MssqlSource({ ...cfg.source, user: adminUser }, adminPassword, { readOnly: false });
  }

  try {
    await source.connect();
  } catch (err) {
    throw new Error(`Could not connect to ${cfg.source.server}: ${err.message}`);
  }

  try {
    console.log("\n  Looking for payroll databases...");
    const found = await source.listPayrollDatabases();
    if (!found.length) throw new Error("No payroll databases visible to this login (none has py_stdrate and py_elementtype).");
    const suggestion = await suggestMapping(source, found);
    cfg.databases = await chooseDatabases(prompt, found, suggestion, cfg.databases || {});

    if (mode === 1) {
      console.log("");
      cfg.source.user = await prompt.ask("  Read-only login name to create", cfg.source.user || "sync_reader");
      readOnlyPassword = await askNewPassword(prompt);
      const mapped = Object.values(cfg.databases).filter(Boolean);
      const done = await source.createReadOnlyLogin(cfg.source.user, readOnlyPassword, mapped, { resetPassword: true });
      for (const d of done) console.log(`    ${d}`);
    }
  } finally {
    await source.close().catch(() => {});
  }

  await saveConfig(cfg);
  console.log("\n  Settings saved. From now on, only the read-only login is used.\n");
  return { config: cfg, password: readOnlyPassword };
}

module.exports = { runSetup, matchClassKey, suggestMapping };
