# Payslip Exporter — user guide

For the payroll officer who runs the exporter. No technical knowledge needed.
Keep a printed copy next to the payroll computer.

---

## What the program does

Every month, after payroll is done, this program copies the payslip data out of the
payroll system into **one file** (it ends in `.npsync`). You copy that file to the
approved flash drive. The website team uploads it, and staff can then print their
payslips on the website.

- It **never changes** anything in payroll. It only reads.
- It **never** uses the internet.
- The file is locked (encrypted). Only the website can open it.

---

## What you need

| | |
|---|---|
| The program | `navy-sync-exporter.exe` (on the Desktop) |
| The payroll computer | The one with SQL Server, or one that can reach it |
| The approved flash drive | Plugged in before you start |
| The read-only password | Kept by the payroll office (not your Windows password) |
| The media log book | To write down the fingerprint at the end |

---

## The first time on a computer (setup)

Do this once per computer. The program asks questions one by one.
**Press Enter** after each answer. A value in `[square brackets]` is the suggested answer:
just press Enter to accept it.

1. Double-click `navy-sync-exporter.exe`.

   If Windows shows **"Windows protected your PC"**, click **More info → Run anyway**.
   If the antivirus asks, allow the program.

2. The first lines show **Exporter key id: XXXX-XXXX-XXXX-XXXX**.
   **Write this key id in the media log book.** The website team will ask for it once,
   to approve this computer.

