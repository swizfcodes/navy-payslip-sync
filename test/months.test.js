"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { monthsBetween, monthGroups } = require("../exporter/extract/months");

test("months from the previous package to this one, grouped by year", () => {
  assert.deepEqual(monthsBetween("202609", "202610"), [{ year: 2026, months: [9, 10] }]);
  assert.deepEqual(monthsBetween("202610", "202610"), [{ year: 2026, months: [10] }]);
  assert.deepEqual(monthsBetween(null, "202610"), [{ year: 2026, months: [10] }]);
  assert.deepEqual(monthsBetween("202611", "202602".replace("2026", "2027")), [
    { year: 2026, months: [11, 12] },
    { year: 2027, months: [1, 2] },
  ]);
});

test("refuses going backwards or a gap over a year", () => {
  assert.throws(() => monthsBetween("202611", "202610"), /earlier/);
  assert.throws(() => monthsBetween("202501", "202610"), /full package/);
});

test("finds the 12-month column groups and ignores other columns", () => {
  const cols = ["his_empno", "his_year", "his_type", "created_by"];
  for (let m = 1; m <= 12; m += 1) cols.push(`amtthismth${m}`, `totamtpayable${m}`, `NMTH${m}`);
  cols.push("extra1", "extra2"); // only two months: not a group
  const g = monthGroups(cols);
  assert.deepEqual(g.bases.sort(), ["amtthismth", "nmth", "totamtpayable"]);
  assert.deepEqual(g.columnsFor([10]).sort(), ["NMTH10", "amtthismth10", "totamtpayable10"].sort());
  assert.equal(g.columnsFor([9, 10]).length, 6);
});

test("no month groups is an error", () => {
  assert.throws(() => monthGroups(["his_empno", "his_year"]), /no month column groups/);
});
