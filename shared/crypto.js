"use strict";

/**
 * Crypto for .npsync packages. Node built-ins only (no native modules), so it works
 * inside the single-file exporter .exe and on the website.
 *
 * - Payload encryption: AES-256-GCM.
 * - Key agreement:      X25519 (one fresh key pair per package) + HKDF-SHA256.
 *                       Only the holder of the website private key can derive the AES key.
 * - Signature:          Ed25519 by the exporter over the canonical header.
 */

const crypto = require("crypto");
const { canonicalJson } = require("./canonical-json");

const HKDF_INFO = Buffer.from("navy-payslip-sync/v1/payload-key", "utf8");
const SIG_PREFIX = "ed25519:";

// ---------- key helpers ----------

function generateWebsiteKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

function generateExporterKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

function toPublicKey(pemOrKey) {
  return pemOrKey instanceof crypto.KeyObject ? pemOrKey : crypto.createPublicKey(pemOrKey);
}

function toPrivateKey(pemOrKey) {
  return pemOrKey instanceof crypto.KeyObject ? pemOrKey : crypto.createPrivateKey(pemOrKey);
}

/** Short, stable id for a public key (shown when approving an exporter). */
function keyId(publicKeyPem) {
  const der = toPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** "3f9c1a2b7d0e55aa" -> "3F9C-1A2B-7D0E-55AA" (how people read and compare key ids). */
function formatKeyId(id) {
  return String(id)
    .toUpperCase()
    .match(/.{1,4}/g)
    .join("-");
}

// ---------- payload key agreement ----------

function deriveKey(sharedSecret, ephemeralPubDer, websitePubDer) {
  const salt = Buffer.concat([ephemeralPubDer, websitePubDer]);
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, salt, HKDF_INFO, 32));
}

/**
 * Exporter side: make a fresh payload key for one package.
 * Returns the AES key plus the public values that go into the header.
 */
function createPayloadKey(websitePublicKeyPem) {
  const websitePub = toPublicKey(websitePublicKeyPem);
  if (websitePub.asymmetricKeyType !== "x25519") {
    throw new Error("Website public key must be an X25519 key");
  }
  const eph = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: websitePub });
  const ephDer = eph.publicKey.export({ type: "spki", format: "der" });
  const webDer = websitePub.export({ type: "spki", format: "der" });
  const key = deriveKey(shared, ephDer, webDer);
  const iv = crypto.randomBytes(12);
  return {
    key,
    iv,
    headerFields: {
      alg: "AES-256-GCM",
      kdf: "X25519-HKDF-SHA256",
      ephemeralPublicKey: ephDer.toString("base64"),
      websiteKeyId: keyId(websitePub),
      iv: iv.toString("base64"),
    },
  };
}

/** Website side: recover the payload AES key from the header and the website private key. */
function recoverPayloadKey(encryption, websitePrivateKeyPem) {
  if (!encryption || encryption.alg !== "AES-256-GCM" || encryption.kdf !== "X25519-HKDF-SHA256") {
    throw new Error("Unsupported package encryption");
  }
  const websitePriv = toPrivateKey(websitePrivateKeyPem);
  const websitePub = crypto.createPublicKey(websitePriv);
  if (encryption.websiteKeyId && encryption.websiteKeyId !== keyId(websitePub)) {
    throw new Error("Package was encrypted for a different website key");
  }
  const ephDer = Buffer.from(encryption.ephemeralPublicKey, "base64");
  const ephPub = crypto.createPublicKey({ key: ephDer, format: "der", type: "spki" });
  const shared = crypto.diffieHellman({ privateKey: websitePriv, publicKey: ephPub });
  const webDer = websitePub.export({ type: "spki", format: "der" });
  return {
    key: deriveKey(shared, ephDer, webDer),
    iv: Buffer.from(encryption.iv, "base64"),
    authTag: encryption.authTag ? Buffer.from(encryption.authTag, "base64") : null,
  };
}

function createPayloadCipher(key, iv) {
  return crypto.createCipheriv("aes-256-gcm", key, iv);
}

function createPayloadDecipher(key, iv, authTag) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  if (authTag) d.setAuthTag(authTag);
  return d;
}

// ---------- header signature ----------

function headerSigningBytes(header) {
  const { signature, ...rest } = header; // eslint-disable-line no-unused-vars
  return Buffer.from(canonicalJson(rest), "utf8");
}

function signHeader(header, exporterPrivateKeyPem) {
  const sig = crypto.sign(null, headerSigningBytes(header), toPrivateKey(exporterPrivateKeyPem));
  return SIG_PREFIX + sig.toString("base64");
}

function verifyHeaderSignature(header, exporterPublicKeyPem) {
  if (typeof header.signature !== "string" || !header.signature.startsWith(SIG_PREFIX)) return false;
  const sig = Buffer.from(header.signature.slice(SIG_PREFIX.length), "base64");
  return crypto.verify(null, headerSigningBytes(header), toPublicKey(exporterPublicKeyPem), sig);
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

module.exports = {
  generateWebsiteKeyPair,
  generateExporterKeyPair,
  keyId,
  formatKeyId,
  createPayloadKey,
  recoverPayloadKey,
  createPayloadCipher,
  createPayloadDecipher,
  signHeader,
  verifyHeaderSignature,
  sha256Hex,
};
