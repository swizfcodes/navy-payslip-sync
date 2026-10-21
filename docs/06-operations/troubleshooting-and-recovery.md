# Troubleshooting and recovery

## Exporter (inside)

| Message | Cause | Fix |
|---|---|---|
| `Could not connect to <server>` | Server name, instance, network, or password | Check the server name (`HOST\INSTANCE`), that SQL Browser runs for named instances, and the password |
| `table <name> not found` | The login cannot see the table, or the database mapping is wrong | `--setup` to check the mapping; check the login has read access on that database |
| `hr_employees missing column(s): …` | Legacy column names differ | Tell Dev A; the column list is in `shared/manifest.js` |
| `py_stdrate has no valid BT05 row` | Period not set in that database | Payroll fixes BT05 |
| `Databases are on different periods` | One database is not closed for the month | Close all databases for the same period, then export |
| `No package has been exported yet: the first package must be a full package` | Empty ledger | Export Kind = Full |
| `The previous package was N months ago` | More than 13 months since the last package | Export Kind = Full |
| `Cannot write to <folder>` | Drive missing or read-only | Insert the drive or choose another folder |
| `Website public key not found` | Development run without keys | `npm run keygen` (the built `.exe` carries the key) |

## Website upload refused

| Code | Cause | Fix |
|---|---|---|
| `unknown-exporter` | First package from this exporter | Super admin approves after comparing the key id |
| `exporter-key-changed` | The exporter has a new key (new machine or reinstall) | Super admin confirms with payroll, deactivates the old key, approves the new one |
| `bad-signature`, `payload-hash-mismatch` | The file changed after export | Do not use it. Export again |
| `truncated` | Incomplete copy | Copy the file again from the original media |
| `decrypt-failed` | Made for another website key | The `.exe` was built with the wrong key; rebuild |
| `sequence-gap` | A package in between was never applied | Upload the missing package; if it is lost, payroll runs `--discard-last` and exports again, or exports a Full package |
| `sequence-old` | Already applied or older | Nothing to do |
| `not-applicable` | Dry-run package | Timing only; never applied |

## Recovery

| Situation | Steps |
|---|---|
| A run fails while loading | Nothing staff can see changed. Fix the cause, upload again |
| A wrong month went live | Publications → Roll back (latest run only). Payroll runs `--discard-last`, corrects, exports again |
| Package lost before upload | Payroll runs `--discard-last`, exports again |
| Website database lost | Restore from backup, then upload a Full package |
| Payroll machine replaced | Install the `.exe`, run setup; the new exporter key is approved on the first upload; deactivate the old key. The new machine has an empty ledger, so its first package is Full |
