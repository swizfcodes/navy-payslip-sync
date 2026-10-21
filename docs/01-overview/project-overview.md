# Project overview

## What it does

Staff of the Nigerian Navy view and print their payslips on the website (nncpo.ng, about 30,000 users). Payroll is calculated on the office payroll server, on a network kept **offline as a security measure**. The project gets each month's payroll data from that offline network to the website, safely and quickly, so payslips are available as soon as the month is approved.

## The constraints

1. **The payroll network stays offline.** No machine is on it and on the internet at the same time. Data leaves only as a file on approved removable media. Nothing comes back in.
2. **Two payroll systems over time.** Today the office runs the legacy MSSQL payroll. Later it moves to the new MySQL payroll (NAVY-PAYROLL). The website must work in both phases without change.
3. **Same tables on both sides.** The website already builds payslips from raw payroll tables with the stored procedure `py_generate_combined_payslip`. We keep those tables and that procedure; we only keep them filled.
4. **15 minutes or less of machine time** to publish a month for all six payroll databases (exporting, uploading, loading, switching on). Carrying the media out is not counted.
5. **All or nothing.** Staff never see a half-loaded month. A month can be withdrawn or rolled back.

## How it works, in one paragraph

Inside the offline network, the payroll officer runs `navy-sync-exporter.exe`. It reads the payroll tables with a read-only login and writes one encrypted, signed **package** file (`.npsync`) to approved media. The file is carried out and uploaded in the website's **Sync Console**. The website checks who made the file and that no byte changed, decrypts it, loads it into holding tables while the month stays hidden, checks the totals, and on **Go live** switches the month on in one step.

## Phases

| Phase | Office side | Exporter | Website |
|---|---|---|---|
| 1 — transition (now) | Legacy MSSQL payroll | `navy-sync-exporter.exe`, reading MSSQL | NAVY-PAYROLL with the Sync Console |
| 2 — after cutover | New MySQL payroll (NAVY-PAYROLL on the office server) | The same code as an "Export for web" page inside the payroll app | Unchanged |

## The two code bases

| Repo | Contents | Owner |
|---|---|---|
| `navy-payslip-sync` (this repo) | The exporter, and the shared library: table list, package format, encryption, package reader | Dev A |
| `NAVY-PAYROLL` | The website side: upload, load, Go live, rollback, Sync Console | Dev B |

The website installs this repo as a dependency pinned to a tag and uses only its `shared/` part.

## The six payroll databases

`officers` (the master, `hicaddata`), `wofficers`, `ratings`, `ratingsA`, `ratingsB`, `juniorTrainee`. Each staff member's payslip comes from the database of their payroll class.

## Glossary

| Term | Meaning |
|---|---|
| Package | One `.npsync` file: one export, one period, normally all six databases |
| Exporter | The program inside the offline network that writes packages |
| Sync Console | The website admin page where packages are uploaded and months switched on |
| Period | Payroll month as `YYYYMM`, e.g. `202610`. The current period is the `BT05` row of `py_stdrate` |
| Month package | Normal monthly package: the month's data only |
| Full package | Everything: all tables, all periods and years. First load, or recovery |
| Dry run | A timing-test package. The website never applies it |
| seq / baseSeq | Package number, and the number of the package it builds on |
| Fingerprint | Short code of the file's hash, e.g. `9F3A-71C2-0B8E`, written in the media log and checked on upload |
| Key id | Short code of the exporter's public key, e.g. `3F9C-1A2B-7D0E-55AA`, checked when approving a new exporter |
| Prepare | Website loads and checks a package while the month is still hidden |
| Go live | Website switches the prepared month on, in one step per database |
| Stage / `__prev` / `__undo` tables | Holding copy being loaded / previous copy kept after Go live / pre-change snapshot for rollback |
| Swap, replace-scope, merge-columns | The three ways a table is applied (see [Data and tables](../02-design/data-and-tables.md)) |
