"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { encodeBatch, decodeBatch, batchChecksum, BATCH_VERSION } = require("../shared/batch-format");

const columns = ["his_empno", "his_type", "his_year", "amt1", "amt2", "note"];
const types = ["string", "string", "int", "decimal", "decimal", "string"];
function sampleRows(n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const amt = i % 7 ? "125000.0000" : "0.0000";
    rows.push([`NN${String(1000 + (i >> 4)).padStart(6, "0")}`, `PT${200 + (i % 16)}`, 2026, amt, amt, i % 50 ? null : "é ✓ \"q\""]);
  }
  return rows;
}
const meta = { database: "ratings", table: "py_payhistory", mode: "swap", scope: null, batchNo: 4, columns, types };

test("version 2 batches round-trip row by row with the same checksum", async () => {
  const rows = sampleRows(3000);
  const enc = await encodeBatch({ ...meta, rows });
  assert.equal(BATCH_VERSION, 2);
  assert.equal(enc.buffer.subarray(0, 4).toString("ascii"), "NPB2");
  assert.equal(enc.checksum, batchChecksum(columns, rows));
  const b = await decodeBatch(enc.buffer);
  assert.deepEqual(b.rows, rows);
  assert.deepEqual(b.columns, columns);
  assert.deepEqual(b.types, types);
  assert.equal(b.batchNo, 4);
  assert.equal(b.cols, undefined);
});

test("version 2 is much smaller than version 1 gzip for repetitive payroll rows", async () => {
  const rows = sampleRows(10000);
  const enc = await encodeBatch({ ...meta, rows });
  const v1 = zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, ...meta, rows, checksum: enc.checksum })), { level: 6 });
  assert.ok(enc.buffer.length < v1.length * 0.7, `v2 ${enc.buffer.length} bytes, v1 ${v1.length} bytes`);
});

test("version 1 (gzip) batches from older exporters are still read", async () => {
  const rows = sampleRows(10);
  const v1 = zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, ...meta, rows, checksum: batchChecksum(columns, rows) })));
  const b = await decodeBatch(v1);
  assert.deepEqual(b.rows, rows);
});

test("a changed value fails the checksum; unknown encodings are refused", async () => {
  const rows = sampleRows(10);
  const enc = await encodeBatch({ ...meta, rows });
  const inner = JSON.parse(zlib.brotliDecompressSync(enc.buffer.subarray(4)).toString("utf8"));
  inner.cols[3][2] = "999.0000";
  const forged = Buffer.concat([Buffer.from("NPB2"), zlib.brotliCompressSync(Buffer.from(JSON.stringify(inner)))]);
  await assert.rejects(decodeBatch(forged), /Checksum mismatch/);
  await assert.rejects(decodeBatch(Buffer.from("hello")), /Unsupported batch version/);
});

test("rows with the wrong number of values are refused when encoding", async () => {
  await assert.rejects(encodeBatch({ ...meta, rows: [["only one"]] }), /expected 6/);
});
