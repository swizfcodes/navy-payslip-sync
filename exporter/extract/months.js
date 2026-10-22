"use strict";

/**
 * py_payhistory has one row per staff + pay type + year, with 12 month column groups
 * (amtthismth1..12, totamtpayable1..12, nmth1..12, bankcode1..12, bankacnumber1..12, ...).
 *
 * A month package sends only the key columns plus the month groups CLOSED since the previous
 * package: from the previous package's period up to the month before this period.
 *   - The current period is read by the payslip procedure from py_masterpayded, not py_payhistory,
 *     so its column is not needed (and is not final until month-end).
 *   - The previous package's own month was still open when it was exported; it is closed now.
 * Normally that is exactly one month group.
 */

function parsePeriod(period) {
  const m = /^(\d{4})(\d{2})$/.exec(String(period));
  if (!m) throw new Error(`Bad period "${period}" (expected YYYYMM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Bad month in period "${period}"`);
  return { year, month };
}

function periodIndex(period) {
  const { year, month } = parsePeriod(period);
  return year * 12 + (month - 1);
}

const MAX_SPAN_MONTHS = 13;

/**
 * Months to include, grouped by year: [{ year, months: [..] }].
 * fromPeriod null -> only `toPeriod`.
 */
function monthsBetween(fromPeriod, toPeriod) {
  const to = periodIndex(toPeriod);
  const from = fromPeriod ? periodIndex(fromPeriod) : to;
  if (from > to) {
    throw new Error(`Period ${toPeriod} is earlier than the previous package (${fromPeriod})`);
  }
  if (to - from + 1 > MAX_SPAN_MONTHS) {
    throw new Error(
      `The previous package was ${to - from} months ago. Export a full package instead of a month package.`,
    );
  }
  const byYear = new Map();
  for (let i = from; i <= to; i += 1) {
    const year = Math.floor(i / 12);
    const month = (i % 12) + 1;
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(month);
  }
  return [...byYear.entries()].map(([year, months]) => ({ year, months }));
}

/**
 * Find the month column groups in a py_payhistory column list.
 * A base name counts as a group only if it appears with every month 1..12.
 * Returns { bases: [...], columnsFor(months) -> [actual column names] }.
 */
function monthGroups(columnNames) {
  const found = new Map(); // base(lower) -> Map(month -> actual name)
  for (const name of columnNames) {
    const m = /^([A-Za-z_]+?)(\d{1,2})$/.exec(name);
    if (!m) continue;
    const month = Number(m[2]);
    if (month < 1 || month > 12) continue;
    const base = m[1].toLowerCase();
    if (!found.has(base)) found.set(base, new Map());
    found.get(base).set(month, name);
  }
  const groups = [...found.entries()].filter(([, months]) => months.size === 12);
  if (!groups.length) {
    throw new Error("py_payhistory: no month column groups found (expected e.g. amtthismth1..amtthismth12)");
  }
  return {
    bases: groups.map(([base]) => base),
    columnsFor(months) {
      const out = [];
      for (const month of months) for (const [, byMonth] of groups) out.push(byMonth.get(month));
      return out;
    },
  };
}

function formatPeriod(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}${String(month).padStart(2, "0")}`;
}

function previousPeriod(period) {
  return formatPeriod(periodIndex(period) - 1);
}

/**
 * Closed months to send in a month package, grouped by year: [{ year, months }], possibly [].
 *   prevPeriod: period of the previous package (null if none: then only the month before `period`)
 */
function closedMonthsSince(prevPeriod, period) {
  const last = previousPeriod(period);
  if (prevPeriod && periodIndex(prevPeriod) > periodIndex(period)) {
    throw new Error(`Period ${period} is earlier than the previous package (${prevPeriod})`);
  }
  const from = prevPeriod || last;
  if (periodIndex(from) > periodIndex(last)) return []; // same period exported again
  return monthsBetween(from, last);
}

module.exports = {
  parsePeriod,
  periodIndex,
  previousPeriod,
  monthsBetween,
  closedMonthsSince,
  monthGroups,
  MAX_SPAN_MONTHS,
};
