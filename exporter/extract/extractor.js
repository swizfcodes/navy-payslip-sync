"use strict";

/**
 * Reads one database according to the manifest and hands encoded batches to the package writer.
 */

const { tablesFor } = require("../../shared/manifest");
const { encodeBatch, batchRecordName, tableChecksum } = require("../../shared/batch-format");
const { toWire } = require("../../shared/type-map");
const { monthGroups } = require("./months");

function byLowerName(columns) {
  return new Map(columns.map((c) => [c.name.toLowerCase(), c]));
}

/** Resolve wanted column names against the source, case-insensitively. Throws listing what is missing. */
function resolveColumns(sourceCols, wanted, context) {
  const map = byLowerName(sourceCols);
  const missing = [];
  const out = [];
  for (const w of wanted) {
    const c = map.get(String(w).toLowerCase());
    if (c) out.push(c);
    else missing.push(w);
  }
  if (missing.length) throw new Error(`${context}: column(s) not found: ${missing.join(", ")}`);
  return out;
}

/**
 * Work out what to read for one table: a list of "parts", one per scope.
 * part = { scope: {col: value} | null, columns: [col], where: {col: value}, orderBy: [names] }
 */
function planTable(table, sourceCols, { period, payhistoryMonths, ctx }) {
  let keyCols = [];
  try {
    keyCols = resolveColumns(sourceCols, table.key, `${ctx} key`);
  } catch (e) {
    if (table.mode !== "swap") throw e; // a missing key only costs sort order for swap tables
  }
  const orderBy = keyCols.map((c) => c.name);

  if (table.mode === "merge-columns" && table.columnSet === "month-groups") {
    const groups = monthGroups(sourceCols.map((c) => c.name));
    const [scopeCol] = resolveColumns(sourceCols, [table.scope], `${ctx} scope`);
    return payhistoryMonths.map(({ year, months }) => {
      const names = [...keyCols.map((c) => c.name), ...groups.columnsFor(months)];
      return {
        scope: { [table.scope]: String(year) },
        columns: resolveColumns(sourceCols, names, ctx),
        where: { [scopeCol.name]: String(year) },
        orderBy,
        months,
      };
    });
  }

  const columns = table.columns === "*" ? sourceCols : resolveColumns(sourceCols, table.columns, ctx);
  if (table.mode === "merge-columns") {
    // key must be among the columns sent
    for (const k of keyCols) {
      if (!columns.find((c) => c.name === k.name)) throw new Error(`${ctx}: key column ${k.name} not in column list`);
    }
  }

  if (table.mode === "replace-scope") {
    const [scopeCol] = resolveColumns(sourceCols, [table.scope], `${ctx} scope`);
    return [{ scope: { [table.scope]: period }, columns, where: { [scopeCol.name]: period }, orderBy }];
  }
  return [{ scope: null, columns, where: {}, orderBy }];
}

/**
 * Extract one database.
 *   source:       MssqlSource (connected)
 *   db:           { website, source }
 *   kind:         month | full  (a dry run passes the kind it imitates)
 *   period:       "YYYYMM" (current BT05)
 *   payhistoryMonths: [{ year, months }] for month/dryrun packages
 *   batchRows:    rows per batch
 *   addBatch:     async (recordName, buffer) => void   (package writer)
 *   onEvent:      (event) => void                     (progress)
 *   isCancelled:  () => boolean
 * Returns the per-database part of the package manifest.
 */
async function extractDatabase({ source, db, kind, period, payhistoryMonths, batchRows, addBatch, onEvent, isCancelled }) {
  const started = Date.now();
  const tables = [];
  const { month } = { month: Number(String(period).slice(4, 6)) };

  for (const table of tablesFor(db.website, kind)) {
    if (isCancelled()) throw new Error("Cancelled");
    const ctx = `${db.source}.dbo.${table.name}`;
    const sourceCols = await source.columns(db.source, table.name);
    if (!sourceCols.length) throw new Error(`${ctx}: table not found`);

    const parts = planTable(table, sourceCols, { period, payhistoryMonths, ctx });
    // Ask SQL Server for key order only if an index gives it for free; a full sort of a big
    // table costs minutes and the website does not need the order.
    if (parts.length && parts[0].orderBy.length) {
      let indexed = false;
      try {
        indexed = await source.hasLeadingIndex(db.source, table.name, parts[0].orderBy[0]);
      } catch (_) {
        indexed = false;
      }
      if (!indexed) for (const p of parts) p.orderBy = [];
    }
    if (!parts.length) {
      onEvent({ type: "table-skipped", database: db.website, table: table.name, reason: "nothing to send" });
    }
    for (const part of parts) {
      const t0 = Date.now();
      onEvent({ type: "table-start", database: db.website, table: table.name, scope: part.scope });

      const columns = part.columns.map((c) => c.name);
      const types = part.columns.map((c) => c.logical);
      const checksums = [];
      let batchNo = 0;
      let rowCount = 0;
      let rawBytes = 0;
      let packedBytes = 0;
      let rows = [];

      const flush = async () => {
        if (!rows.length) return;
        batchNo += 1;
        const enc = await encodeBatch({
          database: db.website,
          table: table.name,
          mode: table.mode,
          scope: part.scope,
          batchNo,
          columns,
          types,
          rows,
        });
        checksums.push(enc.checksum);
        rawBytes += enc.rawBytes;
        packedBytes += enc.buffer.length;
        await addBatch(batchRecordName(db.website, table.name, part.scope, batchNo), enc.buffer);
        rows = [];
        onEvent({ type: "table-progress", database: db.website, table: table.name, rows: rowCount });
      };

      const stream = source.streamRows(db.source, table.name, {
        columns: part.columns,
        orderBy: part.orderBy,
        where: part.where,
      });
      try {
        for await (const row of stream) {
          const wire = new Array(part.columns.length);
          for (let i = 0; i < part.columns.length; i += 1) {
            wire[i] = toWire(row[part.columns[i].name], part.columns[i].logical);
          }
          rows.push(wire);
          rowCount += 1;
          if (rows.length >= batchRows) {
            await flush();
            if (isCancelled()) throw new Error("Cancelled");
          }
        }
        await flush();
      } finally {
        stream.destroy();
      }

      const ms = Date.now() - t0;
      tables.push({
        table: table.name,
        mode: table.mode,
        applyAt: table.applyAt,
        rollback: table.rollback,
        key: table.key,
        scope: part.scope,
        months: part.months,
        columns,
        types,
        rows: rowCount,
        batches: batchNo,
        checksum: tableChecksum(checksums),
        rawBytes,
        packedBytes,
        ms,
      });
      onEvent({ type: "table-done", database: db.website, table: table.name, scope: part.scope, rows: rowCount, ms, packedBytes });
    }
  }

  const totals = await source.totals(db.source, month);
  return {
    sourceDatabase: db.source,
    totals,
    tables,
    ms: Date.now() - started,
  };
}

module.exports = { extractDatabase, planTable, resolveColumns };
