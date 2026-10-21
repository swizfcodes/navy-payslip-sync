"use strict";

const os = require("os");
const path = require("path");

/**
 * Where the exporter keeps its own files (config, signing key, ledger).
 * Never on the removable drive: the private key must stay on the payroll machine.
 *   Windows default: %ProgramData%\navy-payslip-sync
 *   Override:        NAVY_SYNC_HOME
 */
function stateDir() {
  if (process.env.NAVY_SYNC_HOME) return path.resolve(process.env.NAVY_SYNC_HOME);
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData || "C:\\ProgramData", "navy-payslip-sync");
  }
  return path.join(os.homedir(), ".navy-payslip-sync");
}

function statePath(name) {
  return path.join(stateDir(), name);
}

module.exports = { stateDir, statePath };
