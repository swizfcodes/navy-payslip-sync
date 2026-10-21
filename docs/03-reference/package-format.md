# Package format (`.npsync`)

Implemented in `navy-payslip-sync/shared/` (`package-format.js`, `package-writer.js`, `package-reader.js`, `batch-format.js`, `crypto.js`). The website uses `verifyPackage()` and `readRecords()` from there and does not parse the file itself.

One file per export, covering the chosen databases (normally all six) for one period.

Name: `NAVY_<period>_seq<0042>.npsync`; full: `NAVY_FULL_<period>_seq<0042>.npsync`; dry run: `NAVY_DRYRUN_<period>_<timestamp>.npsync`.

Layout:

```
offset 0        8 bytes   magic "NPSYNC01"
offset 8        4 bytes   header length L (uint32 big-endian; currently 16384)
offset 12       L bytes   header JSON, padded with spaces (readable without decrypting)
offset 12+L     ...       encrypted payload, exactly header.payloadBytes long
```

The header is written last, into the reserved space, because it carries the payload hash, the GCM tag and the signature. The browser reads the first 16,396 bytes to preview the header before uploading.

Header:

```json
{
  "format": 1,
  "kind": "month",
  "exporterId": "navy-payroll-office-01",
  "exporterKeyId": "3f9c…",
  "exporterPublicKey": "-----BEGIN PUBLIC KEY-----\n…",
  "seq": 42,
  "baseSeq": 41,
  "period": "202610",
  "databases": ["officers", "wofficers", "ratings", "ratingsA", "ratingsB", "juniorTrainee"],
  "createdAt": "2026-10-28T09:14:03.512Z",
  "operator": "name as typed",
  "manifestVersion": 1,
  "exporterVersion": "0.1.0",
  "payloadBytes": 77123456,
  "payloadSha256": "…64 hex…",
  "encryption": {
    "alg": "AES-256-GCM",
    "kdf": "X25519-HKDF-SHA256",
    "ephemeralPublicKey": "…base64 SPKI…",
    "websiteKeyId": "…",
    "iv": "…",
    "authTag": "…"
  },
  "signature": "ed25519:…"
}
```

- **Encryption:** each package gets a fresh X25519 key pair. Its private half and the website public key give a shared secret; HKDF-SHA256 turns that into the AES-256-GCM key. Only the website private key can recover it. `websiteKeyId` lets the website say "encrypted for a different website key".
- **Signature:** the exporter's Ed25519 signature over the header without `signature`, as canonical JSON (keys sorted). It covers `payloadSha256`, so it covers every byte.
- **Exporter key in the header:** every package carries the exporter's public key (covered by the signature). The website uses it only to offer approval of a new exporter (see [Website contract](website-contract.md), "Approving a new exporter"). Trust comes from a person approving the key id, never from the file alone.
- **Fingerprint** shown to people: first 12 hex characters of `payloadSha256`, as `9F3A-71C2-0B8E`.

Decrypted payload: a sequence of records `[uint8 type][uint32 nameLength][name][uint32 dataLength][data]`:

| type | name | data |
|---|---|---|
| 1 batch | `batches/<db>/<table>[/<scope>]/<00001>.json.gz` | gzipped batch JSON |
| 2 manifest | `manifest.json` | package manifest JSON |
| 255 end | `end` | empty |

Order: all batches (databases interleaved, batches of one table in order), then the manifest, then the end record. **The manifest comes last** because row counts are only known after reading. The website loads batches into stage tables as they arrive and checks them against the manifest at the end.

Batch:

```json
{
  "v": 1,
  "database": "ratings",
  "table": "py_ipis_payhistory",
  "mode": "replace-scope",
  "scope": { "period": "202610" },
  "batchNo": 3,
  "columns": ["numb", "period", "bpc", "bpa", "bp", "bpm", "createdby", "datecreated", "Type"],
  "types":   ["string", "string", "string", "string", "string", "decimal", "string", "datetime", "string"],
  "rows": [["NN1234", "202610", "BP", "TAXABLE PAYMENT", "BASIC SALARY", "250000.0000", null, "2026-10-02 10:11:12", "BP001"]],
  "checksum": "sha256:…"
}
```

- `types`: `string`, `int`, `bigint` (string), `decimal` (string, exact), `float`, `bit` (0/1), `date` ("YYYY-MM-DD"), `datetime` ("YYYY-MM-DD HH:MM:SS"), `time`, `binary` (base64). Column names keep the source spelling; match them to MySQL columns case-insensitively.
- Up to 5,000 rows per batch. The batch count per table is in the manifest.
- `merge-columns` batches carry the key plus only the columns to write (for `py_payhistory`: key + the month column groups being sent).

Package manifest (the `manifest.json` record):

```json
{
  "manifestVersion": 1,
  "kind": "month",
  "dryrunOf": null,
  "period": "202610", "seq": 42, "baseSeq": 41,
  "payhistoryMonths": [{ "year": 2026, "months": [9, 10] }],
  "exporterVersion": "0.1.0",
  "timings": { "exportMs": 191000 },
  "databases": {
    "ratings": {
      "sourceDatabase": "HicadRatings",
      "totals": { "staffCount": 12412, "totalNet": "1234567890.1200" },
      "ms": 160000,
      "tables": [
        { "table": "py_ipis_payhistory", "mode": "replace-scope", "applyAt": "prepare", "rollback": "undo-snapshot",
          "key": ["period", "numb", "Type"], "scope": { "period": "202610" },
          "columns": ["…"], "types": ["…"], "rows": 402113, "batches": 81,
          "checksum": "sha256:…", "rawBytes": 61234567, "packedBytes": 6123456, "ms": 24000 }
      ]
    }
  }
}
```

The table `checksum` is sha256 over that table's batch checksums in order. Totals come from `py_mastercum` for the period's month.
