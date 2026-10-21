# keys/

Key files are never committed (`*.pem` is git-ignored).

| File | Made by | Goes to | Secret? |
|---|---|---|---|
| `website-private.pem` | `npm run keygen` | Website secret store (`SYNC_PRIVATE_KEY`). Delete from here after copying | **Yes** |
| `website-public.pem` | `npm run keygen` | Built into `navy-sync-exporter.exe` by `npm run build:exe` | No |
| `exporter-private.pem`, `exporter-public.pem` | `npm run keygen -- --exporter` (development only) | Development/testing only. The real exporter key is made on first run on the offline machine and never leaves it | Private: **yes** |
