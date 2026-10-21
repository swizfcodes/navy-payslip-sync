# Work split: 2 developers, 2 build days, 1 test day

**Schedule (assumed):** Day 1 = Thu 22 Oct 2026, Day 2 = Fri 23 Oct (code freeze 18:00), Day 3 = Sat 24 Oct, test on staging. Shift by a day each if Saturday is not a working day.

**Split:** the seam is the package file.

| | Dev A — Exporter (inside) | Dev B — Website (outside) |
|---|---|---|
| Repo | `navy-payslip-sync` (new) | `NAVY-PAYROLL` (existing) |
| Owns | `shared/*`, `exporter/*`, `scripts/*`, `navy-sync-exporter.exe` | `routes/sync/*`, `services/sync/*`, migrations, `public/sections/payslip-sync.html`, fixes in existing files |
| Builds the screen | Exporter command-line screens (Connect, Export, Done) | Sync Console page in the admin dashboard (Upload, Runs, Publications) |
| Needs | A copy of the legacy MSSQL databases + read-only login | `staging.hicad.ng` DB access + a MySQL user that can `RENAME TABLE` |
| Hands over | Day 1, 16:00: a real **full package** (it carries the exporter key; B approves it) | Day 1, 12:00: upload endpoint live on staging |

Suggested: Dev A is whoever has access to the legacy MSSQL.

## Scope for this delivery

**In:**

- Package format with encryption and signature (non-negotiable for the air gap)
- Exporter for legacy MSSQL: kinds `full` and `month`; command-line screens (Connect → Export → Done); dry run with timings; built as `.exe`. No Electron, no local web page
- Website: resumable upload, verify + decrypt, stage load, scoped / merge apply, validate, Go live (`RENAME TABLE`), withdraw, roll back
- Console: Upload, Runs (with timing bar), Publications
- Fixes: index fixes, `userpayslip.js` published check, procedure year check, `ippis-payment.js` columns, `migratedata.js` credentials

**Out (after the test day):** Phase 2 changes for payroll, Reconciliation tab (totals show in run detail instead), Settings tab (exporters registered by script), auto Go live, reference-only kind, saved passwords in Windows Credential Manager (typed each time for now), MySQL source for Phase 2, a local web page for the exporter (it stays command-line).

## Before Day 1 (today, both, 1 hour)

- [ ] Agree who is A and who is B
- [ ] Create the `navy-payslip-sync` repo (private, under hicadsystems); give B read access; set up a read-only deploy key for the staging server
- [ ] A: confirm access to the legacy MSSQL copy. The exporter's setup creates the read-only login (with an admin login typed once) and finds and maps the databases itself
- [ ] B: on staging, run the `py_ipis_payhistory` duplicate check ([Performance](../02-design/performance.md), "Index fixes"); if clean, apply all index fixes
- [ ] B: confirm `max_allowed_packet` and that the sync MySQL user can run `RENAME TABLE`
- [ ] Both: accept the default `hr_employees` payroll column list ([Data and tables](../02-design/data-and-tables.md)) for this delivery

## Contract decisions (agreed 21 Oct, answers to Dev B)

| Question | Decision |
|---|---|
| Rollback only covers swap tables | Merge and replace-scope tables get an `__undo` snapshot at Prepare (rows about to change, sent columns only, plus the list of new keys). Rollback restores them, so `hr_employees` names and bank details go back too. Only the latest live run can be rolled back |
| `__prev` cleanup order | Go live: `DROP TABLE IF EXISTS …__prev`, then one `RENAME TABLE`. Rollback: three-way swap through `__rb` in one statement, so it can be reversed. Exact SQL in [Website contract](../03-reference/website-contract.md), "Apply, Go live and roll back" |
| Which database `hr_employees` is merged into | The database the batch came from: `officers` = master `hicaddata`; each class database also has its own `hr_employees` (the payslip procedure reads it). Confirm on staging that `hicaddata.hr_employees` has every staff member |
| Go live across six databases | Atomic per database is what matters (each staff member reads one database). One statement for all six if they share a MySQL server; otherwise one per server. B confirms the server layout on staging and production |
| Exporter "127.0.0.1" vs "no open ports" | No web server, no open ports. Fixed in every doc |
| Who clicks Go live; automatic? | Manual, sync role only, in this delivery. Automatic Go live is a later setting (off by default) |
| Years of history | The full package carries every year in the source tables. A full dry run (`--dry-run`, choose Full) on Day 2 measures the size and time. If too big, the client chooses a cut-off year and we add a filter |
| After a rollback | The last applied seq steps back. The officer inside runs `--discard-last` before the next export; the Console says so |

