"use strict";

/**
 * .npsync file layout
 *
 *   offset 0       8 bytes   magic "NPSYNC01"
 *   offset 8       4 bytes   header length L (uint32 big-endian, currently always 16384)
 *   offset 12      L bytes   header JSON, padded with spaces (readable without decrypting)
 *   offset 12+L    ...       encrypted payload (AES-256-GCM), exactly header.payloadBytes long
 *
 * The header is written last (into the reserved space) because it carries the payload hash,
 * the GCM tag and the signature.
 *
 * Decrypted payload = a sequence of records:
 *   uint8  type        1 = batch, 2 = manifest, 255 = end
 *   uint32 nameLength  (big-endian)
 *   bytes  name        utf8, e.g. "batches/ratings/py_ipis_payhistory/period=202610/00003.json.gz"
 *   uint32 dataLength  (big-endian)
 *   bytes  data        batch: gzipped batch JSON (batch-format.js); manifest: JSON
 *
 * Order: all batch records (databases interleaved), then the manifest, then the end record.
 *
 * Header (example):
 * {
 *   "format": 1, "kind": "month", "exporterId": "navy-payroll-office-01", "exporterKeyId": "…",
 *   "seq": 42, "baseSeq": 41, "period": "202610",
 *   "databases": ["officers", …], "createdAt": "2026-10-28T10:14:03.512Z", "operator": "…",
 *   "manifestVersion": 1, "exporterVersion": "0.1.0",
 *   "payloadBytes": 77123456, "payloadSha256": "<hex>",
 *   "encryption": { "alg": "AES-256-GCM", "kdf": "X25519-HKDF-SHA256", "ephemeralPublicKey": "<b64>",
 *                   "websiteKeyId": "…", "iv": "<b64>", "authTag": "<b64>" },
 *   "signature": "ed25519:<b64 over canonical header without signature>"
 * }
 */

const MAGIC = Buffer.from("NPSYNC01", "ascii");
const FORMAT_VERSION = 1;
const HEADER_RESERVED = 16384;
const PREFIX_BYTES = MAGIC.length + 4; // magic + header length
const PAYLOAD_OFFSET = PREFIX_BYTES + HEADER_RESERVED;

const RECORD = { BATCH: 1, MANIFEST: 2, END: 255 };

class PackageError extends Error {
  /**
   * codes: bad-magic, bad-header, header-too-large, bad-signature, unknown-exporter, truncated,
   *        payload-hash-mismatch, decrypt-failed, bad-record, missing-end, sequence-gap,
   *        sequence-old, not-applicable
   */
  constructor(code, message) {
    super(message);
    this.name = "PackageError";
    this.code = code;
  }
}

function frameRecord(type, name, data) {
  const nameBuf = Buffer.from(name, "utf8");
  const head = Buffer.alloc(1 + 4 + nameBuf.length + 4);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(nameBuf.length, 1);
  nameBuf.copy(head, 5);
  head.writeUInt32BE(data.length, 5 + nameBuf.length);
  return [head, data];
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

function packageFileName({ kind, period, seq, createdAt = new Date() }) {
  if (kind === "month") return `NAVY_${period}_seq${pad(seq, 4)}.npsync`;
  if (kind === "full") return `NAVY_FULL_${period}_seq${pad(seq, 4)}.npsync`;
  if (kind === "dryrun") {
    const ts = createdAt.toISOString().replace(/[-:]/g, "").slice(0, 15);
    return `NAVY_DRYRUN_${period}_${ts}.npsync`;
  }
  throw new Error(`Unknown kind ${kind}`);
}

/** People-facing fingerprint: first 12 hex characters of the payload hash, e.g. 9F3A-71C2-0B8E. */
function fingerprint(payloadSha256) {
  const h = String(payloadSha256).slice(0, 12).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

function validateHeaderShape(h) {
  const fail = (m) => {
    throw new PackageError("bad-header", m);
  };
  if (!h || typeof h !== "object") fail("Header is not an object");
  if (h.format !== FORMAT_VERSION) fail(`Unsupported package format ${h.format}`);
  if (!["month", "full", "dryrun"].includes(h.kind)) fail(`Unknown kind ${h.kind}`);
  if (typeof h.exporterId !== "string" || !h.exporterId) fail("Missing exporterId");
  if (!Number.isInteger(h.seq) || h.seq < 0) fail("Bad seq");
  if (h.baseSeq !== null && !Number.isInteger(h.baseSeq)) fail("Bad baseSeq");
  if (!/^\d{6}$/.test(h.period)) fail("Bad period");
  if (!Array.isArray(h.databases) || h.databases.length === 0) fail("Missing databases");
  if (!Number.isInteger(h.payloadBytes) || h.payloadBytes <= 0) fail("Bad payloadBytes");
  if (!/^[0-9a-f]{64}$/.test(h.payloadSha256)) fail("Bad payloadSha256");
  if (!h.encryption || !h.encryption.authTag) fail("Missing encryption fields");
  if (typeof h.signature !== "string") fail("Missing signature");
  return h;
}

/**
 * Sequence rule used by the website (05-contracts §3).
 * lastAppliedSeq: highest seq already applied for this exporter (null if none).
 */
function checkSequence(header, lastAppliedSeq) {
  if (header.kind === "dryrun") {
    return { ok: false, code: "not-applicable", reason: "Dry-run packages are for timing only and are never applied" };
  }
  if (lastAppliedSeq !== null && header.seq <= lastAppliedSeq) {
    return { ok: false, code: "sequence-old", reason: `Package seq ${header.seq} is not newer than last applied seq ${lastAppliedSeq}` };
  }
  if (header.kind === "full") return { ok: true };
  if (lastAppliedSeq === null) {
    return { ok: false, code: "sequence-gap", reason: "No package applied yet: the first package must be a full package" };
  }
  if (header.baseSeq !== lastAppliedSeq) {
    return {
      ok: false,
      code: "sequence-gap",
      reason: `Package builds on seq ${header.baseSeq} but the last applied is seq ${lastAppliedSeq}. Upload the missing package or export a full package`,
    };
  }
  return { ok: true };
}

/** Parse the first bytes of a package (at least PAYLOAD_OFFSET bytes, or fewer if the header is short). */
function parseHeaderBuffer(buf) {
  if (buf.length < PREFIX_BYTES || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new PackageError("bad-magic", "Not a NAVY payslip package (.npsync)");
  }
  const len = buf.readUInt32BE(MAGIC.length);
  if (len > 1024 * 1024) throw new PackageError("header-too-large", "Header length is not plausible");
  if (buf.length < PREFIX_BYTES + len) throw new PackageError("truncated", "File too short to hold its header");
  let header;
  try {
    header = JSON.parse(buf.subarray(PREFIX_BYTES, PREFIX_BYTES + len).toString("utf8").trim());
  } catch (e) {
    throw new PackageError("bad-header", "Header is not valid JSON");
  }
  return { header, payloadOffset: PREFIX_BYTES + len };
}

module.exports = {
  MAGIC,
  FORMAT_VERSION,
  HEADER_RESERVED,
  PREFIX_BYTES,
  PAYLOAD_OFFSET,
  RECORD,
  PackageError,
  frameRecord,
  packageFileName,
  fingerprint,
  validateHeaderShape,
  checkSequence,
  parseHeaderBuffer,
};
