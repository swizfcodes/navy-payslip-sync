# Architecture

Data leaves the offline payroll network one way, as an encrypted, signed package file, and is uploaded to the website. The website never connects to the payroll network.

## The constraint: the payroll network is offline on purpose

The office payroll server has no internet connection, as a security measure. Sync must keep it that way. So data leaves the payroll network **one way, as an encrypted file**, and nothing comes back in.

- No machine is connected to the payroll network and the internet at the same time.
- No inbound files or connections to the payroll network (Phase 2 included, see "Website → payroll changes" below).
- The only thing ever brought in is the exporter software, once, through the approved media process.

## Components

```
 OFFLINE PAYROLL NETWORK                 │  INTERNET
                                         │
┌─────────────────────────────┐          │          ┌──────────────────────────────┐
│ Office payroll DB           │          │          │ Website (nncpo.ng)           │
│ legacy MSSQL now,           │          │          │                              │
│ new MySQL after cutover     │          │          │  Sync Console                │
└──────────────┬──────────────┘          │          │  upload, check, go live      │
               │ read-only               │          │            │                 │
┌──────────────▼──────────────┐          │          │  Sync Import (/api/sync)     │
│ Sync Exporter               │  package │  upload  │  verify, decrypt, stage,     │
│ reads manifest tables,      │──▶ file ─┼─────────▶│  validate, swap              │
│ writes one encrypted,       │ (approved│ (any     │            │                 │
│ signed .npsync file         │  media)  │  online  │  Website MySQL               │
└─────────────────────────────┘          │  PC)     │  same tables + sync_*        │
                                         │          └──────────────────────────────┘
          data only moves left to right ─┼─▶
```

| Part | Runs on | Job |
|---|---|---|
| Office payroll DB | Payroll server (offline) | Where payroll is calculated |
| Sync Exporter | Payroll server or a payroll-network PC (offline) | Reads manifest tables with a read-only login, writes one package file per export |
| Package file (`.npsync`) | Approved removable media | Encrypted so only the website can open it; signed so the website knows which exporter made it |
| Sync Console | Website admin section, any online PC | Upload the package (resumable), see checks, Go live, withdraw, roll back |
| Sync Import | Website, `/api/sync` | Verifies signature and sequence, decrypts, loads stage tables, validates, swaps |
| Website MySQL | Website | Same payroll databases and tables as today, plus `sync_*` control tables |

Exporter form by phase:

- **Phase 1 (legacy MSSQL):** a standalone Windows command-line program, `navy-sync-exporter.exe` (Node single executable, no install of Node needed), with three screens: Connect, Export, Done. Built from the separate `navy-payslip-sync` repo and brought in once per version through the approved media process.
- **Phase 2 (new MySQL payroll):** the same exporter code as an **Export for web** section inside NAVY-PAYROLL on the payroll server. Nothing extra to install.

## Flows

### Publish a month: Export → Upload → Go live

**Export (inside, payroll officer):**

1. Open the exporter. Step 1, **Connect:** pick the saved read-only connection (or enter it), test it.
2. Step 2, **Export:** pick period and databases (default: current period, all six). The exporter reads all six databases in parallel and writes one file, e.g. `NAVY_202610_seq0042.npsync`, to the chosen drive.
3. It shows the file's sequence number, size and a short fingerprint (first 12 characters of its hash). The officer records these in the media log.

**Upload (outside, sync officer):**

4. In the Sync Console, **Upload package**. Upload is chunked and resumes after a dropped connection.
5. The website checks the signature (a registered exporter), the fingerprint, and that the sequence number follows the last one applied. Then it decrypts and loads: scoped and merge data in short chunked transactions; swap tables into `__stage`.
6. It validates row counts, checksums and totals per database. Pass → `prepared`, with a summary on screen (staff count, total net per database). Fail → `failed`, nothing visible changed.

**Go live (outside, ≤ 60 s):**

