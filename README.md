# navy-payslip-sync

One-way payroll export for NAVY-PAYROLL.

- **`exporter/`** runs inside the offline payroll network. It reads the payroll databases with a read-only login and writes one encrypted, signed `.npsync` package to removable media. Built into a single `navy-sync-exporter.exe`.
- **`shared/`** is the package format, the table list (manifest) and the crypto. The website (NAVY-PAYROLL) installs this repo and uses only `shared/` to verify and read packages.

Plan and contracts: `NAVY-PAYROLL/docs/payslip-sync/` (02 architecture, 05 contracts, 06 performance, 08 work split).

## Rules for this repo

- **Pure JavaScript dependencies only.** No compiled native modules, so the single-`.exe` build works.
- **No network code in the exporter** except the SQL Server connection. No auto-update, no web server, no open ports.
- **`shared/` must not require database drivers.** The website loads it.
- Table names live only in `shared/manifest.js`.

## Layout

```
shared/
  manifest.js         tables, modes (swap / replace-scope / merge-columns), keys, applyAt
  package-format.js   file layout, header checks, sequence rules, fingerprint, file names
  batch-format.js     batch JSON + gzip + checksum
  crypto.js           AES-256-GCM, X25519 + HKDF key agreement, Ed25519 signatures
  package-writer.js   streams records into an encrypted package (exporter)
  package-reader.js   verifies and reads a package (website)
  type-map.js         logical column types and wire values
exporter/
  main.js             entry: Connect -> Export -> Done; --dry-run --setup --show-key --ledger --discard-last
  cli/                the three command-line screens
  sources/            mssql-source.js (Phase 1)
  extract/            extractor.js (manifest -> batches), months.js (py_payhistory month groups)
  export-job.js       runs databases in parallel into one package; ledger
  checks.js           Connect-step schema checks
scripts/
  keygen.js           website key pair (and a development exporter key pair)
  build-exe.js        esbuild bundle -> Node single executable -> dist/navy-sync-exporter.exe
test/                 node --test
```

## Development

```
npm install
npm run keygen -- --exporter     # keys/website-*.pem (+ dev exporter keys)
npm test
npm run export                   # needs a reachable SQL Server
npm run dry-run
```

The exporter keeps its own files in `%ProgramData%\navy-payslip-sync` (override with `NAVY_SYNC_HOME`): `config.json` (no password), `exporter-private.pem`, `exporter-public.pem`, `ledger.json`.

## Building the .exe (on Windows)

```
npm install
npm run build:exe        # uses keys/website-public.pem; or --website-key <file>
```

Output in `dist/`: `navy-sync-exporter.exe`, `README.txt`, `SHA256SUMS.txt`. If the build fails, `dist/exporter.cjs` runs with a portable `node.exe`.

## Website use

```js
const sync = require("navy-payslip-sync");
const { header, payloadOffset } = await sync.reader.verifyPackage(file, { exporterPublicKeyPem });
const seqCheck = sync.format.checkSequence(header, lastAppliedSeq);
for await (const rec of sync.reader.readRecords(file, { websitePrivateKeyPem, header, payloadOffset })) {
  if (rec.type === "batch") { /* rec.batch: { database, table, mode, scope, columns, types, rows } */ }
  if (rec.type === "manifest") { /* rec.manifest: per database totals and per table rows/checksums; comes last */ }
}
```

Release: tag `v0.1.0`, `v0.1.1`, ... NAVY-PAYROLL pins `"navy-payslip-sync": "github:hicadsystems/navy-payslip-sync#v0.1.0"`.
