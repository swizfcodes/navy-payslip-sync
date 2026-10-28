"use strict";

/**
 * A plain text log of each export run, kept next to the config:
 *   %ProgramData%\navy-payslip-sync\export-log.txt
 * Every progress event, with the time, so a run that hangs or fails can be
 * looked at afterwards (which database, which table, last activity).
 * Kept small: when it passes 2 MB it is renamed to export-log.old.txt.
 */

const fs = require("fs");
const { stateDir, statePath } = require("./paths");

const MAX_BYTES = 2 * 1024 * 1024;
let stream = null;

function open() {
  if (stream) return stream;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const file = statePath("export-log.txt");
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, statePath("export-log.old.txt"));
    } catch (_) {}
    stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", () => {
      stream = null;
    });
  } catch (_) {
    stream = null;
  }
  return stream;
}

/** Append one line. Never throws: logging must not stop an export. */
function runLog(message) {
  const s = open();
  if (!s) return;
  try {
    s.write(`[${new Date().toISOString()}] ${message}\n`);
  } catch (_) {}
}

function logPath() {
  return statePath("export-log.txt");
}

module.exports = { runLog, logPath };
