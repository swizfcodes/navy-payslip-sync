# Performance: the 15-minute target

## Targets

The payroll network is offline, so a publish has a human step in the middle: carrying the package out on approved media. The 15 minutes covers the **machine time**. Carrying time is recorded but not counted.

| Measure | Target |
|---|---|
| Export, all six databases (inside) | ≤ 4 min |
| Upload + verify + load + validate (outside) | ≤ 10 min |
| Go live | ≤ 60 s |
| **Total machine time** | **≤ 15 min** |
| Staff payslip views during a publish | no slower than today; no errors |

Upload time is set by package size and the link of the PC doing the upload: `minutes ≈ package MB × 8 ÷ link Mbps ÷ 60`. A 100 MB package takes about 1.5 min at 10 Mbps upload. Package size is measured in M1, so keeping the package small is a core goal.

## What would make it slow, and the fix for each

| Slow part | Fix |
|---|---|
| A big package | Only what the month needs: one period of IPPIS, only the new `py_payhistory` month columns (not the year), payroll columns only of `hr_employees`; lookups skipped on the website if unchanged; batches stored column by column and brotli-compressed with a 16 MB window (0.1.3; was row-by-row gzip) |
| One database after another | Exporter reads six databases in parallel and streams them into one file |
| Read all, then write | Streaming: read → encode → compress → encrypt → write overlap (one batch compresses in the zlib thread pool while the next is read); nothing held whole in memory |
| A dropped upload starting over | Chunked, resumable upload (8 MB chunks); only missing chunks are re-sent |
| Waiting for the whole upload before work starts | The website verifies the header before the upload, and begins unpacking as soon as the file is complete; batches are loaded as they are read |
| Row-by-row inserts | Multi-row `INSERT` (2,000–5,000 rows each, sized under `max_allowed_packet`), rows in primary-key order; `local_infile` is OFF |
| Index upkeep during load | Stage tables with primary key only; secondary indexes added in one `ALTER TABLE` after load |
| Copying into live tables | `RENAME TABLE` swap, instant at any size, one statement for all six databases |
| Locking staff out | Scoped and merge writes in chunks of 10,000 keys, short transactions |
| Slow checks | Counts and checksums computed while loading; totals one `SUM` per database |
| Slow staff views (today) | Missing indexes fixed before M1 (see "Findings so far" below) |

## The biggest lever: everything before Go live is invisible

Upload, load and validation all happen while the month is hidden. Go live is a single `RENAME TABLE` plus one row per database in `sync_publications`. So even if an upload is slow, staff are never affected, and the moment of switching on stays under a minute.

## Time budget (machine time)

| Step | Where | Budget |
|---|---|---|
| Read + pack all six databases | Inside | ≤ 4 min |
| Upload | Outside | ≤ 5 min (depends on link; measured in M1) |
| Verify signature and decrypt (streamed) | Website | ≤ 30 s |
| Load stage + scoped / merge applies | Website | ≤ 3 min |
| Validate | Website | ≤ 1 min |
| Go live | Website | ≤ 1 min |
| **Total** | | **≤ 15 min** |

These are targets, not measurements. M1 replaces them with real numbers.

## Measure first (M1 gate)

The exporter has a **dry run** mode: it reads and packs everything, reports timings and package size, and writes a test package. The test package is uploaded to staging to time the outside half. Gate: projected total ≤ 10 min of machine time (5 min margin).

1. **Rows, raw size and packed size per table per database**, and export time — from the dry run.
2. **Upload speed** of the PC and link the sync officer will really use — from uploading the test package.
3. **Indexes on the website DB** — see "Findings so far"; fixes applied before M1.
4. **Host settings** — `local_infile` is OFF (checked). Check `max_allowed_packet` and that `sync_writer` can run `RENAME TABLE`.
5. **Triggers and foreign keys** on manifest tables (they move with `RENAME TABLE`).
6. **Office read impact** — reads must not block payroll staff; export after calculation is closed for the month.

## Findings so far (2026-10-21, one database)

