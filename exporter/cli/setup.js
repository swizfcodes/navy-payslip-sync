"use strict";

const { DATABASES, MASTER_DATABASE } = require("../../shared/manifest");
const { DEFAULTS, saveConfig } = require("../config");

/** First run (or --setup): connection details and database names. The password is never saved. */
async function runSetup(prompt, existing) {
  const cfg = JSON.parse(JSON.stringify(existing || DEFAULTS));
  console.log("\nSetup — saved on this machine only. The password is never saved.\n");

  cfg.exporterId = await prompt.ask("Exporter name (registered on the website)", cfg.exporterId);
  cfg.source.server = await prompt.ask("SQL Server (e.g. HICAD-THREEONE\\SQL2022)", cfg.source.server);
  if (!cfg.source.server.includes("\\")) {
    const port = await prompt.ask("Port", cfg.source.port || 1433);
    cfg.source.port = Number(port) || 1433;
  } else {
    cfg.source.port = null; // named instance: SQL Browser finds the port
  }
  cfg.source.user = await prompt.ask("Read-only login", cfg.source.user || "sync_reader");
  cfg.source.encrypt = await prompt.confirm("Encrypt the SQL connection", Boolean(cfg.source.encrypt));

  console.log("\nSource database name for each payroll class (leave empty to skip):");
  for (const d of DATABASES) {
    const note = d === MASTER_DATABASE ? " (master, e.g. HicadData)" : "";
    cfg.databases[d] = await prompt.ask(`  ${d}${note}`, cfg.databases[d] || "");
  }

  await saveConfig(cfg);
  console.log("\nSaved.\n");
  return cfg;
}

module.exports = { runSetup };
