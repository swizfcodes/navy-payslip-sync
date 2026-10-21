"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const sync = require("../shared");

const { generateWebsiteKeyPair, generateExporterKeyPair } = sync.crypto;
const { PackageWriter } = sync.writer;
const { verifyPackage, readRecords, readHeader } = sync.reader;
const { encodeBatch, batchRecordName } = sync.batch;
const { PAYLOAD_OFFSET, checkSequence, fingerprint } = sync.format;

const web = generateWebsiteKeyPair();
const exp = generateExporterKeyPair();

const HEADER_FIELDS = {
  kind: "month",
  exporterId: "test-exporter",
  seq: 2,
  baseSeq: 1,
  period: "202610",
  databases: ["ratings", "officers"],
  operator: "Tester",
  manifestVersion: 1,
  exporterVersion: "0.1.0",
};

async function makePackage(dir, { batches = 3 } = {}) {
  const filePath = path.join(dir, `p-${Math.random().toString(16).slice(2)}.npsync`);
  const w = await PackageWriter.create({ filePath, websitePublicKeyPem: web.publicKeyPem });
  const jobs = [];
  for (let i = 1; i <= batches; i += 1) {
    jobs.push(
      (async () => {
        const db = i % 2 ? "ratings" : "officers";
        const enc = await encodeBatch({
          database: db,
          table: "py_ipis_payhistory",
          mode: "replace-scope",
          scope: { period: "202610" },
          batchNo: i,
          columns: ["numb", "period", "bpm"],
          types: ["string", "string", "decimal"],
          rows: [
            [`NN${i}01`, "202610", "250000.0000"],
            [`NN${i}02`, "202610", null],
          ],
        });
        await w.addBatch(batchRecordName(db, "py_ipis_payhistory", { period: "202610" }, i), enc.buffer);
      })(),
    );
  }
  await Promise.all(jobs); // parallel producers into one writer
  const result = await w.finish({
    headerFields: HEADER_FIELDS,
    manifest: { hello: "world", batches },
    exporterPrivateKeyPem: exp.privateKeyPem,
    exporterPublicKeyPem: exp.publicKeyPem,
  });
  return { filePath, result };
}

async function readAll(filePath, websitePrivateKeyPem = web.privateKeyPem) {
  const { header, payloadOffset } = await readHeader(filePath);
  const out = [];
  for await (const rec of readRecords(filePath, { websitePrivateKeyPem, header, payloadOffset })) out.push(rec);
  return out;
}

test("write, verify and read back a package", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "npsync-"));
  const { filePath, result } = await makePackage(dir, { batches: 5 });

  assert.equal(result.fingerprint, fingerprint(result.header.payloadSha256));
  assert.match(result.fingerprint, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  const { size } = await fsp.stat(filePath);
  assert.equal(size, result.bytes);
  assert.equal(size, PAYLOAD_OFFSET + result.header.payloadBytes);

  const { header } = await verifyPackage(filePath, { exporterPublicKeyPem: exp.publicKeyPem });
  assert.equal(header.seq, 2);
  assert.equal(header.baseSeq, 1);
  assert.equal(header.exporterId, "test-exporter");

  const recs = await readAll(filePath);
  const batches = recs.filter((r) => r.type === "batch");
  assert.equal(batches.length, 5);
  for (const b of batches) {
    assert.deepEqual(b.batch.columns, ["numb", "period", "bpm"]);
    assert.equal(b.batch.rows.length, 2);
    assert.equal(b.batch.rows[1][2], null);
  }
  assert.equal(recs.at(-1).type, "manifest");
  assert.deepEqual(recs.at(-1).manifest, { hello: "world", batches: 5 });
  await fsp.rm(dir, { recursive: true, force: true });
});

test("a changed byte is refused", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "npsync-"));
  const { filePath } = await makePackage(dir);
  const fh = await fsp.open(filePath, "r+");
  const b = Buffer.alloc(1);
  await fh.read(b, 0, 1, PAYLOAD_OFFSET + 10);
  b[0] ^= 0xff;
  await fh.write(b, 0, 1, PAYLOAD_OFFSET + 10);
  await fh.close();
  await assert.rejects(verifyPackage(filePath, { exporterPublicKeyPem: exp.publicKeyPem }), {
    code: "payload-hash-mismatch",
  });
  await fsp.rm(dir, { recursive: true, force: true });
});

test("another exporter's key is refused", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "npsync-"));
  const { filePath } = await makePackage(dir);
  const other = generateExporterKeyPair();
  await assert.rejects(verifyPackage(filePath, { exporterPublicKeyPem: other.publicKeyPem }), { code: "bad-signature" });
  await assert.rejects(verifyPackage(filePath, { exporterPublicKeyPem: null }), { code: "unknown-exporter" });
  await fsp.rm(dir, { recursive: true, force: true });
});

test("a header edit breaks the signature", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "npsync-"));
  const { filePath } = await makePackage(dir);
  const { header } = await readHeader(filePath);
  const edited = Buffer.from(JSON.stringify({ ...header, seq: 99 }), "utf8");
  const fh = await fsp.open(filePath, "r+");
  await fh.write(Buffer.alloc(16384, 0x20), 0, 16384, 12);
  await fh.write(edited, 0, edited.length, 12);
  await fh.close();
  await assert.rejects(verifyPackage(filePath, { exporterPublicKeyPem: exp.publicKeyPem }), { code: "bad-signature" });
  await fsp.rm(dir, { recursive: true, force: true });
});

test("only the website private key can open the payload", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "npsync-"));
  const { filePath } = await makePackage(dir);
  const otherWebsite = generateWebsiteKeyPair();
  await assert.rejects(readAll(filePath, otherWebsite.privateKeyPem), { code: "decrypt-failed" });
  await fsp.rm(dir, { recursive: true, force: true });
});

test("abort removes the partial file", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "npsync-"));
  const filePath = path.join(dir, "x.npsync");
  const w = await PackageWriter.create({ filePath, websitePublicKeyPem: web.publicKeyPem });
  await w.addBatch("batches/a/b/00001.json.gz", Buffer.from("x"));
  await w.abort();
  const files = await fsp.readdir(dir);
  assert.deepEqual(files, []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test("sequence rules", () => {
  const h = (o) => ({ kind: "month", seq: 5, baseSeq: 4, ...o });
  assert.equal(checkSequence(h(), 4).ok, true);
  assert.equal(checkSequence(h(), 3).code, "sequence-gap");
  assert.equal(checkSequence(h(), 5).code, "sequence-old");
  assert.equal(checkSequence(h(), null).code, "sequence-gap");
  assert.equal(checkSequence(h({ kind: "full", baseSeq: 1 }), null).ok, true);
  assert.equal(checkSequence(h({ kind: "full", baseSeq: 1 }), 3).ok, true);
  assert.equal(checkSequence(h({ kind: "dryrun", seq: 0 }), 4).code, "not-applicable");
});