| Check | Result | Consequence |
|---|---|---|
| `py_payhistory` keys | Primary key `(his_empno, his_year, his_type)` | Column merge works as designed |
| `py_masterpayded` keys | Primary key `(his_Empno, his_type)`; `uk_empno_type` is an exact duplicate of it; plus `idx_masterpayded_empno_payind`, `idx_masterpayded_amount`, `idx_masterpayded_type_amount` | Every row loaded updates 5 indexes. Drop the duplicate |
| `py_mastercum` keys | Primary key `(his_Empno, his_type)`; `uk_empno_type` and `idx_mastercum_empno_type` are both exact duplicates of it | Every row loaded updates the same index 3 times. Drop both duplicates |
| `py_ipis_payhistory` keys | **None, not even a primary key** | Every staff payslip view scans the whole table; the period replace and the IPPIS import scan it too. Must be fixed before M1 |
| `py_webpayslip` keys | **None** | Every staff payslip view scans the whole table twice (delete + select), and the table grows with every view. Slows staff today, and will get worse under 30k users. Must be fixed before M1 |
| `local_infile` | OFF | Loader uses multi-row `INSERT` by default |
| Data size | About 423 employees in this database | Too small to time with. The M1 dry run must use production-size data |

None of the index names above are referenced in the code (no `FORCE INDEX` / `USE INDEX`), so dropping duplicates is safe.

### Index fixes to apply before M1 (all six databases, test on staging first)

```sql
-- 1. py_ipis_payhistory: natural primary key (period, numb, Type)
--    Rows are then stored grouped by period, so the payslip procedure (period + numb),
--    the IPPIS import lookup (numb, type, period) and the sync period replace all read one contiguous range.
--    First make sure no duplicates exist (must return 0 rows):
SELECT period, numb, Type, COUNT(*) AS c
FROM py_ipis_payhistory
GROUP BY period, numb, Type
HAVING c > 1
LIMIT 20;
--    Then:
ALTER TABLE py_ipis_payhistory ADD PRIMARY KEY (period, numb, Type);

-- 2. py_webpayslip: serves the delete and select on every staff view
ALTER TABLE py_webpayslip ADD INDEX idx_webpayslip_ws_ord_desc (work_station, ord, desc1);

-- 3. Remove exact duplicates of the primary key
ALTER TABLE py_masterpayded DROP INDEX uk_empno_type;
ALTER TABLE py_mastercum DROP INDEX uk_empno_type, DROP INDEX idx_mastercum_empno_type;
```

Notes:

- `py_ipis_payhistory` has no `id` column (checked with `SHOW CREATE TABLE`), so the natural key `(period, numb, Type)` becomes the primary key. If the duplicate check returns rows, decide which row wins before adding the key (the payslip procedure currently takes `MAX(bpm)`).
- Column names differ in case between tables (`his_Empno` vs `his_empno`). MySQL treats them as the same; the manifest matches column names case-insensitively.
- These go in as a normal migration in `config/sql/migrations/` when building starts.

## First real run (22 Oct 2026, HP EliteBook 845 G8, SQL Server on the same laptop)

Full package, `officers` (master) only, before the changes below:

| Table | Rows | Time |
|---|---|---|
| `py_payhistory` (all years) | 918,384 | 2 min 55 s |
| `py_masterpayded` | 483,414 | 26 s |
| `py_ipis_payhistory` | 545,681 | 8 s |
| `hr_employees` | 54,348 | 1 s |
| Others | small | 0 s |
| **Total** | | **3 min 32 s, 55 MB** |

- Throughput was about 0.35–0.6 million values per second in every big table: the work is per value in Node (one CPU core), not SQL Server alone.
- The other five databases hold about 2 million `py_payhistory` rows each, so a Full package of all six in one process would take well over 20 minutes.
- The master `hr_employees` has 54,348 staff; `officers` paid 4,357 in 2026-09 (net 3,041,747,294.93).

Changes made the same day (v0.1.1):

1. One process per database (`useProcesses`), so the six databases use separate CPU cores.
2. No `ORDER BY` unless an index starts with the key column, so SQL Server does not sort big tables.
3. Month packages send only closed `py_payhistory` months of the current year (normally one month group), never the whole year or the current month.

Still to measure: a Month dry run with all six databases (the 15-minute check) and a Full dry run with all six (expected well under the single-process figure). The payroll server's own hardware will differ from this laptop.

## If measurements say it is still too slow (tier 2)

- **Smaller packages for `py_masterpayded`:** send only employees whose lines changed since `baseSeq`; the website builds the stage table as a local copy of live (fast, same server) and applies the changes.
- Stronger compression (zstd) if upload dominates.
- Partition `py_ipis_payhistory` by period so a period replace becomes a partition exchange.
- Split very large months into one package per database so uploads can run from two PCs.

## Proving it every month

- The package carries the exporter's timings; the website adds its own. The Console shows one timing bar per publish, export to Go live, and marks machine time over 15 min in red.
- M4 runs a full-size export, upload and publish of all six databases on staging before production.
