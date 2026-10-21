# Build and release

## One-time: the website key

```
npm run keygen
```

- `keys/website-public.pem` is compiled into every `.exe`.
- `keys/website-private.pem` is a **secret**. Give it to Dev B privately for the website's `SYNC_PRIVATE_KEY`, then delete it from the build machine. Never commit it (`keys/*.pem` is git-ignored).
- A new website key means a new `.exe` for the payroll machine.

## Build the `.exe` (on Windows)

```
npm install
npm test
npm run build:exe            # or: node scripts/build-exe.js --website-key <path to website-public.pem>
```

The build:

1. Compiles the website public key into `exporter/website-key.generated.js` (git-ignored).
2. Bundles the exporter with esbuild into `dist/exporter.cjs`.
3. Makes a Node single-executable blob and injects it into a copy of `node.exe` → `dist/navy-sync-exporter.exe`.
4. Writes `dist/SHA256SUMS.txt` and `dist/README.txt`.

The `.exe` is made from the Node that runs the build, so build with the Node version you want to ship (20.12+). Injecting removes Node's code signature, so Windows may show "unknown publisher".

**If the build fails:** ship `dist/exporter.cjs` with a portable `node.exe` and run `node.exe exporter.cjs`.

## Release

1. Update `version` in `package.json`.
2. `npm test`.
3. Commit, tag `vX.Y.Z`, push the tag.
4. Build the `.exe` from the tagged commit; keep `SHA256SUMS.txt` with the release notes.
5. In NAVY-PAYROLL, move `"navy-payslip-sync": "github:hicadsystems/navy-payslip-sync#vX.Y.Z"` to the new tag.

## Bringing a version into the offline network

1. Copy `navy-sync-exporter.exe`, `README.txt` and `SHA256SUMS.txt` to approved media.
2. The security team checks the hash against the release record and follows the media procedure.
3. Replace the old `.exe` on the payroll machine. Settings, key and ledger in `%ProgramData%\navy-payslip-sync` are kept.
