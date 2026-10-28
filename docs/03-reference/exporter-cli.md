# Exporter commands and files

## Commands

The built program is `navy-sync-exporter.exe`. During development, `npm run <script>` does the same.

| Command | npm script | What it does |
|---|---|---|
| `navy-sync-exporter.exe` | `npm run export` | First run: setup. Then Connect → Export (month or full) → Done |
| `--dry-run` | `npm run dry-run` | Same, choosing Month or Full, but writes a timing-test package the website never applies; prints rows, MB and time per table |
| `--setup` | — | Change the server or database mapping, or create the read-only login |
| `--show-key` | `npm run show-key` | Prints the exporter name, key id and public key |
| `--ledger` | `npm run ledger` | Lists packages exported from this machine |
| `--discard-last` | — | Marks the last package as never uploaded (lost, destroyed, or rolled back on the website) |
| `--help` | — | Usage |

On Windows the window waits for Enter before closing (set `NAVY_SYNC_NO_PAUSE=1` to skip).

## Files on the payroll machine

Folder: `%ProgramData%\navy-payslip-sync` (override with `NAVY_SYNC_HOME`). Never on the removable drive.

| File | Contents |
|---|---|
| `config.json` | Exporter name, server, read-only login name, database mapping, last output folder and operator, batch size, concurrency. **No passwords** |
| `exporter-private.pem` | The exporter's signing key. Never leaves the machine |
| `exporter-public.pem` | Its public key (also inside every package) |
| `ledger.json` | Every exported package: seq, baseSeq, kind, period, file, size, fingerprint, operator, time, discarded |

### `config.json`

```json
{
  "exporterId": "navy-payroll-office-01",
  "source": { "type": "mssql", "server": "HICAD-THREEONE\\SQL2022", "port": null, "user": "sync_reader",
              "encrypt": false, "trustServerCertificate": true },
  "databases": { "officers": "HicadData", "wofficers": "…", "ratings": "…", "ratingsA": "…", "ratingsB": "…", "juniorTrainee": "…" },
  "outputDir": "E:\\",
  "lastOperator": "…",
  "batchRows": 10000,
  "packQuality": 9,
  "packQualityMonth": 6,
  "concurrency": 6,
  "useProcesses": true
}
```

| Field | Rule |
|---|---|
| `exporterId` | 3–64 letters, digits, `.`, `-`, `_`. Shown on the website |
| `source.server` | `HOST\INSTANCE` (port found by SQL Browser) or a host name with `port` |
| `databases` | Website name → legacy database name; empty = skip that class |
| `batchRows` | 100–50,000 (default 10,000; a config still on the old default 5,000 is read as 10,000) |
| `packQuality` | Brotli quality 1–11 for **Full** packages (default 9). Higher = smaller package, slower export. The dry-run report shows raw and packed MB per table and per database. Measured 27 Oct 2026: officers Full 28 MB in 1 min 2 s (was 55 MB, 3 min 31 s with gzip) |
| `stallSeconds` | Optional, default 180. A database with no new rows for this long stops the attempt; the export then starts again once by itself. Each run is logged to `export-log.txt` in the state folder |
| `packQualityMonth` | The same for **Month** packages and month dry runs (default 6, kept fast for the 15-minute target) |
| `concurrency` | Databases read in parallel, 1–6 (default 6) |
| `useProcesses` | `true` (default): each database in its own process, so each uses its own CPU core. `false`: all in one process (fallback if starting worker processes is blocked) |

## Package numbering

- `seq` always goes up; it is never reused.
- `baseSeq` = the last package not marked discarded.
- The first real package must be **Full**. Month packages need a previous package in the ledger.
- A month package carries only the `py_payhistory` months **closed** since the previous package: from the previous package's month up to the month before this one (normally one month). The current month is never sent. If the same period is exported again, no `py_payhistory` months are sent. More than 13 months apart: export a Full package instead.
- After the website rolls a package back, run `--discard-last` before the next export.

## Output file names

| Kind | Name |
|---|---|
| Month | `NAVY_202610_seq0042.npsync` |
| Full | `NAVY_FULL_202610_seq0042.npsync` |
| Dry run | `NAVY_DRYRUN_202610_20261028T091403.npsync` |

While writing, the file is `<name>.part`; it is renamed only when complete.
