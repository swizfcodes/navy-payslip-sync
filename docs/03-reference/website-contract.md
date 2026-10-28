# Website contract

What the website (NAVY-PAYROLL, Dev B) implements, and how it uses the shared library. The file format itself: [Package format](package-format.md). The functions: [Shared library API](shared-api.md).

## Website API (`/api/sync`, logged in, sync role)

Upload (resumable, 8 MB chunks):

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/packages` | header JSON (read by the browser from the file's first bytes), total bytes | `fingerprint`, chunks already held (for resume), or a refusal (unknown exporter, bad signature, seq gap, duplicate) |
| PUT | `/packages/:fingerprint/chunks/:n` | raw bytes | ok |
| POST | `/packages/:fingerprint/complete` | — | `received` → processing starts; returns run id |

Console:

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | Last package per exporter, last applied seq, per database: published and prepared period |
| GET | `/runs`, `/runs/:runId` | Run list and detail: per table counts, checks, stage timings |
| POST | `/golive` | `{period}`: one atomic switch for every prepared database |
| GET | `/publications` | Prepared / published / withdrawn periods |
| POST | `/publications/:db/:period/withdraw` | Hide a period |
| POST | `/publications/:db/:period/rollback` | Put back `__prev` tables |
| GET | `/reconciliation?db=&period=` | Package totals vs website totals |
| GET | `/exporters` | Approved exporters (id, key id, approved by, when) |
| POST | `/exporters/approve` | `{fingerprint}` of an uploaded package from an unknown exporter: stores its key after a super admin confirms the key id (see "Approving a new exporter" below) |
| GET | `/changes` | Phase 2: changes awaiting payroll, printable |

## Control tables (website, master DB `hicaddata`)

| Table | One row per | Key columns |
|---|---|---|
| `sync_exporters` | Registered exporter | `exporter_id`, `name`, `public_key` (Ed25519), `registered_by`, `registered_at`, `active` |
| `sync_packages` | Uploaded package | `fingerprint` (unique), `exporter_id`, `seq`, `base_seq`, `kind` (month / reference / full), `period`, `databases`, `bytes`, `uploaded_by`, `upload_started_at`, `upload_finished_at`, `status` (uploading / received / rejected / applied), `reject_reason` |
| `sync_upload_chunks` | Received chunk (temporary) | `fingerprint`, `chunk_no`, `bytes`, `received_at` |
| `sync_runs` | Processing of one package | `run_uuid`, `package_id`, `status`, `started_at`, `finished_at`, `error`, `summary` JSON (counts + stage timings incl. the exporter's) |
| `sync_table_state` | Table + scope last applied | `database_name`, `table_name`, `scope`, `last_run_id`, `row_count`, `table_hash`, `applied_at` |
| `sync_publications` | Database + period | `database_name`, `period`, `status` (prepared / published / withdrawn), `staff_count`, `total_net`, `package_id`, `published_by`, `published_at`, `withdrawn_by`, `withdrawn_at` |
| `sync_changes` | Phase 2 change awaiting payroll | `change_uuid`, `database_name`, `empl_id`, `column_name`, `old_value`, `new_value`, `approved_by`, `status` (awaiting / done / differs), `closed_by_package` |

Run statuses: `received` → `verifying` → `loading` → `validating` → `prepared` → `live`, or `failed`.

## Sequence rules

- Accept when `baseSeq` = last applied `seq`, or `kind` = `full`.
- Refuse `seq` ≤ last applied (old or replayed file).
- Same fingerprint twice → "already received".

## Run statuses and timings

`received` → `verifying` → `loading` → `validating` → `prepared` → `live`; `failed` from any step.

`sync_runs.summary` timing keys (ms): exporter side `export`, website side `upload`, `verify`, `load`, `apply`, `validate`, `golive`.

## Apply, Go live and roll back (website)

Agreed at the contract freeze. `navy-payslip-sync` `shared/manifest.js` gives each table's `mode`, `applyAt` and `rollback`; `goliveTables(kind)` lists what Go live swaps.

**Every table goes through a stage table.** `DROP TABLE IF EXISTS <db>.<t>__stage; CREATE TABLE <db>.<t>__stage LIKE <db>.<t>;` then batches are loaded into it. Stage tables keep only the primary key while loading.

**Prepare, merge-columns** (`hr_employees`, `py_payhistory` in month packages), per database, in this order:

1. `DROP TABLE IF EXISTS <t>__undo, <t>__undo_new;`
2. Undo snapshot of rows about to change, sent columns only: `CREATE TABLE <t>__undo AS SELECT <key + sent columns> FROM <t> JOIN <t>__stage USING (<key>);`
3. Keys that are new: `CREATE TABLE <t>__undo_new AS SELECT <key> FROM <t>__stage LEFT JOIN <t> USING (<key>) WHERE <t>.<first key> IS NULL;`
4. Apply in chunks of 10,000 keys: `INSERT INTO <t> (<key + sent>) SELECT … FROM <t>__stage … ON DUPLICATE KEY UPDATE <col> = VALUES(<col>), …;`

**Prepare, replace-scope** (`py_ipis_payhistory` in month packages):

1. `DROP TABLE IF EXISTS <t>__undo; CREATE TABLE <t>__undo AS SELECT * FROM <t> WHERE period = ?;`
2. In one transaction: `DELETE FROM <t> WHERE period = ?; INSERT INTO <t> SELECT * FROM <t>__stage;`

**Prepare, swap at prepare** (lookups in month packages): same as Go live below, run during Prepare.

**Go live** (swap tables with `applyAt: golive`):

```sql
SET SESSION lock_wait_timeout = 30;
DROP TABLE IF EXISTS db.py_masterpayded__prev, db.py_mastercum__prev, db.py_stdrate__prev;   -- every database
RENAME TABLE
  db.py_masterpayded        TO db.py_masterpayded__prev,
  db.py_masterpayded__stage TO db.py_masterpayded,
  db.py_mastercum           TO db.py_mastercum__prev,
  db.py_mastercum__stage    TO db.py_mastercum,
  db.py_stdrate             TO db.py_stdrate__prev,
  db.py_stdrate__stage      TO db.py_stdrate;                                                   -- one statement
