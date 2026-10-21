# Test plan

## Automated tests (this repo)

Run with `npm test` (Node built-in test runner, no database needed).

| File | Covers |
|---|---|
| `test/package-roundtrip.test.js` | Write a package from parallel producers, verify, read back; a changed byte is refused; another exporter's key and an edited header are refused; only the website private key opens the payload; abort removes the partial file; approving a new exporter; sequence rules |
| `test/months.test.js` | `py_payhistory` month ranges across a year end; refusing a gap over a year; finding the month column groups |
| `test/setup-match.test.js` | Matching class names to databases; mapping suggestions from `py_payrollclass` |

Not covered by automated tests (needs a SQL Server): `sources/mssql-source.js`, `checks.js`, setup login creation and database discovery. These are checked on the first real run (Day 1).

## Test day on staging (24 Oct)

| # | Test | Owner | Pass when |
|---|---|---|---|
| 1 | Full package, all six databases: export → upload → Go live | A exports, B uploads | Status `live`; no errors |
| 2 | 20 sampled payslips vs legacy payslips (mix of databases, IPPIS and non-IPPIS staff) | Both | Every line and net pay match |
| 3 | Month package after the full one | A + B | Accepted (seq follows); prepared; Go live ≤ 60 s |
| 4 | Machine time of a month publish | B reads timing bar | ≤ 15 min (export + upload + load + Go live) |
| 5 | Staff payslip views during a load | B | No errors, no visible slowdown |
| 6 | Tampered file (one byte changed) | A | Refused: bad signature |
| 7 | Wrong order (skip a seq) | A | Refused: sequence gap |
| 8 | Same file twice | B | "Already received" |
| 9 | Upload cut halfway, then resume | B | Only missing chunks sent; completes |
| 10 | Roll back after Go live | B | Previous month shows again |
| 11 | Withdraw a period | B | Staff see "not ready yet" |
| 12 | Login data untouched | B | Passwords and reset tokens in `hr_employees` unchanged after load |
| 13 | Exporter on a machine without Node | A | `.exe` runs; no network access needed except the DB |

Anything failing 1–5, 6–8 or 12 blocks production. 9–11 and 13 can be fixed after.
