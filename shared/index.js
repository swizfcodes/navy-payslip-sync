"use strict";

/**
 * Shared code for both sides. The website uses:
 *   const sync = require("navy-payslip-sync");
 *   sync.manifest.tablesFor(...), sync.reader.verifyPackage(...), sync.reader.readRecords(...),
 *   sync.format.checkSequence(...), sync.format.fingerprint(...), sync.crypto.keyId(...)
 * Nothing here needs the database drivers.
 */

module.exports = {
  version: require("../package.json").version,
  manifest: require("./manifest"),
  format: require("./package-format"),
  batch: require("./batch-format"),
  crypto: require("./crypto"),
  types: require("./type-map"),
  reader: require("./package-reader"),
  writer: require("./package-writer"),
  timings: require("./timings"),
  canonicalJson: require("./canonical-json").canonicalJson,
};