## Day 1

**09:00–10:00 — both: freeze the contract.** Walk through `[Website contract](../03-reference/website-contract.md)` together and fix: header fields, batch JSON, crypto choices (AES-256-GCM, X25519 sealed key, Ed25519 signature), manifest entries ([Data and tables](../02-design/data-and-tables.md)), file naming. After this hour, changing the contract needs both of you.

**Dev A**

- [ ] Repo skeleton: `package.json` (`main: shared/index.js`), `shared/`, `exporter/`, `scripts/`, `test/`
- [ ] `shared/manifest.js` — every table, mode, key, scope column, owned columns, apply phase
- [ ] `shared/batch-format.js`, `package-format.js`, `timings.js`
- [ ] `shared/crypto.js` — streamed AES-256-GCM, seal / unseal key, sign / verify; unit check: encrypt → decrypt round trip
- [ ] `scripts/keygen.js` — makes the website key pair and the exporter key pair
- [ ] **11:00:** tag `v0.1.0` (shared code incl. `crypto.js`) so B can install it
- [ ] `shared/type-map.js` — money, nvarchar padding, datetime, bit, case-insensitive column names
- [ ] `exporter/sources/mssql-source.js` — streaming reads, keyset order by primary key
- [ ] `exporter/extract/extractor.js`, `totals.js`
- [x] `shared/package-writer.js` + `shared/package-reader.js` — streamed writing (header last) and the website's verify / read functions
- [ ] **16:00 handover:** first real full package (one database is fine) to B; tell B the exporter key id shown on screen

**Dev B**

