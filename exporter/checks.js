"use strict";

/**
 * Connect-step checks, per database: reachable, current period (BT05), every manifest table
 * present (optional tables only noted), hr_employees payroll columns (master only), and a
 * staff figure: all staff in the master's hr_employees, staff paid this month elsewhere.
 */

const { tablesFor, HR_EMPLOYEES_PAYROLL_COLUMNS, MASTER_DATABASE } = require("../shared/manifest");

async function checkDatabase(source, db) {
  const result = {
    website: db.website,
    source: db.source,
    ok: false,
    staff: null,
    staffLabel: "staff",
    period: null,
    problems: [],
    notes: [],
  };
  try {
    result.period = await source.currentPeriod(db.source);
    if (!result.period) result.problems.push("py_stdrate has no valid BT05 row");

    for (const table of tablesFor(db.website, "full")) {
      const cols = await source.columns(db.source, table.name);
      if (!cols.length) {
        if (table.optional) result.notes.push(`${table.name} not present: skipped`);
        else result.problems.push(`table ${table.name} not found`);
        continue;
      }
      if (table.name === "hr_employees") {
        const have = new Set(cols.map((c) => c.name.toLowerCase()));
        const missing = HR_EMPLOYEES_PAYROLL_COLUMNS.filter((c) => !have.has(c.toLowerCase()));
        if (missing.length) result.problems.push(`hr_employees missing column(s): ${missing.join(", ")}`);
      }
    }

    if (db.website === MASTER_DATABASE) {
      if (!result.problems.some((p) => p.includes("hr_employees"))) {
        result.staff = await source.countRows(db.source, "hr_employees");
      }
    } else if (result.period) {
      result.staff = (await source.totals(db.source, result.period.month)).staffCount;
      result.staffLabel = "paid";
    }
  } catch (err) {
    result.problems.push(err.message);
  }
  result.ok = result.problems.length === 0;
  return result;
}

module.exports = { checkDatabase };
