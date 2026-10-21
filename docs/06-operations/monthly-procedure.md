# Monthly procedure

The same steps every month. Inside: [Payroll officer guide](../04-guides/payroll-officer-guide.md). Outside: [Sync officer guide](../04-guides/sync-officer-guide.md).

## Steps

1. Payroll closes the month's calculation.
2. Payroll officer runs the exporter: Connect → Export. Notes seq, size and fingerprint in the media log.
3. Media moves out under the media procedure.
4. Sync officer uploads in the Console, checks the fingerprint matches the log, reviews the totals screen.
5. Go live. Delete the package from the media after the Console shows `published`.

## Media log

One line per package, kept by the payroll office:

| Date | Package file | Seq | Fingerprint | Size | Exported by | Carried by | Uploaded by | Uploaded on | Deleted from media |
|---|---|---|---|---|---|---|---|---|---|
| 28 Oct 2026 | NAVY_202610_seq0042.npsync | 42 | 9F3A-71C2-0B8E | 74 MB | … | … | … | … | … |

## Timing

Machine time (export + upload + load + Go live) must stay within 15 minutes. The Sync Console shows each run's timing; the exporter prints its own time on the Done screen.
