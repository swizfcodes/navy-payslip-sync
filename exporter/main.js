#!/usr/bin/env node
"use strict";

/**
 * navy-sync-exporter — runs inside the offline payroll network.
 *
 *   navy-sync-exporter.exe                 Connect -> Export -> Done
 *   navy-sync-exporter.exe --dry-run       same, but a timing-only package (never applied)
 *   navy-sync-exporter.exe --setup         change server, login or database names
 *   navy-sync-exporter.exe --show-key      print the exporter public key to register on the website
 *   navy-sync-exporter.exe --ledger        list exported packages
 *   navy-sync-exporter.exe --discard-last  mark the last package as never uploaded
 */

const readline = require("readline");
const pkg = require("../package.json");
const { createPrompt } = require("./cli/prompt");
const { configExists, loadConfig, configPath } = require("./config");
const { runSetup } = require("./cli/setup");
const { ensureExporterKeys, loadWebsitePublicKey } = require("./keys");
const { readLedger, discardLast } = require("./ledger");
const { stepConnect } = require("./cli/connect");
const { stepExport } = require("./cli/export");
const { stepDone } = require("./cli/done");
const { stateDir } = require("./paths");
const { mb } = require("./cli/format");
const { formatKeyId } = require("../shared/crypto");

const HELP = `
NAVY Payslip Exporter v${pkg.version}

Usage: navy-sync-exporter [option]

  (no option)      Connect, export a month or full package, show the fingerprint
  --dry-run        Timing test: reads and packs everything, writes a package the website never applies
  --setup          Change the server or database names, or create the read-only login
  --show-key       Print this exporter's key id and public key
  --ledger         List the packages exported from this machine
  --discard-last   Mark the last package as never uploaded (lost or destroyed)
  --help           This text

Files kept on this machine: ${stateDir()}
`;

async function showKey(exporterKeys) {
  const cfg = configExists() ? await loadConfig() : null;
  console.log(`\nExporter name ... ${cfg ? cfg.exporterId : "(not set up yet: run without options first)"}`);
  console.log(`Key id .......... ${formatKeyId(exporterKeys.keyId)}`);
  console.log("\nPublic key (copy all lines, including BEGIN/END, to the website registration):\n");
  console.log(exporterKeys.publicKeyPem);
}

async function showLedger() {
  const entries = await readLedger();
  if (!entries.length) {
    console.log("\nNo packages exported yet.\n");
    return;
  }
  console.log("\n  seq  base  kind   period   fingerprint      size      operator              created");
  for (const e of entries) {
    const flag = e.discarded ? "  (discarded)" : "";
    console.log(
      `  ${String(e.seq).padStart(3)}  ${String(e.baseSeq ?? "-").padStart(4)}  ${e.kind.padEnd(5)}  ${e.period}   ${e.fingerprint}   ${mb(e.bytes).padStart(8)}  ${String(e.operator || "").padEnd(20).slice(0, 20)}  ${e.createdAt}${flag}`,
    );
  }
  console.log("");
}

async function discard(prompt) {
  const entries = await readLedger();
  const last = [...entries].reverse().find((e) => !e.discarded);
  if (!last) {
    console.log("\nNothing to discard.\n");
    return;
  }
  console.log(`\nLast package: seq ${last.seq}, ${last.kind} ${last.period}, fingerprint ${last.fingerprint}`);
  console.log("Only do this if that file was never uploaded to the website.");
  if (await prompt.confirm("Mark it as discarded", false)) {
    await discardLast();
    console.log("Done. The next package will build on the package before it.\n");
  }
}

async function main(argv) {
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    console.log(HELP);
    return;
  }

  console.log(`NAVY Payslip Exporter  v${pkg.version}`);
  const exporterKeys = await ensureExporterKeys();
  console.log(`  Exporter key id: ${formatKeyId(exporterKeys.keyId)}`);
  if (exporterKeys.created) {
    console.log(`  A new exporter key was created in ${stateDir()}.`);
    console.log("  The key travels inside every package. When the website asks to approve this exporter,");
    console.log("  check that it shows the same key id as above.");
  }

  if (args.has("--show-key")) return showKey(exporterKeys);
  if (args.has("--ledger")) return showLedger();

  const prompt = createPrompt();
  let source = null;
  try {
    if (args.has("--discard-last")) return await discard(prompt);

    let config;
    let password = null;
    if (!configExists() || args.has("--setup")) {
      const existing = configExists() ? await loadConfig().catch(() => null) : null;
      ({ config, password } = await runSetup(prompt, existing));
    } else {
      config = await loadConfig();
      console.log(`  Settings: ${configPath()}`);
    }

    const websitePublicKeyPem = loadWebsitePublicKey();
    const conn = await stepConnect(prompt, config, password);
    password = null;
    source = conn.source;

    const result = await stepExport(prompt, {
      config,
      source,
      databases: conn.databases,
      period: conn.period,
      dryRun: args.has("--dry-run"),
      keys: { websitePublicKeyPem, exporter: exporterKeys },
    });
    stepDone(result);
  } finally {
    prompt.close();
    if (source) await source.close().catch(() => {});
  }
}

/** When started by double-click the window would close at once; wait for Enter on Windows. */
function waitForEnter() {
  if (process.platform !== "win32" || !process.stdin.isTTY || process.env.NAVY_SYNC_NO_PAUSE) return Promise.resolve();
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Press Enter to close.", () => {
      rl.close();
      resolve();
    });
  });
}

main(process.argv.slice(2))
  .catch((err) => {
    console.error(`\n  ERROR: ${err.message}\n`);
    process.exitCode = 1;
  })
  .then(waitForEnter);
