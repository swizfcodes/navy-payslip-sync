"use strict";

/**
 * Connect-step checks, per database: reachable, staff count, current period (BT05),
 * every manifest table present, and the hr_employees payroll columns present.
 */

const { tablesFor, HR_EMPLOYEES_PAYROLL_COLUMNS } = require("../shared/manifest");

async function checkDatabase(source, db) {
  const result = { website: db.website, source: db.source, ok: false, staff: null, period: null, problems: [] };
  try {
    result.period = await source.currentPeriod(db.source);
    if (!result.period) result.problems.push("py_stdrate has no valid BT05 row");

    for (const table of tablesFor(db.website, "full")) {
      const cols = await source.columns(db.source, table.name);
      if (!cols.length) {
        result.problems.push(`table ${table.name} not found`);
        continue;
      }
      if (table.name === "hr_employees") {
        const have = new Set(cols.map((c) => c.name.toLowerCase()));
        const missing = HR_EMPLOYEES_PAYROLL_COLUMNS.filter((c) => !have.has(c.toLowerCase()));
        if (missing.length) result.problems.push(`hr_employees missing column(s): ${missing.join(", ")}`);
      }
    }
    if (!result.problems.some((p) => p.includes("hr_employees not found"))) {
      result.staff = await source.countRows(db.source, "hr_employees");
    }
  } catch (err) {
    result.problems.push(err.message);
  }
  result.ok = result.problems.length === 0;
  return result;
}

module.exports = { checkDatabase };
