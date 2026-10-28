"use strict";

/**
 * The manifest: the ONLY place table names live. Both the exporter (what to read)
 * and the website (how to apply) work from this list.
 *
 * Modes (see docs/payslip-sync/02-architecture.md §3):
 *   swap           full copy -> <table>__stage -> RENAME TABLE with live (old copy -> <table>__prev)
 *   replace-scope  only rows of one scope value (e.g. one period) are replaced
 *   merge-columns  rows matched by `key`; only the sent columns are written; new keys inserted; nothing deleted
 *
 * masterOnly: only in the master database (officers = hicaddata), never in the class databases.
 * optional:   if the table does not exist in a source database, it is skipped (not an error) and the
 *             package simply has no entry for it in that database.
 *
 * applyAt:
 *   prepare  applied while the month is still invisible (safe, see 02 §4.1)
 *   golive   swapped in by the single RENAME TABLE at Go live
 *
 * rollback (derived from mode, see rollbackFor):
 *   prev-table     swap tables: the old copy is kept as <table>__prev
 *   undo-snapshot  merge-columns / replace-scope: before applying, the website copies the rows it is
 *                  about to change (only the sent columns, only the scope) into <table>__undo
 *
 * key:
 *   merge-columns / replace-scope: the unique key on the website table (required)
 *   swap: sort order only (rows are sent in this order so InnoDB loads them in primary-key order)
 */

const MANIFEST_VERSION = 1;

/** Website database names, one per payroll class. The exporter maps each to its source database. */
const DATABASES = ["officers", "wofficers", "ratings", "ratingsA", "ratingsB", "juniorTrainee"];

/**
 * py_payrollclass.classcode of each database. On both sides a class database is found by
 * its classcode (py_payrollclass.db_name gives the database), not by its name or by settings.
 */
const DATABASE_CLASSCODES = {
  officers: "1",
  wofficers: "2",
  ratings: "3",
  ratingsA: "4",
  ratingsB: "5",
  juniorTrainee: "6",
};

/** Database key for a py_payrollclass.classcode, or null. */
function databaseForClasscode(code) {
  const c = String(code == null ? "" : code).trim().replace(/^0+(?=\d)/, "");
  return Object.keys(DATABASE_CLASSCODES).find((k) => DATABASE_CLASSCODES[k] === c) || null;
}

/** Database that also holds master-only tables (py_payrollclass). officers = hicaddata. */
const MASTER_DATABASE = "officers";

/** hr_employees columns owned by payroll. Login / security columns are website-owned and never sent. */
const HR_EMPLOYEES_PAYROLL_COLUMNS = [
  "EMPL_ID",
  "Surname",
  "othername",
  "Title",
  "gradelevel",
  "bankcode",
  "BankACNumber",
  "pfacode",
  "nsitfcode",
  "factory",
  "location",
  "payrollclass",
  "dateleft",
];

const ALL = "*";

function lookup(name, key, { masterOnly = false } = {}) {
  return {
    name,
    key,
    columns: ALL,
    ...(masterOnly ? { masterOnly: true } : {}),
    month: { mode: "swap", applyAt: "prepare" },
    full: { mode: "swap", applyAt: "golive" },
  };
}

// Shared lookups live only in the master (hicaddata) on the website: the class databases
// (hicaddata1..5) have none of them. Sent once, from officers; never looked for in class databases.
const MASTER = { masterOnly: true };

const TABLES = [
  lookup("ac_months", ["cmonth"], MASTER),
  lookup("py_elementtype", ["PaymentType"], MASTER),
  lookup("py_bank", ["bankcode", "branchcode"], MASTER),
  lookup("py_pfa", ["pfacode"], MASTER),
  lookup("ac_businessline", ["busline"], MASTER),
  lookup("ac_costcentre", ["unitcode"], MASTER),
  {
    ...lookup("py_payrollclass", ["classcode"]),
    masterOnly: true,
  },
  {
    // Master only: on the website hr_employees exists only in hicaddata, holding every staff member.
    name: "hr_employees",
    key: ["EMPL_ID"],
    masterOnly: true,
    columns: HR_EMPLOYEES_PAYROLL_COLUMNS,
    month: { mode: "merge-columns", applyAt: "prepare" },
    full: { mode: "merge-columns", applyAt: "prepare" },
  },
  {
    // Optional: some class databases (e.g. juniorTrainee) have no IPPIS table.
    name: "py_ipis_payhistory",
    key: ["period", "numb", "Type"],
    optional: true,
    columns: ALL,
    month: { mode: "replace-scope", scope: "period", applyAt: "prepare" },
    full: { mode: "swap", applyAt: "golive" },
  },
  {
    name: "py_payhistory",
    key: ["his_empno", "his_year", "his_type"],
    columns: ALL,
    // Month package: key columns + only the month column groups since the previous package,
    // one scope per his_year. See exporter/extract/months.js.
    month: { mode: "merge-columns", scope: "his_year", columnSet: "month-groups", applyAt: "prepare" },
    full: { mode: "swap", applyAt: "golive" },
  },
  {
    name: "py_masterpayded",
    key: ["his_Empno", "his_type"],
    columns: ALL,
    month: { mode: "swap", applyAt: "golive" },
    full: { mode: "swap", applyAt: "golive" },
  },
  {
    name: "py_mastercum",
    key: ["his_Empno", "his_type"],
    columns: ALL,
    month: { mode: "swap", applyAt: "golive" },
    full: { mode: "swap", applyAt: "golive" },
  },
  {
    // Switched last, in the same RENAME TABLE as masterpayded/mastercum: it moves the current period (BT05).
    name: "py_stdrate",
    key: ["type"],
    columns: ALL,
    month: { mode: "swap", applyAt: "golive" },
    full: { mode: "swap", applyAt: "golive" },
  },
];

/**
 * Package kinds. `dryrun` is for timing only; the website must never apply it. A dry run reads
 * like a month or a full package (`dryrunOf` in the package manifest).
 */
const KINDS = ["month", "full", "dryrun"];

function rollbackFor(mode) {
  return mode === "swap" ? "prev-table" : "undo-snapshot";
}

/**
 * Tables to export for one database and package kind, with the mode resolved.
 * `dryrun` behaves like `month` unless planKind is given.
 */
function tablesFor(database, kind) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown package kind: ${kind}`);
  const plan = kind === "full" ? "full" : "month";
  return TABLES.filter((t) => !t.masterOnly || database === MASTER_DATABASE).map((t) => ({
    name: t.name,
    key: t.key,
    columns: t.columns,
    optional: Boolean(t.optional),
    ...t[plan],
    rollback: rollbackFor(t[plan].mode),
  }));
}

/** Tables swapped at Go live (for the website's single RENAME TABLE). */
function goliveTables(kind) {
  const plan = kind === "full" ? "full" : "month";
  return TABLES.filter((t) => t[plan].mode === "swap" && t[plan].applyAt === "golive").map((t) => t.name);
}

function findTable(name) {
  return TABLES.find((t) => t.name.toLowerCase() === String(name).toLowerCase()) || null;
}

module.exports = {
  MANIFEST_VERSION,
  DATABASES,
  DATABASE_CLASSCODES,
  databaseForClasscode,
  MASTER_DATABASE,
  HR_EMPLOYEES_PAYROLL_COLUMNS,
  TABLES,
  KINDS,
  tablesFor,
  goliveTables,
  findTable,
  rollbackFor,
};
