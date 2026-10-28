# Payroll officer guide

For the person who exports payroll data inside the offline network. A plain-language, printable version is the [Exporter user guide](exporter-user-guide.md); connection errors: [SQL Server connection problems](../06-operations/sql-server-connection-problems.md). You need: the payroll machine with `navy-sync-exporter.exe`, the read-only password, an approved removable drive, and the media log.

## First time only: setup

Run `navy-sync-exporter.exe`. With no settings yet, it starts setup:

1. **Exporter name.** Keep the suggested name unless told otherwise. The website shows it.
2. **SQL Server.** For example `HICAD-THREEONE\SQL2022`.
3. **Encrypt the SQL connection.** Accept the default unless your DBA says otherwise.
4. **Read-only login.**
   - *Already created*: type its name and password.
   - *Create it now*: your DBA types an admin login and password (not saved). Later you choose a name (default `sync_reader`) and a password of at least 10 characters, typed twice. Keep this password safe; you type it every month.
5. **Databases.** The program lists the payroll databases it finds, with staff counts and the current period, and suggests which one is which class. Check each suggestion and press Enter, or type the right number (0 skips a class).
6. Note the **exporter key id** shown at start-up (for example `3F9C-1A2B-7D0E-55AA`). The website team will ask for it the first time they upload your package.

## Every month

When payroll has closed the month's calculation **and this month's IPPIS has been uploaded** into payroll:

1. Insert the approved drive.
2. Run `navy-sync-exporter.exe`.
3. **STEP 1 — Connect.** Type the read-only password. Every database should say `ok` and show the same period. If not, stop and see [Troubleshooting](../06-operations/troubleshooting-and-recovery.md).
4. **STEP 2 — Export.**
   - Kind: **1 (Month)** normally. **2 (Full)** only for the first package ever, or when the website team asks for one.
   - Period: shown, not chosen. It is the current payroll period.
   - Save to: the removable drive (for example `E:\`).
   - Your name.
   - Month only: the exporter lists the IPPIS rows for the period in each database. If any database shows `NONE`, it warns and asks "Export without IPPIS anyway" (default **No**). Answer No, upload the month's IPPIS, then export again. Staff payslips would otherwise miss their IPPIS earnings and deductions. A database with no IPPIS table at all is only noted. Full packages are not checked.
   - Check the summary (package number, what it follows) and press Enter.
5. **STEP 3 — Done.** Write in the media log: file name, sequence, **fingerprint**, size, your name, the date.
6. Remove the drive and hand it over under the media procedure.

The program never connects to the internet and never changes payroll data.

## Special cases

| Situation | What to do |
|---|---|
| The drive was lost, or the file never reached the website | Run `navy-sync-exporter.exe --discard-last`, then export again |
| The website team rolled back a month | Run `--discard-last`, then export again when payroll is corrected |
| The website asks for a full package | Export with Kind = 2 (Full) |
| "No IPPIS for …" warning | Stop (answer No). Upload the month's IPPIS in payroll, then run the exporter again. Export without IPPIS only if the payroll office decides staff must have payslips before IPPIS arrives |
| A timing test is requested | `navy-sync-exporter.exe --dry-run` (the website never applies it) |
| Server or database names changed | `navy-sync-exporter.exe --setup` |
| See what was exported before | `navy-sync-exporter.exe --ledger` |
