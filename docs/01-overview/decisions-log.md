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
