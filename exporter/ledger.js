"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const { stateDir, statePath } = require("./paths");

const LEDGER_FILE = "ledger.json";

/**
 * Local record of every package this exporter produced:
 * [{ seq, baseSeq, kind, period, file, bytes, fingerprint, operator, createdAt, databases, seconds, discarded }]
 *
 * - seq always increases (never reused, even for discarded packages).
 * - baseSeq of the next package = seq of the last package that was NOT discarded.
 *   Mark a package discarded (`--discard-last`) only if it was never uploaded.
 */
async function readLedger() {
  if (!fs.existsSync(statePath(LEDGER_FILE))) return [];
  return JSON.parse(await fsp.readFile(statePath(LEDGER_FILE), "utf8"));
}

async function writeLedger(entries) {
  await fsp.mkdir(stateDir(), { recursive: true });
  const tmp = `${statePath(LEDGER_FILE)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
  await fsp.rename(tmp, statePath(LEDGER_FILE));
}

function lastKept(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) if (!entries[i].discarded) return entries[i];
  return null;
}

function nextSeq(entries) {
  return entries.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
}

async function appendLedger(entry) {
  const entries = await readLedger();
  entries.push(entry);
  await writeLedger(entries);
}

async function discardLast() {
  const entries = await readLedger();
  const last = lastKept(entries);
  if (!last) return null;
  last.discarded = true;
  last.discardedAt = new Date().toISOString();
  await writeLedger(entries);
  return last;
}

module.exports = { readLedger, lastKept, nextSeq, appendLedger, discardLast };
