"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const { stateDir, statePath } = require("./paths");
const { DATABASES } = require("../shared/manifest");
const { DEFAULT_QUALITY } = require("../shared/batch-format");

// Defaults before 0.1.3. A config.json still holding them gets the new ones (bigger
// batches compress better now that batches are brotli, column by column).
const OLD_DEFAULT_BATCH_ROWS = 5000;

const CONFIG_FILE = "config.json";

/**
 * config.json (no password is ever stored):
 * {
 *   "exporterId": "navy-payroll-office-01",
 *   "source": { "type": "mssql", "server": "HICAD-THREEONE\\SQL2022", "port": null, "user": "sync_reader",
 *               "encrypt": false, "trustServerCertificate": true },
 *   "databases": { "officers": "HicadData", "wofficers": "...", ... },   // website name -> source name ("" = skip)
 *   "outputDir": "E:\\",
 *   "lastOperator": "",
 *   "batchRows": 10000,
 *   "packQuality": 9,          // brotli quality 1-11 for Full packages: higher = smaller, slower
 *   "packQualityMonth": 6,     // the same for Month packages (kept fast for the 15 min target)
 *   "concurrency": 6,          // databases exported at the same time
 *   "useProcesses": true       // each in its own process, so each gets its own CPU core
 * }
 */
const DEFAULTS = {
  exporterId: "navy-payroll-office-01",
  source: {
    type: "mssql",
    server: "",
    port: null,
    user: "",
    encrypt: false,
    trustServerCertificate: true,
  },
  databases: Object.fromEntries(DATABASES.map((d) => [d, ""])),
  outputDir: "",
  lastOperator: "",
  batchRows: 10000,
  packQuality: DEFAULT_QUALITY,
  packQualityMonth: 6,
  concurrency: 6,
  useProcesses: true, // one process per database (uses more CPU cores); false = all in one process
};

function configPath() {
  return statePath(CONFIG_FILE);
}

function configExists() {
  return fs.existsSync(configPath());
}

async function loadConfig() {
  const raw = JSON.parse(await fsp.readFile(configPath(), "utf8"));
  const cfg = {
    ...DEFAULTS,
    ...raw,
    source: { ...DEFAULTS.source, ...(raw.source || {}) },
    databases: { ...DEFAULTS.databases, ...(raw.databases || {}) },
  };
  if (raw.batchRows === OLD_DEFAULT_BATCH_ROWS) cfg.batchRows = DEFAULTS.batchRows;
  validateConfig(cfg);
  return cfg;
}

async function saveConfig(cfg) {
  validateConfig(cfg);
  await fsp.mkdir(stateDir(), { recursive: true });
  const tmp = `${configPath()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
  await fsp.rename(tmp, configPath());
}

function validateConfig(cfg) {
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(cfg.exporterId || "")) {
    throw new Error("exporterId must be 3-64 characters: letters, digits, dot, dash, underscore");
  }
  if (cfg.source.type !== "mssql") throw new Error(`Source type "${cfg.source.type}" is not supported yet`);
  for (const [site, src] of Object.entries(cfg.databases)) {
    if (!DATABASES.includes(site)) throw new Error(`Unknown website database "${site}" in config`);
    if (src && !/^[A-Za-z0-9_]{1,128}$/.test(src)) throw new Error(`Source database name "${src}" has invalid characters`);
  }
  if (!Number.isInteger(cfg.batchRows) || cfg.batchRows < 100 || cfg.batchRows > 50000) {
    throw new Error("batchRows must be between 100 and 50000");
  }
  for (const k of ["packQuality", "packQualityMonth"]) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 1 || cfg[k] > 11) throw new Error(`${k} must be between 1 and 11`);
  }
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1 || cfg.concurrency > 6) {
    throw new Error("concurrency must be between 1 and 6");
  }
  if (typeof cfg.useProcesses !== "boolean") throw new Error("useProcesses must be true or false");
}

/** [{ website, source }] for the databases that are configured (non-empty source name). */
function activeDatabases(cfg) {
  return DATABASES.filter((d) => cfg.databases[d]).map((d) => ({ website: d, source: cfg.databases[d] }));
}

module.exports = { DEFAULTS, configPath, configExists, loadConfig, saveConfig, validateConfig, activeDatabases };
