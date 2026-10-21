# Developer guide

## Set up

```
git clone <repo URL> C:\navy-payslip-sync
cd C:\navy-payslip-sync
npm install                    # on Windows, so esbuild gets its Windows binary
npm run keygen -- --exporter   # keys/website-*.pem and development exporter keys
npm test
```

Node 20.12 or newer. To try the exporter against a SQL Server: `npm run export` (setup runs first). Use `NAVY_SYNC_HOME=<folder>` to keep development settings, keys and ledger away from `%ProgramData%`.

## Code layout

```
shared/                 used by exporter AND website; no database drivers
  manifest.js           tables, modes, keys, scopes, applyAt, rollback — the only place table names live
  package-format.js     file layout, header checks, sequence rules, fingerprint, file names, PackageError
  batch-format.js       batch JSON + gzip + checksum
  crypto.js             AES-256-GCM, X25519 + HKDF, Ed25519, key ids
  package-writer.js     streams records into an encrypted package
  package-reader.js     readHeader, verifyPackage, inspectNewExporter, readRecords
  type-map.js           logical types and wire values
  canonical-json.js, timings.js, index.js
exporter/               runs inside the offline network
  main.js               entry and options
  cli/                  prompt, setup (login creation, database discovery), connect, export, done, format
  sources/mssql-source.js   streaming reads with exact values; discovery; login creation
  extract/extractor.js  manifest → batches per database
  extract/months.js     py_payhistory month groups and ranges
  export-job.js         databases in parallel into one package; ledger update
  checks.js, config.js, keys.js, ledger.js, paths.js
scripts/                keygen.js, build-exe.js
test/                   node --test
```

## Rules

1. **Pure JavaScript dependencies only.** No compiled native modules (the `.exe` build cannot carry them).
2. **No network code in `exporter/`** except the SQL Server connection. No HTTP, no auto-update, no listening sockets.
3. **`shared/` never requires a database driver.** The website loads it. (`cli/setup.js` loads the SQL driver lazily so tests need none.)
4. **Table names only in `shared/manifest.js`.**
5. **Stream everything.** Never hold a whole table or package in memory.
6. **Exact values.** Money, decimals, bigints and dates are converted to strings in SQL (`sources/mssql-source.js`), never through JavaScript numbers or `Date`.
7. **Read only.** The exporter's only writes are the package, its settings, its key and its ledger. The admin connection in setup only creates the read-only login.

## How an export runs

1. `checks.js` verifies each database: tables present, `hr_employees` payroll columns present, BT05 period.
2. `export-job.planExport` works out `seq`, `baseSeq` and the `py_payhistory` months from the ledger.
3. `PackageWriter.create` opens `<file>.part`, reserves the header, starts the cipher.
4. Each database runs `extractor.extractDatabase` in parallel: for each manifest table it plans the reads (whole table, one period, or one year with chosen month columns), streams rows, converts values, and sends 5,000-row gzipped batches to the writer.
5. The writer writes the manifest and end record, finishes the cipher, writes the signed header into the reserved space, and renames the file.
6. The ledger gets a new line.

## Adding a table

1. Add an entry to `TABLES` in `shared/manifest.js`: `name`, `key`, `columns` (`"*"` or a list), and `month` / `full` plans (`mode`, `scope`, `applyAt`).
2. If it needs a new kind of read, extend `planTable` in `exporter/extract/extractor.js`.
3. Tell Dev B (the website applies it by mode, so a new swap or merge table usually needs no website code).
4. Bump the version; tag; update NAVY-PAYROLL's dependency.

## Tests

`npm test` runs everything in `test/`. Add a test for any change to the format, crypto, sequence rules or month logic. Code that needs a SQL Server is checked on real runs; see [Test plan](../05-delivery/test-plan.md).
