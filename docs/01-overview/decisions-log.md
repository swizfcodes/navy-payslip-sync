# Decisions log

Newest last. Each line says what was decided and why. Change a decision by adding a new line, not by editing an old one.

| # | Date | Decision | Why |
|---|---|---|---|
| 1 | 19 Oct 2026 | Every synced table has one owner; only the owner writes it. Payroll data flows office → website. Website changes reach payroll only as approved requests | Avoids two sides fighting over the same rows; no conflict resolution needed |
| 2 | 19 Oct 2026 | The website never connects to the office database | Security, and it keeps the website independent of which payroll system the office runs |
| 3 | 19 Oct 2026 | Keep the website's existing payslip tables and `py_generate_combined_payslip`; sync the tables the procedure reads, not finished payslips | The payslip page, PDF and consolidated payslips keep working unchanged |
| 4 | 19 Oct 2026 | `py_webpayslip` is never synced | It is scratch space rebuilt on every view |
| 5 | 21 Oct 2026 | Target: ≤ 15 min of machine time to publish all six databases; Go live of a prepared month ≤ 60 s | Business requirement |
| 6 | 21 Oct 2026 | Publish is split into Prepare (heavy, invisible) and Go live (one `RENAME TABLE`) | Keeps the visible switch instant whatever the upload time |
| 7 | 21 Oct 2026 | Send only what changed: one period of IPPIS, only new `py_payhistory` month columns, payroll columns of `hr_employees`, lookups only if changed | Package size drives upload time |
| 8 | 21 Oct 2026 | The payroll network stays offline. Data leaves one way, as an encrypted, signed file on approved media. No machine bridges the two networks | The office network is offline as a security measure |
| 9 | 21 Oct 2026 | Website → payroll changes (Phase 2) travel as a printed list keyed in by payroll staff, never as a file brought in | Nothing enters the offline network except the exporter program itself |
| 10 | 21 Oct 2026 | Two repos: this one (exporter + shared library) and NAVY-PAYROLL (website) | Small repo for security review; separate releases; no website code near the offline machine |
| 11 | 21 Oct 2026 | Exporter is a command-line `.exe` (Node single executable). No Electron, no local web page | Smallest thing to review and approve; no open ports |
| 12 | 21 Oct 2026 | Exporter uses pure-JavaScript dependencies only | Required for the single-`.exe` build |
| 13 | 21 Oct 2026 | Encryption: AES-256-GCM payload; X25519 + HKDF-SHA256 key agreement (fresh key per package); Ed25519 signature over the header | Only the website can read a package; the website knows which exporter made it; any changed byte is detected |
| 14 | 21 Oct 2026 | Package writer and reader live in the shared library | The website gets ready-made `verifyPackage()` / `readRecords()`; one implementation on both sides |
| 15 | 21 Oct 2026 | The package manifest is written at the end of the file | Row counts are only known after reading |
| 16 | 21 Oct 2026 | Sequence numbers: a month package must build on the last applied package; otherwise a full package is needed. `--discard-last` marks a package that was never uploaded | Prevents silent gaps |
| 17 | 21 Oct 2026 | Rollback covers every table: swap tables keep `__prev`; merge and replace-scope tables get an `__undo` snapshot at Prepare. Only the latest live run can be rolled back | Names and bank details must go back too |
| 18 | 21 Oct 2026 | Go live: drop old `__prev`, then one `RENAME TABLE`. Rollback: three-way swap through `__rb` | `RENAME` fails if the target exists; a swap can itself be reversed |
| 19 | 21 Oct 2026 | Atomic switch is required per database; all six in one statement only if they share a MySQL server | Each staff member reads one database |
| 20 | 21 Oct 2026 | Each table is written to the database it came from; `officers` is the master `hicaddata` | Matches how the payslip page and procedure read `hr_employees` |
| 21 | 21 Oct 2026 | Go live is manual (sync role) in this delivery; automatic Go live later, off by default | Human check before staff see a month |
| 22 | 21 Oct 2026 | The full package carries every year in the source; the full dry run measures it; the client may set a cut-off year | Unknown history size |
| 23 | 21 Oct 2026 | Exporter setup creates the read-only login (admin login typed once, never saved) and finds and maps the databases itself | Fewer manual steps for the officer and DBA |
| 24 | 21 Oct 2026 | The exporter's public key travels inside every package; a super admin approves a new exporter by comparing its key id with the exporter's screen | No key files carried by hand |
| 25 | 21 Oct 2026 | Index fixes on the website DB before M1: primary key on `py_ipis_payhistory`, index on `py_webpayslip`, drop duplicate indexes | Staff payslip views and loads were scanning whole tables |
| 26 | 22 Oct 2026 | A month package sends only `py_payhistory` months **closed** since the previous package (previous package's month up to the month before this one; normally one month group). The current month is never sent | The payslip procedure reads the current month from `py_masterpayded`; the current column is not final until month-end. Halves that table in every month package |
| 27 | 22 Oct 2026 | The exporter runs each database in its own process (`useProcesses`, default on), up to `concurrency` at once | One Node process uses one CPU core; the first real run was CPU-bound in Node, not in SQL Server |
| 28 | 22 Oct 2026 | Ask SQL Server for key order only when an index starts with the key column | A full sort of a big table costs minutes and the website does not need the order |
| 29 | 22 Oct 2026 | A Full package is not held to the 15-minute target; the monthly publish is | Full is for the first load and recovery only |
| 30 | 22 Oct 2026 | `hr_employees` is sent only from the master (`officers` = `hicaddata`), with every staff member | On the website it exists only in `hicaddata`; class databases have none. The master is the truth |
| 31 | 22 Oct 2026 | `py_ipis_payhistory` is optional per database: skipped if the source has no such table | juniorTrainee (`hicaddata5`) has none on the website |
| 32 | 22 Oct 2026 | Setup recognises a payroll database by `py_stdrate` and `py_masterpayded` (`py_elementtype` is still checked at Connect) | Class databases have no `hr_employees`, so the old rule only found the master; `py_masterpayded` exists only in real payroll databases |
| 33 | 27 Oct 2026 | Batch version 2: rows stored column by column, brotli quality 9 with a 16 MB window, 10,000 rows per batch; version 1 (gzip) still read. The website must run library 0.1.3 before it receives a 0.1.3 package | Officers Full was 51–55 MB with gzip; the goal is all six databases under 100 MB. gzip only looked 32 KB back; payroll columns repeat across a whole batch |
| 34 | 27 Oct 2026 | Each class database is found by `py_payrollclass.classcode` (officers 1, wofficers 2, ratings 3, ratingsA 4, ratingsB 5, juniorTrainee 6; `manifest.DATABASE_CLASSCODES`) and its `db_name`, on the website and in exporter setup. Only the master (`hicaddata`) comes from settings | The website reads classes from `py_payrollclass` everywhere else; class names differ between systems (RATE A / Ratings) |
| 35 | 27 Oct 2026 | Brotli quality by package kind: Full 9 (`packQuality`), Month 6 (`packQualityMonth`) | Full: officers 28 MB in 1 min 2 s with quality 9 (was 55 MB, 3 min 31 s). Month packages must stay fast |
| 36 | 27 Oct 2026 | A Month export checks `py_ipis_payhistory` for the period in every database and, if any has none, warns and asks to continue (default No). Full is not checked; a database without the table is only noted | IPPIS is part of every payslip; the website refuses current-period payslips without it |
| 37 | 27 Oct 2026 | `ac_months`, `py_bank`, `py_pfa`, `ac_businessline`, `ac_costcentre` are master only, like `hr_employees` and `py_payrollclass`: exported from `officers` only and not required in class databases. `py_elementtype` stays per database | They exist only in `hicaddata` (legacy and website `MASTER_TABLES`); the class databases failed Connect without them |
| 38 | 28 Oct 2026 | Exporter watchdog: a database with no activity for `stallSeconds` (default 180) stops the attempt and the export starts again once on a fresh connection; reads give up on locks after 2 min (`SET LOCK_TIMEOUT`); every run is logged to `export-log.txt` in the state folder | First export on a new machine froze until cancelled and run again; cause not reproduced (antivirus first-run scan, console QuickEdit pause or a lock are likely) |
