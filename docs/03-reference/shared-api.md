# Shared library API

What the website (and the exporter) use from this repo. Nothing here needs a database driver.

```js
const sync = require("navy-payslip-sync");
// sync.manifest, sync.format, sync.batch, sync.crypto, sync.types, sync.reader, sync.writer, sync.timings, sync.canonicalJson
```

Install in NAVY-PAYROLL: `"navy-payslip-sync": "github:hicadsystems/navy-payslip-sync#v0.1.0"`.

## Reading a package (website)

```js
const { header, payloadOffset } = await sync.reader.readHeader(file);   // no keys needed; for the upload preview
const approved = await db.findExporterKey(header.exporterId);           // from sync_exporters

if (!approved) {
  const info = await sync.reader.inspectNewExporter(file);  // checks the file against the key it carries
  // show info.exporterId and info.keyIdFormatted to a super admin; on approval store info.publicKeyPem
}

await sync.reader.verifyPackage(file, { exporterPublicKeyPem: approved }); // signature + payload hash
const seq = sync.format.checkSequence(header, lastAppliedSeq);             // { ok, code, reason }

for await (const rec of sync.reader.readRecords(file, { websitePrivateKeyPem, header, payloadOffset })) {
  if (rec.type === "batch") {
    // rec.batch = { database, table, mode, scope, batchNo, columns, types, rows, checksum } — checksum already verified
  } else if (rec.type === "manifest") {
    // comes after all batches: per database totals, per table rows / batches / checksum
  }
}
```

Always `verifyPackage` before `readRecords`.

## `sync.reader`

| Function | Returns | Notes |
|---|---|---|
| `readHeader(file)` | `{ header, payloadOffset }` | Validates the header's shape only |
| `verifyPackage(file, { exporterPublicKeyPem })` | `{ header, payloadOffset }` | Checks the approved key, the signature, the length and the payload hash |
| `inspectNewExporter(file)` | `{ exporterId, keyId, keyIdFormatted, publicKeyPem, header }` | For approving an unknown exporter; verifies with the embedded key |
| `readRecords(file, { websitePrivateKeyPem, header, payloadOffset })` | async iterator of `{ type: "batch", name, batch, bytes }` and `{ type: "manifest", manifest }` | Decrypts and decodes as it streams; throws on a bad tag or a missing end record |

## `sync.format`

| Export | Use |
|---|---|
| `parseHeaderBuffer(buf)` | Parse the first bytes of a file (browser preview on the server side) |
| `checkSequence(header, lastAppliedSeq)` | Sequence rule: `{ ok: true }` or `{ ok: false, code, reason }` |
| `fingerprint(payloadSha256)` | `9F3A-71C2-0B8E` |
| `validateHeaderShape(header)` | Throws `PackageError` if malformed |
| `PAYLOAD_OFFSET`, `HEADER_RESERVED`, `MAGIC`, `FORMAT_VERSION` | Constants |
| `PackageError` | Has `.code` (table below) |

## `sync.manifest`

| Export | Use |
|---|---|
| `DATABASES` | `["officers", "wofficers", "ratings", "ratingsA", "ratingsB", "juniorTrainee"]` |
| `MASTER_DATABASE` | `"officers"` (`hicaddata`) |
| `TABLES` | The full table list |
| `tablesFor(database, kind)` | Tables for one database and kind, with `mode`, `applyAt`, `rollback`, `key`, `scope` resolved |
| `goliveTables(kind)` | Tables swapped at Go live, for the `RENAME TABLE` |
| `findTable(name)` | Case-insensitive lookup |
| `HR_EMPLOYEES_PAYROLL_COLUMNS` | Columns of `hr_employees` the package may write |

## `sync.crypto`

`keyId(publicKeyPem)`, `formatKeyId(id)`, `generateWebsiteKeyPair()`, `generateExporterKeyPair()`. The rest is used internally by the reader and writer.

## `sync.types`

`LOGICAL_TYPES`, `logicalFromMysql(dataType)`, `logicalFromMssql(dataType)`, `toWire(value, logical)`. Wire values: [Package format](package-format.md).

## Error codes (`PackageError.code`)

| Code | Meaning | Show the user |
|---|---|---|
| `bad-magic` | Not an `.npsync` file | "This is not a payslip package." |
| `bad-header` / `header-too-large` | Header damaged | "The package header is damaged. Export again." |
| `unknown-exporter` | Exporter not approved | Approval dialog (super admin) |
| `exporter-key-changed` | Approved exporter, different key | "This exporter's key has changed. A super admin must approve the new key." |
| `bad-signature` | Header changed or not made by this exporter | "The file was changed after export. Do not use it." |
| `truncated` | File shorter than its header says | "The file is incomplete. Copy it again." |
| `payload-hash-mismatch` | Contents changed | "The file was changed after export. Do not use it." |
| `decrypt-failed` | Encrypted for another website key, or damaged | "This package cannot be opened by this website." |
| `bad-record` / `missing-end` | Payload damaged | "The file is damaged. Export again." |
| `sequence-gap` | Does not build on the last applied package | "Package N builds on M, but the last applied is K. Upload the missing package or export a full package." |
| `sequence-old` | Older than what is applied | "This package is older than the one already applied." |
| `not-applicable` | Dry-run package | "Dry-run packages are for timing only." |
