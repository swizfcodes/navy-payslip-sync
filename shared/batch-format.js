"use strict";

/**
 * One batch = up to N rows of one table (one scope), gzipped JSON:
 *
 * {
 *   "v": 1,
 *   "database": "ratings",
 *   "table": "py_ipis_payhistory",
 *   "mode": "replace-scope",
 *   "scope": { "period": "202610" },          // null when the whole table is sent
 *   "batchNo": 3,                              // 1-based, per database + table + scope
 *   "columns": ["numb", "period", ...],
 *   "types":   ["string", "string", ...],      // logical types, see type-map.js
 *   "rows":    [["NN1234", "202610", ...], ...],
 *   "checksum": "sha256:<hex of JSON.stringify([columns, rows])>"
 * }
 *
 * The number of batches per table is in the package manifest (written at the end).
 */

const zlib = require("zlib");
const { promisify } = require("util");
const { sha256Hex } = require("./crypto");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const BATCH_VERSION = 1;

function batchChecksum(columns, rows) {
  return "sha256:" + sha256Hex(Buffer.from(JSON.stringify([columns, rows]), "utf8"));
}

async function encodeBatch({ database, table, mode, scope = null, batchNo, columns, types, rows }) {
  if (!Array.isArray(columns) || !Array.isArray(types) || columns.length !== types.length) {
    throw new Error(`Batch ${database}.${table} #${batchNo}: columns and types must be arrays of equal length`);
  }
  const checksum = batchChecksum(columns, rows);
  const json = JSON.stringify({
    v: BATCH_VERSION,
    database,
    table,
    mode,
    scope,
    batchNo,
    columns,
    types,
    rows,
    checksum,
  });
  const raw = Buffer.from(json, "utf8");
  const buffer = await gzip(raw, { level: 6 });
  return { buffer, checksum, rowCount: rows.length, rawBytes: raw.length };
}

async function decodeBatch(buffer) {
  const raw = await gunzip(buffer);
  const batch = JSON.parse(raw.toString("utf8"));
  if (batch.v !== BATCH_VERSION) throw new Error(`Unsupported batch version ${batch.v}`);
  const expected = batchChecksum(batch.columns, batch.rows);
  if (expected !== batch.checksum) {
    throw new Error(`Checksum mismatch in ${batch.database}.${batch.table} batch #${batch.batchNo}`);
  }
  return batch;
}

/** Name of a batch record inside the package. */
function batchRecordName(database, table, scope, batchNo) {
  const scopePart = scope
    ? "/" +
      Object.entries(scope)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")
    : "";
  return `batches/${database}/${table}${scopePart}/${String(batchNo).padStart(5, "0")}.json.gz`;
}

/** Table-level checksum: sha256 over the batch checksums in order. */
function tableChecksum(batchChecksums) {
  return "sha256:" + sha256Hex(Buffer.from(batchChecksums.join("\n"), "utf8"));
}

module.exports = { BATCH_VERSION, encodeBatch, decodeBatch, batchChecksum, batchRecordName, tableChecksum };
