"use strict";

const { dots, mb, formatDuration, num } = require("./format");

/** STEP 3 — Done. */
function stepDone(result) {
  const h = result.header;
  console.log("\nSTEP 3 of 3 — Done");
  console.log(`  ${dots("File", 15)} ${result.filePath}`);
  console.log(`  ${dots("Size", 15)} ${mb(result.bytes)}`);
  if (result.kind !== "dryrun") {
    const follows = h.baseSeq == null ? "first package" : `follows ${h.baseSeq}`;
    console.log(`  ${dots("Sequence", 15)} ${h.seq}  (${follows})`);
  }
  console.log(`  ${dots("Fingerprint", 15)} ${result.fingerprint}   <- write this in the media log`);
  console.log(`  ${dots("Time", 15)} ${formatDuration(result.seconds * 1000)}`);
  console.log("");
  for (const [db, r] of Object.entries(result.manifest.databases)) {
    console.log(`  ${db.padEnd(15)} ${num(r.totals.staffCount).padStart(8)} staff   net ${r.totals.totalNet}`);
  }
  if (result.kind === "dryrun") {
    console.log("\n  Dry run: this file is for upload timing only. The website will refuse to apply it.");
  }
  console.log("");
}

module.exports = { stepDone };