3. Answer the setup questions:

   | The program asks | What to type |
   |---|---|
   | Exporter name | Press Enter, or a name for this office, e.g. `navy-payroll-office-01` |
   | SQL Server | The SQL Server name, e.g. `DESKTOP-00R2MLU\SQLEXPRESS`. See *Finding the SQL Server name* below |
   | Port | Only asked if the name has no `\`. Press Enter for `1433` |
   | Encrypt the SQL connection | Press Enter (No), unless your IT person says otherwise |
   | Read-only login | **1** if the read-only login already exists. **2** to create it now (an IT person with the admin password must be present) |
   | Admin login / Admin password | Only for choice 2. Usually `sa` and its password. This password is **not** saved |
   | database number (one line per class) | The program suggests the right database for each class. Check, then press Enter. `0` skips a class |
   | Read-only login name to create | Press Enter for `sync_reader` |
   | New password for the read-only login | At least 10 characters, typed twice. Nothing shows while you type: that is normal. **Keep this password safe**: it is needed every month |

4. The program says **Settings saved** and goes straight on to the monthly steps below.

> **Finding the SQL Server name.** On the payroll computer press the **Windows key + R**,
> type `services.msc`, press Enter. Look for a line **SQL Server (SOMETHING)**.
> The server name is the computer name, a backslash, then SOMETHING,
> e.g. `DESKTOP-00R2MLU\SQLEXPRESS`. If it says **SQL Server (MSSQLSERVER)**, the server
> name is just the computer name. On the payroll computer itself you can also type
> `localhost\SQLEXPRESS` (or `.\SQLEXPRESS`, as in SQL Server Management Studio).

---

## Every month

Do this **after** payroll has finished the month **and** this month's IPPIS has been
uploaded into payroll.

1. Plug in the approved flash drive.
2. Double-click `navy-sync-exporter.exe`.
3. **STEP 1 — Connect.** Type the read-only password (nothing shows while you type) and
   press Enter. Each class should say **ok** and show the **same period**:

   ```
   officers      ok      54,348 staff   period 2026-09
   wofficers     ok       4,647 paid    period 2026-09
   ```

   If any line says **FAILED**, read the line under it and see *If something goes wrong*.

4. **STEP 2 — Export.** Answer:

   | The program asks | What to type |
   |---|---|
   | Kind | **1** (Month). Type **2** (Full) only the very first time on a new computer, or when the website team asks for it |
   | Save to | The flash drive, e.g. `E:\` |
   | Your name | Your name |

   For a Month export the program lists the IPPIS for the month in each class.
   If a class shows **NONE** it warns you and asks **Export without IPPIS anyway (y/N)**.
   Press **Enter** (that means No), get the month's IPPIS uploaded into payroll, and run
   the program again later. Staff would otherwise get payslips without their IPPIS part.

   Check the summary and press **Enter** to start.

5. Wait. The program prints a line as each table finishes. A Month export usually takes a
   few minutes. A Full export can take 10–30 minutes.

   **Do not click inside the black window while it works.** Clicking selects text, and
   Windows pauses the program until you press a key. If you clicked by mistake, press
   **Esc** once.

6. **STEP 3 — Done.** Copy into the media log book:

   | On the screen | In the log book |
   |---|---|
   | File | File name |
   | Sequence | Seq |
   | **Fingerprint** (e.g. `58B7-367B-A715`) | **Fingerprint** — the website team checks it |
   | Size | Size |

7. Press **Enter** to close. Hand over the flash drive under the media procedure.

---

## If it looks stuck

- First check you did not click inside the window (press **Esc** once).
- While a big table is read, nothing new may appear for a minute or two. That is normal.
- If a class shows nothing new for a minute, the program prints
  `still waiting for SQL Server (1 min with no new rows)…`. Let it continue.
- If a class stays silent for **3 minutes**, the program stops that attempt and **starts
  the export again by itself** once. You do not need to do anything.
- If it stops a second time, it tells you so. Check that SQL Server is running and that
  no payroll calculation or backup is running, then run the program again.
- Every run is written to a log file:
  `C:\ProgramData\navy-payslip-sync\export-log.txt`. Send that file to the website team
  if a problem keeps happening.

Stopping the program yourself (closing the window, or **Ctrl + C**) is safe: nothing is
saved and payroll is not touched. Just run it again.

---

## If something goes wrong

The program shows **ERROR:** and a message, then waits for Enter. Find the message here.

| Message (or part of it) | What it means | What to do |
|---|---|---|
| `Could not connect to …` | The program cannot reach SQL Server | See **SQL Server connection problems** (separate sheet) |
| `Login failed for user 'sync_reader'` | Wrong read-only password, or the login is disabled | Type it again carefully (Caps Lock?). Still failing: ask IT to run setup again with choice **2** to reset the password |
| `… FAILED` with `table … not found` | That database is missing a payroll table | Check the right database was chosen for that class (`--setup`, see below). Tell the website team which table |
| `py_stdrate has no valid BT05 row` | The payroll period is not set in that class | Payroll must open/close the month in that class first |
| `Databases are on different periods` | One class is still on another month | Finish month-end in every class, then export |
| `No package has been exported yet: the first package must be a full package` | First export on this computer | Choose Kind **2** (Full) |
| `no IPPIS for …` | This month's IPPIS is not in payroll yet | Upload the month's IPPIS in payroll, then export |
| `… is locked by another program` | Payroll (or a backup) is busy with that table | Wait until the payroll calculation or backup finishes, then export again |
| `Cannot write to E:\…` | The flash drive is missing, full or write-protected | Plug it in, free space, or check its lock switch |
| `… stopped responding twice` | SQL Server did not answer for a long time, twice | Check SQL Server is running (see the connection sheet), no calculation/backup running, then try again |
| `already exists` | A file with that name is already on the drive | Move the old file off the drive, then export again |

---

## Other things you may be asked to do

Open **Command Prompt** in the folder with the program (on the Desktop: click the
address bar of the folder, type `cmd`, press Enter), then type one of these:

| Type | When |
|---|---|
| `navy-sync-exporter.exe --setup` | The SQL Server name, port, password or databases changed |
| `navy-sync-exporter.exe --discard-last` | The website team says the last file was lost or rolled back. Then export again |
| `navy-sync-exporter.exe --ledger` | To see every file exported from this computer |
| `navy-sync-exporter.exe --show-key` | The website team asks for this computer's key id |
| `navy-sync-exporter.exe --dry-run` | The website team asks for a timing test (that file is never used) |

---

## Good to know

- Passwords are never saved. Only the settings (server name, databases) are kept, in
  `C:\ProgramData\navy-payslip-sync`. **Do not delete that folder**: it holds this
  computer's key and the list of exported files.
- Each computer has its own key. A new computer must be approved once by the website team
  (they will ask for the key id from step 2 of setup).
- Delete the file from the flash drive once the website team confirms it is **published**.