```

- What must be atomic is **each database on its own**: its three tables move together, so its staff never see the old month with new numbers. Each staff member only reads their own database, so the six databases do not have to switch in the same instant.
- If all six databases are on one MySQL server (to confirm on staging and production), put all of them in the one `RENAME TABLE`. If not, run one statement per server.
- `RENAME TABLE` fails if a target exists, hence the `DROP … __prev` first. It waits for running payslip queries on those tables (metadata lock); `lock_wait_timeout = 30` stops it hanging. On timeout, retry.
- Then write `sync_publications` rows (`published`).

**Roll back** (only the latest live run):

```sql
DROP TABLE IF EXISTS db.py_masterpayded__rb, db.py_mastercum__rb, db.py_stdrate__rb;
RENAME TABLE
  db.py_masterpayded TO db.py_masterpayded__rb, db.py_masterpayded__prev TO db.py_masterpayded, db.py_masterpayded__rb TO db.py_masterpayded__prev,
  db.py_mastercum    TO db.py_mastercum__rb,    db.py_mastercum__prev    TO db.py_mastercum,    db.py_mastercum__rb    TO db.py_mastercum__prev,
  db.py_stdrate      TO db.py_stdrate__rb,      db.py_stdrate__prev      TO db.py_stdrate,      db.py_stdrate__rb      TO db.py_stdrate__prev;
```

then, per database, in one transaction per table:

- merge-columns: `UPDATE <t> JOIN <t>__undo USING (<key>) SET <t>.<col> = <t>__undo.<col>, …;` and `DELETE <t> FROM <t> JOIN <t>__undo_new USING (<key>);`
- replace-scope: `DELETE FROM <t> WHERE period = ?; INSERT INTO <t> SELECT * FROM <t>__undo;`

The rename swaps rather than drops, so a rollback can itself be reversed. `__undo` tables live until the next Prepare. Rollback covers `hr_employees` too: changed names and bank details go back.

**After a rollback the sequence steps back.** The last applied seq returns to the package before. Inside the offline network the officer must run `navy-sync-exporter --discard-last` before the next export, so the next package builds on the right seq (otherwise the website refuses it with a sequence gap, and that is the safe outcome). The Console shows this instruction after a rollback.

## Which database each table is written to

- Every table in a package is written to **the same website database it came from**: the batch's `database` field (`officers`, `wofficers`, `ratings`, `ratingsA`, `ratingsB`, `juniorTrainee`).
- **Which database that is** comes from the website's `py_payrollclass`: the row with that database's classcode (`manifest.DATABASE_CLASSCODES`: officers 1, wofficers 2, ratings 3, ratingsA 4, ratingsB 5, juniorTrainee 6) gives `db_name`. Only the master (`officers` = `hicaddata`, where `py_payrollclass` lives) comes from settings. A class without a row cannot receive data (`unknown-database`); a class row with another classcode is shown in the Console as "not in packages".
- **Master only:** `hr_employees`, `py_payrollclass` and the shared lookups `ac_months`, `py_bank`, `py_pfa`, `ac_businessline`, `ac_costcentre` are sent only in the `officers` part (the master, `hicaddata`), with every staff member. On the website `hr_employees` exists only in `hicaddata` (54,358 staff on 22 Oct); the legacy master holds 54,348. The master is the truth. If a legacy class database has its own copy, it is not exported.
- **Optional:** `py_ipis_payhistory` is skipped for a database whose source has no such table (for example juniorTrainee, if the legacy database has none). The package then has no entry for it in that database. The website should still have the table (empty is fine), because the payslip procedure reads it.

## Approving a new exporter

No key files are carried by hand. The exporter's public key travels inside every package.

1. The sync officer uploads a package. `readHeader()` shows an `exporterId` that is not in `sync_exporters`.
2. The website calls `inspectNewExporter(file)` (shared/package-reader.js). It checks the file against the key it carries and returns `exporterId`, `keyIdFormatted` (e.g. `3F9C-1A2B-7D0E-55AA`) and `publicKeyPem`.
3. The Console shows "New exporter navy-payroll-office-01, key id 3F9C-1A2B-7D0E-55AA. Approve?" to a super admin only.
4. The super admin checks the key id against the one the exporter shows on screen (start-up line and Done step), read out by the payroll officer or written in the media log. Then approves.
5. The key is stored in `sync_exporters`. Processing continues with `verifyPackage(file, { exporterPublicKeyPem })`.

After approval, a package whose embedded key differs from the approved one is refused with `exporter-key-changed`. Replacing an exporter's key (new machine) is a deliberate super-admin action: deactivate the old one, approve the new one.

`scripts/sync-register-exporter.js` stays as a fallback (paste a key printed by `--show-key`).