- [ ] Migration `<ts>_sync_control_tables.sql` (control tables, see [Website contract](../03-reference/website-contract.md); `sync_changes` can wait)
- [ ] Migration `<ts>_payroll_index_fixes.sql` ([Performance](../02-design/performance.md), "Index fixes")
- [ ] Mount `/api/sync` in `routes/index.js`; sync role check
- [ ] After 11:00: add `"navy-payslip-sync": "github:hicadsystems/navy-payslip-sync#v0.1.0"` to `package.json`
- [ ] `routes/sync/packages.routes.js` + `services/sync/upload.service.js` — header check, 8 MB chunks, resume, complete (**12:00:** live on staging)
- [ ] `services/sync/package.service.js` — signature, sequence rules, decrypt and stream batches out (with A's `crypto.js` after 11:00)
- [ ] Exporter approval: unknown exporter → `inspectNewExporter()` → super admin confirms key id → `sync_exporters` ([Website contract](../03-reference/website-contract.md), "Approving a new exporter"). `scripts/sync-register-exporter.js` as fallback
- [ ] `services/sync/staging.service.js` — `<table>__stage` with primary key only, secondary indexes added after load
- [ ] `services/sync/loader.service.js` — multi-row `INSERT` sized under `max_allowed_packet`
- [ ] **16:00:** load A's first package into stage tables on staging

**17:00 — both, 30 min:** what broke in the handover; fix the contract if needed.

## Day 2

**Dev A**

- [x] `extract/months.js` + `ledger.js` — `seq` / `baseSeq`, which `py_payhistory` month columns go in a month package
- [ ] Kind `month` (one period of IPPIS, new month columns, full swap tables)
- [ ] Command-line screens: Connect (test each database: reachable, staff count, BT05), Export (kind, period, databases, output folder, live progress), Done (file, size, seq, fingerprint in large type)
- [ ] Six databases read in parallel into one package
- [ ] Dry run: reads and packs everything, prints per-table rows, raw MB, packed MB and seconds
- [ ] `build/build-exe.js` → `navy-sync-exporter.exe` (Node single executable) + `README.txt`
- [ ] Run a full-size dry run on the legacy copy; record package size and export time

**Dev B**

- [ ] `services/sync/merge.service.js` — replace-scope and merge-columns via stage tables, with `__undo` snapshots first ([Website contract](../03-reference/website-contract.md), "Apply, Go live and roll back"), chunks of 10,000 keys
- [ ] `services/sync/validate.service.js` — counts, checksums, totals; `run.service.js` statuses and timings
- [ ] `services/sync/golive.service.js` — drop old `__prev`, then one `RENAME TABLE`; roll back by swap + undo snapshots; withdraw (exact order in [Website contract](../03-reference/website-contract.md), "Apply, Go live and roll back")
- [ ] `services/sync/publication.service.js` + check in `userpayslip.js`. Periods before the first synced publication count as published, so existing history stays visible
- [ ] `py_generate_combined_payslip`: compare year as well as month
- [ ] `routes/utilities/ippis-payment.js`: replace the `id` / `updated_at` queries with one `INSERT … ON DUPLICATE KEY UPDATE`
- [ ] `migratedata.js`: credentials to `.env`
- [ ] `public/sections/payslip-sync.html` — Upload (header preview, resumable progress, processing progress), Runs (+ detail with timing bar), Publications (Go live, Withdraw, Roll back); menu entries in `dashboard.html`, `menu-highlighting.js`, `sidebar-filter.js`, `quick-access.js`

**14:00 — both: first end to end on staging.** A exports a full package from the legacy copy → B uploads → prepared → Go live → open five payslips.

**18:00 — code freeze.** Both branches merged; staging deployed; `.exe` built.

## Day 3 — Test on staging

The full checklist is in [Test plan](test-plan.md).

## Risks for this timeline

| Risk | Owner | Fallback |
|---|---|---|
| Streamed encryption takes longer than planned | A | Encrypt each batch on its own with the same key (simpler); keep the header format |
| Node single-executable build fails | A | Ship portable Node + script in a folder for the test day |
| Host MySQL user cannot `RENAME TABLE` | B | Swap by copy inside one transaction for the test (slower); fix grants before production |
| Duplicates block the `py_ipis_payhistory` primary key | B | Add a plain index `(period, numb, Type)` for now; clean duplicates later |
| Legacy copy not ready on Day 1 | A | Build against a MySQL copy with the same table names; switch source on Day 2 |
| Full package too big for one test day upload | Both | Full package per database; six uploads |

## Milestones beyond the test day

Each milestone has a gate that must pass before the next starts. Dates to be set by the team.

1. **M0 — Decisions settled.** Section 4 answered, including security sign-off. Index fixes ([Performance](../02-design/performance.md), "Index fixes") applied.
2. **M1 — Foundations + measurement.** Control tables, manifest, package format, exporter dry run (reads, packs and times everything; test package uploaded to staging). *Gate:* counts match legacy for one database; projected machine time ≤ 10 min.
3. **M2 — Reference packages on staging.** Export, upload and apply a reference-only package to staging.hicad.ng; Upload tab. *Gate:* login data untouched; signature, sequence and duplicate checks refuse bad files.
4. **M3 — Publish one month on staging.** Month package → prepared → Go live for one database; Overview, Runs, Publications tabs. *Gate:* 20 sampled payslips match legacy line for line; Go live ≤ 60 s.
5. **M4 — Full package + full-size test.** Full package with agreed history years for all six databases; Reconciliation tab; month publish at full size on staging. *Gate:* totals match; machine time ≤ 15 min.
6. **M5 — Production, parallel run.** All six databases on nncpo.ng for one payroll cycle alongside the current process, following the real media procedure. *Gate:* zero mismatches; machine time ≤ 15 min.
7. **M6 — Cutover.** Office moves to the new MySQL payroll; export moves into the payroll app's Export for web section. *Gate:* first month after cutover reconciles clean within 15 min.
8. **M7 — Phase 2.** Changes for payroll list, printable sheet, auto-close from packages.
