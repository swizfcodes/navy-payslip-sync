# Open questions and known issues

## Open questions

| # | Question | Who answers | Blocks |
|---|---|---|---|
| 1 | Security sign-off on the export procedure: approved media, who may export, who may upload, which machine runs the exporter | Client security team | Production |
| 2 | Which `hr_employees` columns does the website change (email, phone, bank)? Those leave the exporter's column list | Client + Dev B | Production (default list used for the test) |
| 3 | Is approval needed before a month is uploaded? | Client payroll | Production procedure |
| 4 | How many years of payslip history must be reprintable? | Client | Full package size (measured by the Day 2 full dry run) |
| 5 | Are all six website databases on one MySQL server (staging and production)? | Dev B | How Go live is batched |
| 6 | Does `hicaddata.hr_employees` hold every staff member? | Dev B | Login and payslip lookup |
| 7 | Which PC and connection will the sync officer upload from? | Client | Upload time in the 15-minute budget |
| 8 | Do legacy column names and types match the website's (for example `his_type` in `py_mastercum`)? | Dev A, first real run | Export |
| 9 | Phase 2 scope: which website changes go back to payroll? | Client | Phase 2 only |

## Known issues in NAVY-PAYROLL (found while planning)

| Issue | Where | Effect | Fix |
|---|---|---|---|
| "Current period" compares month only, not year | `py_generate_combined_payslip` | Asking for Oct 2025 while Oct 2026 is current shows this month's figures labelled 2025 | Also compare the year with `py_stdrate.ord` |
| No index at all on `py_ipis_payhistory` (no primary key, no `id` column) | Website DB | Every staff payslip view scans the table | Primary key `(period, numb, Type)` after a duplicate check |
| No index on `py_webpayslip` | Website DB | Every view scans it twice; it grows with every view | Index `(work_station, ord, desc1)` |
| Duplicate indexes on `py_masterpayded` (`uk_empno_type`) and `py_mastercum` (`uk_empno_type`, `idx_mastercum_empno_type`) | Website DB | Slower writes and loads | Drop them (not referenced in code) |
| IPPIS import selects `id` and sets `updated_at`, which the table does not have | `routes/utilities/ippis-payment.js` | Every uploaded record fails on this schema | One `INSERT … ON DUPLICATE KEY UPDATE` once the primary key exists |
| `sa` login and password written in the file | `migratedata.js` | Credentials in the git repo | Move to `.env`, change the password |
| BT05 read and procedure call use `pool.query` after `USE` ran on `conn` | `userpayslip.js` | May run against the wrong database | Confirm the routing, or run both on `conn` |
| Unpublished months are visible if data is present | `userpayslip.js` | Unapproved months could show | Check `sync_publications` first |

Details and SQL: [Performance](../02-design/performance.md), "Findings so far" and "Index fixes".

## Known limits of the exporter (v0.1.0)

- Not yet run against the legacy SQL Server; the setup SQL (login creation, database discovery) is untested on a real server.
- Passwords are typed each run (no saved password).
- Phase 2 MySQL source is not written yet.
- Database matching in setup is a suggestion from `py_payrollclass` and names; the officer confirms it.
