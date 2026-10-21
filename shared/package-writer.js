"use strict";

/**
 * Streams records into an encrypted .npsync file.
 *
 *   const w = await PackageWriter.create({ filePath, websitePublicKeyPem });
 *   await w.addBatch(name, gzippedBuffer);      // safe to call from parallel producers
 *   const result = await w.finish({ headerFields, manifest, exporterPrivateKeyPem });
 *
 * Writes to "<file>.part" and renames only when complete, so a half-written file never
 * looks like a finished package.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const {
  MAGIC,
  FORMAT_VERSION,
  HEADER_RESERVED,
  PREFIX_BYTES,
  RECORD,
  frameRecord,
  fingerprint,
} = require("./package-format");
const { createPayloadKey, createPayloadCipher, signHeader, keyId } = require("./crypto");

function waitDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Package stream closed unexpectedly"));
    };
    stream.on("drain", onDrain);
    stream.on("error", onError);
    stream.on("close", onClose);
  });
}

class PackageWriter {
  constructor({ filePath, partPath, cipher, encryption, hash, done }) {
    this.filePath = filePath;
    this.partPath = partPath;
    this.cipher = cipher;
    this.encryption = encryption;
    this.hash = hash;
    this.done = done;
    this.payloadBytes = 0;
    this.queue = Promise.resolve();
    this.failed = null;
    this.closed = false;
    this.batchRecords = 0;
  }

  static async create({ filePath, websitePublicKeyPem }) {
    const partPath = `${filePath}.part`;
    const prefix = Buffer.alloc(PREFIX_BYTES + HEADER_RESERVED, 0x20);
    MAGIC.copy(prefix, 0);
    prefix.writeUInt32BE(HEADER_RESERVED, MAGIC.length);

    const out = fs.createWriteStream(partPath, { flags: "wx" });
    await new Promise((resolve, reject) => {
      out.once("open", resolve);
      out.once("error", reject);
    });
    out.write(prefix);

    const { key, iv, headerFields } = createPayloadKey(websitePublicKeyPem);
    const cipher = createPayloadCipher(key, iv);
    key.fill(0);
    const hash = crypto.createHash("sha256");

    const writer = new PackageWriter({ filePath, partPath, cipher, encryption: headerFields, hash, done: null });
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        writer.payloadBytes += chunk.length;
        cb(null, chunk);
      },
    });
    writer.done = pipeline(cipher, tap, out);
    writer.done.catch((err) => {
      writer.failed = writer.failed || err;
    });
    return writer;
  }

  _enqueue(fn) {
    const next = this.queue.then(() => {
      if (this.failed) throw this.failed;
      return fn();
    });
    // keep the chain alive after a failure so later callers see the error, not a hang
    this.queue = next.catch((err) => {
      this.failed = this.failed || err;
    });
    return next;
  }

  async _write(buf) {
    if (!this.cipher.write(buf)) await waitDrain(this.cipher);
  }

  _writeRecord(type, name, data) {
    if (this.closed) return Promise.reject(new Error("Package already finished"));
    return this._enqueue(async () => {
      for (const part of frameRecord(type, name, data)) await this._write(part);
    });
  }

  addBatch(name, buffer) {
    this.batchRecords += 1;
    return this._writeRecord(RECORD.BATCH, name, buffer);
  }

  /**
   * headerFields: { kind, exporterId, seq, baseSeq, period, databases, operator, manifestVersion, exporterVersion }
   */
  async finish({ headerFields, manifest, exporterPrivateKeyPem, exporterPublicKeyPem }) {
    await this._writeRecord(RECORD.MANIFEST, "manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
    await this._writeRecord(RECORD.END, "end", Buffer.alloc(0));
    this.closed = true;
    await this.queue;
    if (this.failed) throw this.failed;

    this.cipher.end();
    await this.done;
    const authTag = this.cipher.getAuthTag();

    const header = {
      format: FORMAT_VERSION,
      ...headerFields,
      exporterKeyId: exporterPublicKeyPem ? keyId(exporterPublicKeyPem) : undefined,
      // The public key travels with every package so the website can offer "approve this exporter".
      // It is covered by the signature; trust still comes only from a person approving the key id.
      exporterPublicKey: exporterPublicKeyPem || undefined,
      createdAt: headerFields.createdAt || new Date().toISOString(),
      payloadBytes: this.payloadBytes,
      payloadSha256: this.hash.digest("hex"),
      encryption: { ...this.encryption, authTag: authTag.toString("base64") },
    };
    if (header.exporterKeyId === undefined) delete header.exporterKeyId;
    if (header.exporterPublicKey === undefined) delete header.exporterPublicKey;
    header.signature = signHeader(header, exporterPrivateKeyPem);

    const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
    if (headerBuf.length > HEADER_RESERVED) {
      throw new Error(`Header is ${headerBuf.length} bytes; only ${HEADER_RESERVED} reserved`);
    }
    const fh = await fsp.open(this.partPath, "r+");
    try {
      await fh.write(headerBuf, 0, headerBuf.length, PREFIX_BYTES);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(this.partPath, this.filePath);

    return {
      header,
      filePath: this.filePath,
      bytes: PREFIX_BYTES + HEADER_RESERVED + this.payloadBytes,
      fingerprint: fingerprint(header.payloadSha256),
    };
  }

  /** Stop and delete the partial file. Safe to call more than once. */
  async abort() {
    this.closed = true;
    this.failed = this.failed || new Error("Export cancelled");
    this.cipher.destroy();
    try {
      await this.done;
    } catch (_) {
      /* expected */
    }
    await fsp.rm(this.partPath, { force: true });
  }
}

module.exports = { PackageWriter };
