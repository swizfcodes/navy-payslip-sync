# Security

## The air gap stays closed

- The payroll network stays offline. No machine is on it and on the internet at the same time.
- Data leaves only as a package file on approved removable media, under the existing media procedure (log, scan, encrypted drive where policy requires).
- Nothing comes into the payroll network except the exporter program itself, once per version, through the approved process. No data files come in, Phase 2 included: website changes go back as a printed list keyed in by payroll staff.
- The exporter has no internet code, no auto-update, no web server and no open ports. Its only connection is to the SQL Server, with a read-only login.

## What protects a package

| Threat | Protection |
|---|---|
| A lost USB stick or laptop | The payload is AES-256-GCM encrypted. The key is agreed with X25519 against the website's public key (a fresh key pair per package) and HKDF-SHA256. Only the website private key can open it |
| Someone changes the file | The header carries the SHA-256 of the encrypted payload; the exporter's Ed25519 signature covers the whole header. Any changed byte is refused before anything is decrypted |
| A file made by someone else | The website processes only packages signed by an approved exporter. A new exporter is approved by a super admin who compares the key id with the exporter's screen |
| An exporter key silently replaced | A package whose embedded key differs from the approved one is refused (`exporter-key-changed`) |
| An old or replayed file | Sequence numbers: a package must build on the last applied one; older numbers are refused |
| A half-loaded month | Everything loads into stage tables while the month is hidden; Go live is one atomic step per database; rollback is available |
| Swapping the website key on the payroll machine | The website public key is compiled into the `.exe` at build time, not read from a file |

Algorithms (Node built-in `crypto`, no third-party crypto): AES-256-GCM, X25519, HKDF-SHA256, Ed25519, SHA-256. Code: `shared/crypto.js`.

## Keys

| Key | Made where | Kept where | Used for |
|---|---|---|---|
| Website key pair (X25519) | `npm run keygen`, once | Private key: website secret store (`SYNC_PRIVATE_KEY`), deleted from the build machine. Public key: compiled into the `.exe` | Only the website can open a package |
| Exporter key pair (Ed25519) | The exporter, on its first run inside | Private key: `%ProgramData%\navy-payslip-sync` on the payroll machine, never leaves it. Public key: travels inside every package, approved once on the website | The website knows which exporter made a package |

Rotating the website key needs a new `.exe` build. Replacing the exporter machine means approving its new key and deactivating the old one.

## Logins

- **Exporter → payroll DB:** a read-only SQL login (`db_datareader` on the chosen databases only), never `sa`. Setup can create it if a DBA types an admin login once; the admin password is not saved. The read-only password is typed each run and never saved.
- **Website writes:** a MySQL user (`sync_writer`) limited to the synced tables, their `__stage` / `__prev` / `__undo` copies and the `sync_*` tables.
- **Sync Console:** Upload, Go live, Withdraw and Roll back need the sync role; approving an exporter needs super admin.

## What leaves the payroll network

Only the tables in `shared/manifest.js`, and for `hr_employees` only the payroll columns (`EMPL_ID`, `Surname`, `othername`, `Title`, `gradelevel`, `bankcode`, `BankACNumber`, `pfacode`, `nsitfcode`, `factory`, `location`, `payrollclass`, `dateleft`). No passwords or login data. The header (readable without decrypting) holds only: kind, period, sequence numbers, database names, exporter name, operator name, time, hashes and keys. Staff counts and amounts are inside the encrypted payload.

## Review checklist (for the client's security team)

- [ ] Source reviewed: `exporter/` (what runs inside) and `shared/` (format and crypto). Pure JavaScript; dependency list in `package.json` (`mssql` and its driver `tedious`).
- [ ] No network code besides the SQL Server connection: search `exporter/` and `shared/` for `http`, `https`, `net`, `dgram`, `fetch` (only `mssql` opens a socket).
- [ ] The `.exe` matches `SHA256SUMS.txt` from the build; the build is reproducible from a tagged commit ([Build and release](../04-guides/build-and-release.md)).
- [ ] The read-only login has `db_datareader` only.
- [ ] Media procedure agreed: who exports, who carries, who uploads, how media is scanned and wiped.
- [ ] The website private key is held only by the website.
