"use strict";

/**
 * One batch = up to N rows of one table (one scope).
 *
 * Version 2 (written since 0.1.3): "NPB2" + brotli(JSON), the rows stored column by column:
 *
 * {
 *   "v": 2,
 *   "database": "ratings",
 *   "table": "py_ipis_payhistory",
 *   "mode": "replace-scope",
 *   "scope": { "period": "202610" },          // null when the whole table is sent
 *   "batchNo": 3,                              // 1-based, per database + table + scope
 *   "columns": ["numb", "period", ...],
 *   "types":   ["string", "string", ...],      // logical types, see type-map.js
 *   "rowCount": 20000,
 *   "cols":    [["NN1234", "NN1235", ...], ["202610", "202610", ...], ...],
 *   "checksum": "sha256:<hex of JSON.stringify([columns, rows])>"
 * }
 *
 * Why column by column: payroll tables repeat themselves down a column (the same element
 * code, the same year, "0.0000" again and again) and across neighbouring columns (this
 * month's amount is usually last month's). Laid out by column, with brotli's 16 MB window,
 * both kinds of repetition become long matches. Row-by-row gzip (version 1) only looked
 * 32 KB back.
 *
 * Version 1 (0.1.0 - 0.1.2): gzip(JSON) with "rows": [[...], ...]. Still read.
 *
 * decodeBatch() always returns rows (row by row), whatever the version, and checks the
 * checksum, which is over the rows and does not depend on the encoding.
 * The number of batches per table is in the package manifest (written at the end).
 */

const zlib = require("zlib");
const { promisify } = require("util");
const { sha256Hex } = require("./crypto");

const gunzip = promisify(zlib.gunzip);
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

const BATCH_VERSION = 2;
const MAGIC_V2 = Buffer.from("NPB2", "ascii");
const GZIP_MAGIC = [0x1f, 0x8b];

/** Brotli quality 1-11. 9 is close to the best size at a speed the export can afford. */
const DEFAULT_QUALITY = 9;

function batchChecksum(columns, rows) {
  return "sha256:" + sha256Hex(Buffer.from(JSON.stringify([columns, rows]), "utf8"));
}

function rowsToColumns(width, rows) {
  const cols = new Array(width);
  for (let c = 0; c < width; c += 1) cols[c] = new Array(rows.length);
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    for (let c = 0; c < width; c += 1) {
      const v = row[c];
      cols[c][r] = v === undefined ? null : v;
    }
  }
  return cols;
}

function columnsToRows(cols, rowCount) {
  const width = cols.length;
  const rows = new Array(rowCount);
  for (let r = 0; r < rowCount; r += 1) {
    const row = new Array(width);
    for (let c = 0; c < width; c += 1) row[c] = cols[c][r];
    rows[r] = row;
  }
  return rows;
}

async function encodeBatch({ database, table, mode, scope = null, batchNo, columns, types, rows, quality = DEFAULT_QUALITY }) {
  if (!Array.isArray(columns) || !Array.isArray(types) || columns.length !== types.length) {
    throw new Error(`Batch ${database}.${table} #${batchNo}: columns and types must be arrays of equal length`);
  }
  for (let r = 0; r < rows.length; r += 1) {
    if (!Array.isArray(rows[r]) || rows[r].length !== columns.length) {
      throw new Error(`Batch ${database}.${table} #${batchNo}: row ${r + 1} has ${rows[r] && rows[r].length} values, expected ${columns.length}`);
    }
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
    rowCount: rows.length,
    cols: rowsToColumns(columns.length, rows),
    checksum,
  });
  const raw = Buffer.from(json, "utf8");
  const q = Number.isInteger(quality) && quality >= 1 && quality <= 11 ? quality : DEFAULT_QUALITY;
  const packed = await brotliCompress(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: q,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24, // 16 MB: a whole batch fits in the window
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  const buffer = Buffer.concat([MAGIC_V2, packed]);
  return { buffer, checksum, rowCount: rows.length, rawBytes: raw.length };
}

async function decodeBatch(buffer) {
  let batch;
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(MAGIC_V2)) {
    const raw = await brotliDecompress(buffer.subarray(4));
    batch = JSON.parse(raw.toString("utf8"));
    if (batch.v !== 2) throw new Error(`Unsupported batch version ${batch.v}`);
    if (!Array.isArray(batch.cols) || batch.cols.length !== (batch.columns || []).length) {
      throw new Error(`Checksum mismatch in ${batch.database}.${batch.table} batch #${batch.batchNo} (column count)`);
    }
    for (const col of batch.cols) {
      if (!Array.isArray(col) || col.length !== batch.rowCount) {
        throw new Error(`Checksum mismatch in ${batch.database}.${batch.table} batch #${batch.batchNo} (row count)`);
      }
    }
    batch.rows = columnsToRows(batch.cols, batch.rowCount);
    delete batch.cols;
  } else if (buffer.length >= 2 && buffer[0] === GZIP_MAGIC[0] && buffer[1] === GZIP_MAGIC[1]) {
    const raw = await gunzip(buffer);
    batch = JSON.parse(raw.toString("utf8"));
    if (batch.v !== 1) throw new Error(`Unsupported batch version ${batch.v}`);
  } else {
    throw new Error("Unsupported batch version (unknown encoding)");
  }
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
  return `batches/${database}/${table}${scopePart}/${String(batchNo).padStart(5, "0")}.npb`;
}

/** Table-level checksum: sha256 over the batch checksums in order. */
function tableChecksum(batchChecksums) {
  return "sha256:" + sha256Hex(Buffer.from(batchChecksums.join("\n"), "utf8"));
}

module.exports = {
  BATCH_VERSION,
  DEFAULT_QUALITY,
  encodeBatch,
  decodeBatch,
  batchChecksum,
  batchRecordName,
  tableChecksum,
};
