"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { stateDir, statePath } = require("./paths");
const { generateExporterKeyPair, keyId } = require("../shared/crypto");

const EXPORTER_PRIVATE = "exporter-private.pem";
const EXPORTER_PUBLIC = "exporter-public.pem";

/** Make the exporter signing key on first run. The private key never leaves this machine. */
async function ensureExporterKeys() {
  const priv = statePath(EXPORTER_PRIVATE);
  const pub = statePath(EXPORTER_PUBLIC);
  let created = false;
  if (!fs.existsSync(priv) || !fs.existsSync(pub)) {
    await fsp.mkdir(stateDir(), { recursive: true });
    const pair = generateExporterKeyPair();
    await fsp.writeFile(priv, pair.privateKeyPem, { encoding: "utf8", mode: 0o600, flag: "w" });
    await fsp.writeFile(pub, pair.publicKeyPem, { encoding: "utf8", mode: 0o644, flag: "w" });
    created = true;
  }
  const privateKeyPem = await fsp.readFile(priv, "utf8");
  const publicKeyPem = await fsp.readFile(pub, "utf8");
  return { privateKeyPem, publicKeyPem, keyId: keyId(publicKeyPem), created };
}

/**
 * Website public key (X25519). In the built .exe it is compiled in (see scripts/build-exe.js),
 * so nobody can swap it on the payroll machine. During development it is read from
 * NAVY_SYNC_WEBSITE_PUBLIC_KEY (a file path) or keys/website-public.pem.
 */
function loadWebsitePublicKey() {
  try {
    // eslint-disable-next-line global-require
    const generated = require("./website-key.generated.js");
    if (generated && generated.WEBSITE_PUBLIC_KEY_PEM) return generated.WEBSITE_PUBLIC_KEY_PEM;
  } catch (_) {
    /* not built in: development run */
  }
  const candidates = [
    process.env.NAVY_SYNC_WEBSITE_PUBLIC_KEY,
    path.join(__dirname, "..", "keys", "website-public.pem"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  }
  throw new Error(
    "Website public key not found. Run `npm run keygen` (development) or use the built .exe, which carries the key.",
  );
}

module.exports = { ensureExporterKeys, loadWebsitePublicKey };
