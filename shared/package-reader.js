"use strict";

/**
 * Website side: check and read an .npsync file.
 *
 *   const { header } = await readHeader(file);                       // plain, no keys needed
 *   const exporterKey = lookUpExporter(header.exporterId);            // from sync_exporters
 *   await verifyPackage(file, { exporterPublicKeyPem: exporterKey });  // signature + payload hash
 *   for await (const rec of readRecords(file, { websitePrivateKeyPem, header })) {
 *     if (rec.type === "batch") ... rec.batch (decoded, checksum verified)
 *     if (rec.type === "manifest") ... rec.manifest (comes after all batches)
 *   }
 *
 * Always call verifyPackage before readRecords: it proves who made the file and that no byte
 * changed, before anything is decrypted or loaded.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const {
  PAYLOAD_OFFSET,
  RECORD,
  PackageError,
  parseHeaderBuffer,
  validateHeaderShape,
} = require("./package-format");
const { verifyHeaderSignature, recoverPayloadKey, createPayloadDecipher } = require("./crypto");
const { decodeBatch } = require("./batch-format");

async function readHeader(filePath) {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(PAYLOAD_OFFSET);
    const { bytesRead } = await fh.read(buf, 0, PAYLOAD_OFFSET, 0);
    const { header, payloadOffset } = parseHeaderBuffer(buf.subarray(0, bytesRead));
    validateHeaderShape(header);
    return { header, payloadOffset };
  } finally {
    await fh.close();
  }
}

async function hashRegion(filePath, start) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath, { start, highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function verifyPackage(filePath, { exporterPublicKeyPem }) {
  const { header, payloadOffset } = await readHeader(filePath);
  if (!exporterPublicKeyPem) {
    throw new PackageError("unknown-exporter", `Exporter "${header.exporterId}" is not registered`);
  }
  if (!verifyHeaderSignature(header, exporterPublicKeyPem)) {
    throw new PackageError("bad-signature", "Signature does not match: the file was changed or not made by this exporter");
  }
  const { size } = await fsp.stat(filePath);
  if (size - payloadOffset !== header.payloadBytes) {
    throw new PackageError("truncated", `Payload is ${size - payloadOffset} bytes, header says ${header.payloadBytes}`);
  }
  const { sha256 } = await hashRegion(filePath, payloadOffset);
  if (sha256 !== header.payloadSha256) {
    throw new PackageError("payload-hash-mismatch", "File contents do not match the signed fingerprint");
  }
  return { header, payloadOffset };
}

/** Incremental parser for the decrypted record stream. */
class RecordParser {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  _peek(n) {
    if (this.chunks.length > 1) {
      this.chunks = [Buffer.concat(this.chunks, this.length)];
    }
    return this.chunks[0].subarray(0, n);
  }

  _take(n) {
    const all = this.chunks.length > 1 ? Buffer.concat(this.chunks, this.length) : this.chunks[0];
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  /** Returns { type, name, data } or null if more bytes are needed. */
  next() {
    if (this.length < 5) return null;
    const head = this._peek(5);
    const nameLen = head.readUInt32BE(1);
    if (this.length < 5 + nameLen + 4) return null;
    const dataLen = this._peek(5 + nameLen + 4).readUInt32BE(5 + nameLen);
    const total = 5 + nameLen + 4 + dataLen;
    if (this.length < total) return null;
    const rec = this._take(total);
    return {
      type: rec.readUInt8(0),
      name: rec.subarray(5, 5 + nameLen).toString("utf8"),
      data: rec.subarray(5 + nameLen + 4),
    };
  }
}

async function* readRecords(filePath, { websitePrivateKeyPem, header, payloadOffset = PAYLOAD_OFFSET }) {
  let key;
  let iv;
  let authTag;
  try {
    ({ key, iv, authTag } = recoverPayloadKey(header.encryption, websitePrivateKeyPem));
  } catch (e) {
    throw new PackageError("decrypt-failed", e.message);
  }
  const decipher = createPayloadDecipher(key, iv, authTag);
  key.fill(0);
  const src = fs.createReadStream(filePath, { start: payloadOffset, highWaterMark: 1024 * 1024 });
  src.on("error", (err) => decipher.destroy(err));
  src.pipe(decipher);

  const parser = new RecordParser();
  let sawEnd = false;
  try {
    for await (const chunk of decipher) {
      parser.push(chunk);
      let rec;
      while ((rec = parser.next())) {
        if (sawEnd) throw new PackageError("bad-record", "Data after the end record");
        if (rec.type === RECORD.BATCH) {
          yield { type: "batch", name: rec.name, batch: await decodeBatch(rec.data), bytes: rec.data.length };
        } else if (rec.type === RECORD.MANIFEST) {
          yield { type: "manifest", manifest: JSON.parse(rec.data.toString("utf8")) };
        } else if (rec.type === RECORD.END) {
          sawEnd = true;
        } else {
          throw new PackageError("bad-record", `Unknown record type ${rec.type}`);
        }
      }
    }
  } catch (err) {
    src.destroy();
    if (err instanceof PackageError) throw err;
    if (/unable to authenticate|auth/i.test(err.message)) {
      throw new PackageError("decrypt-failed", "Payload failed authentication");
    }
    throw err;
  }
  if (!sawEnd || parser.length !== 0) throw new PackageError("missing-end", "Package ended without its end record");
}

module.exports = { readHeader, verifyPackage, readRecords };