7. Click **Go live** (manual in this delivery; automatic Go live comes later as a setting). Old `__prev` copies are dropped, then one `RENAME TABLE` swaps `py_masterpayded`, `py_mastercum` and `py_stdrate`. Each database switches atomically; all six go in one statement when they share a MySQL server. The period is marked `published`.

Why applying scoped data at Prepare is safe: the new period's IPPIS rows and `py_payhistory` month columns are not read for any visible period until `py_stdrate` moves at Go live.

### Sequence numbers and lost packages

- Every package carries `seq` (its number) and `baseSeq` (the package it builds on).
- The website accepts a package only if `baseSeq` equals the last applied `seq` (or the package is full).
- A package that was never uploaded leaves a gap. The next package is refused with a clear message; the officer exports a **full** package (or re-uploads the missing one).
- Duplicate uploads (same fingerprint) are ignored.

### Between monthly publishes

There is no nightly refresh: the payroll network cannot call out. New staff, promotions and bank changes reach the website with the next package. If a mid-month update is needed, the officer exports a **reference-only** package (lookups + `hr_employees`), which goes through the same upload and needs no Go live.

### Website → payroll changes (Phase 2), without bringing files in

1. Staff changes approved on the website (for example a new bank account) are listed in the Console as **Changes awaiting payroll**, printable as a signed-off sheet.
2. Payroll staff apply them through the normal payroll screens, under normal payroll controls.
3. When the next package shows the new value, the website marks the change `done` automatically. Values that differ are flagged for follow-up.

A data import file into the payroll network is not part of the design. If ever wanted, it needs security sign-off first.

### Withdraw and roll back

- **Withdraw:** hides the period ("not ready yet") until published again.
- **Roll back** (latest live run only): one `RENAME TABLE` swaps the `__prev` copies back, and the undo snapshots taken at Prepare restore `hr_employees`, `py_payhistory` and the period's IPPIS rows. Afterwards the officer inside runs `--discard-last` before the next export. Exact statements: [Website contract](../03-reference/website-contract.md#apply-go-live-and-roll-back-website).

## How the website builds a payslip today

The sync exists to keep these tables filled; the page itself does not change. Details of the tables: [Data and tables](data-and-tables.md).


The payslip page builds payslips from raw payroll tables on demand, so the website needs those tables, not finished payslips.

How a staff payslip is produced (`routes/user-dashboard/payslips/userpayslip.js`):

1. Look up the staff member's `payrollclass` in `hr_employees` (master database `hicaddata`).
2. Map the class to its payroll database: officers, wofficers, ratings, ratingsA, ratingsB or juniorTrainee.
3. Read the current period from `py_stdrate` (row `type = 'BT05'`).
4. For the current period, require IPPIS rows in `py_ipis_payhistory`; otherwise answer "not ready yet".
5. Call `py_generate_combined_payslip`, which writes lines into `py_webpayslip` for that user.
6. Read `py_webpayslip`, map the rows, render the PDF from `templates/user-payslip.html`.

What the stored procedure reads:

| Table | Used for |
|---|---|
| `hr_employees` | Name, title, grade, bank, PFA, NSITF, factory, location, date left |
| `ac_months` | Month name |
| `py_stdrate` | Current month (BT05) |
| `ac_businessline`, `ac_costcentre`, `py_bank`, `py_pfa` | Lookup names |
| `py_ipis_payhistory` | IPPIS lines for the period |
| `py_masterpayded`, `py_mastercum`, `py_elementtype` | Current month's own (NAVY) lines |
| `py_payhistory` | Past months' own lines (one row per staff + pay type per year, 12 month columns) |

Other facts that shape the design:

- The app runs on MySQL or MSSQL through `config/db-config.js` and `config/adapters/`. Table names are the same on both (see `migratedata.js`).
- `py_webpayslip` is scratch space, rebuilt on every view. It is never synced.
- `hr_employees` also holds login data (passwords, reset tokens) from the unified login work. That data belongs to the website.
- Admin bulk payslips (`adminpayslip.js`) and consolidated payslips (`controllers/utilities/consolidatedPayslip.js`) use the same procedure and tables.
