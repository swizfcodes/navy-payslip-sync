# SQL Server connection problems

When the exporter says **`Could not connect to …`** or **`Login failed …`**, work down this
sheet. Most fixes need someone who can sign in to Windows as an administrator on the
SQL Server computer. Every fix here is a setting on SQL Server or Windows: none changes
payroll data.

The exporter reads the **legacy payroll in Microsoft SQL Server**. (A section for the new
NAVY-PAYROLL MySQL database is at the end, for when payroll moves to it.)

---

## 1. Read the message first

The message after `Could not connect to <server>:` tells you where to look.

| The message contains | Most likely cause | Go to |
|---|---|---|
| `Failed to connect to … in 30000ms` / `ETIMEOUT` | SQL Server not reachable: service stopped, TCP/IP off, firewall, wrong port | 2, 3, 4, 6 |
| `Failed to get response from SQL Server Browser` / `Port for … not found in ServerName` | Named instance (`\SQLEXPRESS`) but the **SQL Server Browser** service is off, or UDP 1434 blocked | 2, 5, 6 |
| `ECONNREFUSED` | Nothing listening on that port: TCP/IP off, wrong port, service stopped | 2, 3, 4 |
| `getaddrinfo ENOTFOUND <name>` | The computer name is wrong or unknown on the network | 7 |
| `Login failed for user 'sync_reader'` | Wrong password, login disabled/locked, or SQL logins not allowed | 8, 9 |
| `Login failed for user 'sa'` (during setup) | Wrong admin password, or `sa` disabled | 8, 9, 10 |
| `is not able to access the database` / `Cannot open database` | The login has no access to that database, or the database is offline | 10, 11 |
| `Server requires encryption` | SQL Server forces encrypted connections | 12 |
| `self signed certificate` / `unsupported protocol` / `SSL` / `TLS` / `socket hang up` | Encryption settings do not match (often an old SQL Server) | 12 |
| `… is locked by another program` | Not a connection problem: payroll or a backup is using the table | Wait, then export again |

---

## 2. Is SQL Server running?

On the SQL Server computer:

1. Press **Windows key + R**, type `services.msc`, press Enter.
2. Find **SQL Server (SQLEXPRESS)** (or **SQL Server (MSSQLSERVER)**, or another name in brackets).
   - **Status** must be **Running**. If not: right-click → **Start**.
   - Double-click it → **Startup type: Automatic** → **OK**, so it starts with Windows.
