#!/usr/bin/env node
"use strict";

/**
 * Makes key pairs.
 *
 *   node scripts/keygen.js              website key pair -> keys/website-*.pem
 *   node scripts/keygen.js --exporter   also a development exporter key pair -> keys/exporter-*.pem
 *   node scripts/keygen.js --force      overwrite existing files
 *   node scripts/keygen.js --out <dir>  write somewhere else
 *
 * website-private.pem is a secret: copy it to the website's secret store (SYNC_PRIVATE_KEY),
 * then delete it from this folder. website-public.pem is built into the exporter .exe.
 */

const fs = require("fs");
const path = require("path");
const { generateWebsiteKeyPair, generateExporterKeyPair, keyId } = require("../shared/crypto");

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const withExporter = argv.includes("--exporter");
const outIdx = argv.indexOf("--out");
const outDir = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : path.join(__dirname, "..", "keys"));

function write(name, content, mode) {
  const file = path.join(outDir, name);
  if (fs.existsSync(file) && !force) {
    throw new Error(`${file} already exists (use --force to replace it)`);
  }
  fs.writeFileSync(file, content, { encoding: "utf8", mode });
  return file;
}

try {
  fs.mkdirSync(outDir, { recursive: true });
  const web = generateWebsiteKeyPair();
  write("website-private.pem", web.privateKeyPem, 0o600);
  write("website-public.pem", web.publicKeyPem, 0o644);
  console.log(`Website key pair written to ${outDir}`);
  console.log(`  key id: ${keyId(web.publicKeyPem)}`);
  console.log("  website-private.pem is SECRET: move it to the website secret store, then delete it here.");

  if (withExporter) {
    const exp = generateExporterKeyPair();
    write("exporter-private.pem", exp.privateKeyPem, 0o600);
    write("exporter-public.pem", exp.publicKeyPem, 0o644);
    console.log(`Development exporter key pair written (key id ${keyId(exp.publicKeyPem)}).`);
    console.log("  For testing only. The real exporter makes its own key on the payroll machine.");
  }
} catch (err) {
  console.error(`keygen: ${err.message}`);
  process.exitCode = 1;
}
