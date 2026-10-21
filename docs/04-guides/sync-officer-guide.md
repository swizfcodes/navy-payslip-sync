# Sync officer guide

For the person who uploads packages on the website. Payslip Sync is under **Utilities** in the admin dashboard. Your account needs the sync role (approving a new exporter needs a super admin).

## Every month

1. Get the drive and the media log entry from the payroll office.
2. In **Payslip Sync → Upload**, choose the `.npsync` file.
3. Check the preview against the media log: file name, kind, period, sequence and **fingerprint** must match. If the fingerprint differs, stop: the file is not the one exported.
4. Upload. If the connection drops, choose the same file again and click **Resume**; only the missing part is sent.
5. Wait for the checks. Each database card should say "checks passed" with its staff count and total net.
6. Click **Go live** and confirm. Staff can now print the month.
7. Note the total time on the Runs tab (target: 15 minutes or less including the export).
8. Return the drive for wiping under the media procedure.

## First package from a new exporter

The Upload tab shows **Approve new exporter** with the exporter's name and key id. A super admin:

1. Asks the payroll officer for the key id shown on the exporter's screen (or reads it from the media log).
2. Compares it, character by character.
3. Approves only if it matches. Then the upload continues.

## When something is wrong

| Situation | Action |
|---|---|
| Totals look wrong before Go live | Don't go live. Tell payroll; they export again after fixing |
| A month went live with wrong data | **Publications → Roll back**, with a reason. Then tell the payroll officer to run `--discard-last` before the next export |
| A month must be hidden for now | **Publications → Withdraw**. Staff see "not ready yet" |
| The upload is refused | Read the message; see [Troubleshooting](../06-operations/troubleshooting-and-recovery.md) |