3. Find **SQL Server Browser** (needed when the server name has a `\`, e.g. `PC\SQLEXPRESS`).
   - It is often **Disabled** after installation. Double-click → **Startup type: Automatic** →
     **Apply** → **Start** → **OK**.

The name in brackets is the **instance name**. The server name to type in the exporter is
`COMPUTERNAME\INSTANCE` (e.g. `DESKTOP-00R2MLU\SQLEXPRESS`), or just `COMPUTERNAME` for
`MSSQLSERVER` (the default instance).

---

## 3. Is TCP/IP switched on? (very common with SQL Server Express)

The exporter talks to SQL Server over the network protocol **TCP/IP**. SQL Server Express
installs with it **switched off**.

1. Open **SQL Server Configuration Manager**: press the Windows key and type
   `Configuration Manager`. If it does not appear, press **Windows key + R** and type the name for
   your version:

   | SQL Server | Type |
   |---|---|
   | 2022 | `SQLServerManager16.msc` |
   | 2019 | `SQLServerManager15.msc` |
   | 2017 | `SQLServerManager14.msc` |
   | 2016 | `SQLServerManager13.msc` |
   | 2014 | `SQLServerManager12.msc` |
   | 2012 | `SQLServerManager11.msc` |

2. **SQL Server Network Configuration → Protocols for SQLEXPRESS** (your instance name).
3. **TCP/IP** must be **Enabled**. If not: right-click → **Enable**.
4. Restart SQL Server: **SQL Server Services** (left) → right-click **SQL Server (SQLEXPRESS)** → **Restart**.

---

## 4. Which port? (fixed port 1433 is the simplest)

A named instance like `SQLEXPRESS` normally picks a **different port every time it starts**
(a "dynamic" port), and the **SQL Server Browser** tells programs which one. It is simpler
and more reliable to give it a fixed port:

1. Configuration Manager → **Protocols for SQLEXPRESS** → double-click **TCP/IP** →
   tab **IP Addresses** → scroll to the bottom, **IPAll**:
   - **TCP Dynamic Ports**: empty (delete the number, including any `0`)
   - **TCP Port**: `1433`
2. **OK**, then restart SQL Server (as in step 3.4).
3. Run `navy-sync-exporter.exe --setup` and type the server name **without** `\SQLEXPRESS`
   (e.g. `DESKTOP-00R2MLU` or `localhost`) and port `1433`. With a fixed port the
   SQL Server Browser is no longer needed.

If another SQL Server on the same computer already uses 1433, pick another port (e.g. `1435`)
and type that in the exporter.

**Which port is it using now?** In the same **IPAll** box: the number under
**TCP Dynamic Ports** (dynamic) or **TCP Port** (fixed). Or check the SQL Server error log
(SSMS → Management → SQL Server Logs) for `Server is listening on [ 'any' <ipv4> 49712]`.

---

## 5. SQL Server Browser (only for names with `\`)

Needed only when you type `COMPUTER\INSTANCE` without a port.

- The **SQL Server Browser** service must be **Running** (step 2).
- From another computer, **UDP port 1434** must be open in the firewall (step 6).
- Or avoid the Browser completely: give SQL Server a fixed port (step 4).

---

## 6. Windows Firewall (only when SQL Server is on another computer)

If the exporter runs **on the same computer** as SQL Server, skip this.

On the SQL Server computer, open **Command Prompt as administrator** (Windows key, type `cmd`,
right-click → **Run as administrator**) and type:

```
netsh advfirewall firewall add rule name="SQL Server TCP 1433" dir=in action=allow protocol=TCP localport=1433
netsh advfirewall firewall add rule name="SQL Server Browser UDP 1434" dir=in action=allow protocol=UDP localport=1434
```

(Use your port instead of 1433 if it is different. The second line is only needed for names with `\`.)

**Test from the exporter computer:** open **PowerShell** and type

```
Test-NetConnection DESKTOP-00R2MLU -Port 1433
```

`TcpTestSucceeded : True` means the port is reachable. `False` means SQL Server is not listening
on that port (steps 2–4) or a firewall blocks it (this step, or another firewall/antivirus).

---

## 7. The computer name

- On the SQL Server computer: **Settings → System → About → Device name**.
- On the same computer you can use `localhost`, `.` or `(local)` (e.g. `localhost\SQLEXPRESS`).
- If the name is not found from another computer, use its **IP address** instead
  (on the SQL Server computer: Command Prompt → `ipconfig` → **IPv4 Address**),
  e.g. `192.168.1.20\SQLEXPRESS` or `192.168.1.20` with port 1433.

---

## 8. SQL Server must allow SQL logins ("mixed mode")

The exporter signs in with a **SQL login** (`sync_reader`, and `sa` during setup), not with
the Windows account. SQL Server must allow that:

1. Open **SQL Server Management Studio (SSMS)**, connect with Windows authentication.
2. Right-click the server (top of the left panel) → **Properties** → **Security**.
3. **Server authentication: SQL Server and Windows Authentication mode** → **OK**.
4. Restart SQL Server (step 3.4).

---

## 9. The login itself

In SSMS: **Security → Logins → sync_reader** → double-click.

| Check | Where | Should be |
|---|---|---|
| Login enabled | **Status** page | **Login: Enabled**, **Permission to connect: Grant** |
| Not locked out | **Status** page | **Login is locked out** unticked (it locks after too many wrong passwords) |
| Password does not expire | **General** page | **Enforce password expiration** unticked |
| Password | **General** page | Type a new one here if it is forgotten, then use it in the exporter |

Or reset everything from the exporter: `navy-sync-exporter.exe --setup`, choose
**2 — Create it now**, sign in with the admin login: the read-only login gets a new password
and access to the chosen databases.

**`sa` disabled?** Many servers have `sa` switched off. Either enable it for setup (SSMS →
Logins → sa → Status → Enabled, then disable it again afterwards), or ask the database
administrator to create the read-only login with the script in step 10.

---

## 10. The login cannot open a database

Message: `The server principal "sync_reader" is not able to access the database "…"`.

The read-only login needs **read access (db_datareader)** to every payroll database.
Easiest: run `--setup` again and choose **2 — Create it now**. Or a database administrator
runs this in SSMS (replace the password and database names):

```sql
CREATE LOGIN sync_reader WITH PASSWORD = 'Choose-A-Strong-Password-1', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;
GO
USE [HicadData];   -- repeat these three lines for every payroll database
CREATE USER sync_reader FOR LOGIN sync_reader;
ALTER ROLE db_datareader ADD MEMBER sync_reader;   -- SQL Server 2008: EXEC sp_addrolemember 'db_datareader', 'sync_reader';
GO
```

---

## 11. The database is offline or being restored

In SSMS, a payroll database shown as **(Restoring…)**, **(Offline)**, **(Single User)** or
**(Suspect)** cannot be read. Wait for the restore to finish, or bring it online
(right-click → **Tasks → Bring Online**). A database in **Single User** mode is being
worked on by someone: wait until they finish.

---

## 12. Encryption and certificates

During setup the exporter asks **Encrypt the SQL connection**. The usual answer is **No**.

| Message | Fix |
|---|---|
| `Server requires encryption` | SQL Server forces encryption: run `--setup`, answer **y** to Encrypt |
| `self signed certificate` / `certificate` | Run `--setup`, answer **No** to Encrypt (on a closed network this is normal) |
| `unsupported protocol`, `SSL`, `TLS`, `socket hang up`, `ESOCKET` (often SQL Server 2008/2012) | The old SQL Server only speaks an old encryption (TLS 1.0) that the exporter refuses. In Configuration Manager → **Protocols for …** → right-click → **Properties** → **Force Encryption: No**, restart SQL Server, and answer **No** to Encrypt. The lasting fix is to install the latest SQL Server service pack/updates (TLS 1.2 support) |

---

## 13. Still not connecting

1. Can **SSMS** on the same computer as the exporter connect, with the **same server name**
   and **SQL Server authentication** as `sync_reader`?
   - **Yes**: type the server name in the exporter exactly as in SSMS (`--setup`), including
     a `,port` if SSMS needed one (e.g. `DESKTOP-00R2MLU,1433`).
   - **No**: the problem is SQL Server or the network, not the exporter: go through steps 2–9 again.
2. Antivirus or endpoint security can block new programs from opening network connections:
   allow `navy-sync-exporter.exe`.
3. Send the website team: the exact error line, the server name you typed, a photo of
   **services.msc** (SQL Server lines) and of **Protocols for …** in Configuration Manager,
   and `C:\ProgramData\navy-payslip-sync\export-log.txt`.

---

## When payroll moves to NAVY-PAYROLL (MySQL)

The exporter does not read MySQL yet. When it does, the same kinds of checks apply:

| Check | Where |
|---|---|
| The MySQL service is running | `services.msc` → **MySQL80** (or similar) → Running, Automatic |
| The port (default **3306**) is reachable | `Test-NetConnection <server> -Port 3306`; firewall rule for TCP 3306 when on another computer |
| MySQL listens on the network, not only on the same computer | `my.ini`: `bind-address` must not be `127.0.0.1` when the exporter is on another computer; restart MySQL |
| The user may connect from the exporter computer | The MySQL user is `'sync_reader'@'%'` (or `@'<exporter computer IP>'`), not only `@'localhost'` |
| The user has read access | `GRANT SELECT ON hicaddata.* TO 'sync_reader'@'%';` (repeat for each payroll database) |
| Password / authentication plugin | Old clients fail with `caching_sha2_password`; the exporter will support it, but a reset password fixes most `Access denied` errors |
