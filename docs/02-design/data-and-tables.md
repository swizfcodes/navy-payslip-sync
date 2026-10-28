# Data and tables

Every synced table has one owner, and only the owner writes it. The list lives in `shared/manifest.js`; this page explains it.


Every synced table has one owner, and only the owner writes it. This list becomes `shared/manifest.js` in the `navy-payslip-sync` repo.

Modes:

- **swap** — a full copy is loaded into `<table>__stage`, then exchanged with live by `RENAME TABLE` (instant, atomic). The old copy becomes `<table>__prev`.
- **replace-scope** — only the rows of one period are replaced.
- **merge-columns** — rows matched by key; only the listed columns written; new keys inserted; nothing deleted.
- **never** — not synced.

What one month's package holds, per payroll database:

| Table | Mode | Key / scope | In the package | Applied at |
|---|---|---|---|---|
| `ac_months`, `py_elementtype`, `py_bank`, `py_pfa`, `ac_businessline`, `ac_costcentre` (master `hicaddata` only) | swap | whole table | Full table (small) | Prepare, skipped if unchanged |
| `hr_employees` (payroll columns only) | merge-columns | `EMPL_ID` | **Master (`officers`) only.** Payroll columns for all staff (narrow; compresses well) | Prepare |
| `py_ipis_payhistory` | replace-scope | `period` | Rows of the period. **Optional:** skipped where the source database has no IPPIS table | Prepare |
| `py_payhistory` | merge-columns | `his_empno, his_year, his_type` | Only month column groups **closed** since the previous package (normally one); never the current month, which is read from `py_masterpayded`; only rows of that year | Prepare |
| `py_masterpayded`, `py_mastercum` | swap | whole table | Full table | Loaded in Prepare, switched at Go live |
| `py_stdrate` | swap | whole table | Full table | Switched at Go live |
| `py_payrollclass` | swap | whole table, master DB | Full table | Prepare |

`hr_employees` payroll columns: `Surname`, `othername`, `Title`, `gradelevel`, `bankcode`, `BankACNumber`, `pfacode`, `nsitfcode`, `factory`, `location`, `payrollclass`, `dateleft`. Final list per decision in [Open questions](../01-overview/open-questions-and-known-issues.md).

Each table is written to the website database it came from (`officers` = master `hicaddata`). `hr_employees` and `py_payrollclass` exist only in the master. See [Website contract](../03-reference/website-contract.md).

Website-owned, never in a package: login and security columns of `hr_employees`, emolument tables (`ef_*`), notifications, audit, roles, `py_webpayslip`.

**Full copy.** A **full package** holds every manifest table, every period and year, for the chosen databases. Used for the first load, after a restore, or when a package was lost. A full copy website → payroll network is not offered (it would mean bringing data in).

## Rollback per mode

| Mode | Rollback | How |
|---|---|---|
| swap | `prev-table` | The old copy is kept as `<table>__prev`; rollback swaps it back |
| merge-columns | `undo-snapshot` | Before applying, the rows about to change (sent columns only) go to `<table>__undo` and new keys to `<table>__undo_new`; rollback restores and deletes |
| replace-scope | `undo-snapshot` | Before applying, the period's rows go to `<table>__undo`; rollback puts them back |

Exact SQL: [Website contract](../03-reference/website-contract.md#apply-go-live-and-roll-back-website).

## Which database each table is written to

- Every table in a package is written to **the same website database it came from**: the batch's `database` field (`officers`, `wofficers`, `ratings`, `ratingsA`, `ratingsB`, `juniorTrainee`).
- `officers` is the master database (`hicaddata`). It holds `py_payrollclass` and `hr_employees` with every staff member; the class databases have neither (22 Oct, website and package agree).
- `py_ipis_payhistory` is optional per database (see the table above).
