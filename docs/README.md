# NAVY Payslip Sync — Documentation

Payroll is calculated on an **offline** office network. Staff view and print payslips on the website (nncpo.ng). This project moves payroll data out of the offline network **one way, as an encrypted, signed file**, and loads it into the website so payslips are always current.

This folder is the home of all project documentation. Each document covers one subject.

## Start here

| If you are… | Read |
|---|---|
| New to the project | [Project overview](01-overview/project-overview.md), then [Architecture](02-design/architecture.md) |
| Dev A (exporter) | [Developer guide](04-guides/developer-guide.md), [Package format](03-reference/package-format.md), [Exporter commands](03-reference/exporter-cli.md) |
| Dev B (website) | [Website contract](03-reference/website-contract.md), [Shared library API](03-reference/shared-api.md), [Data and tables](02-design/data-and-tables.md) |
| The payroll officer (inside) | [Payroll officer guide](04-guides/payroll-officer-guide.md) |
| The sync officer (website) | [Sync officer guide](04-guides/sync-officer-guide.md) |
| A security reviewer | [Security](02-design/security.md), [Build and release](04-guides/build-and-release.md) |
| Planning or testing the delivery | [Work split](05-delivery/work-split.md), [Test plan](05-delivery/test-plan.md) |

## All documents

**01 Overview**
- [Project overview](01-overview/project-overview.md): what, why, constraints, phases, glossary
- [Decisions log](01-overview/decisions-log.md): every decision so far, with date and reason
- [Open questions and known issues](01-overview/open-questions-and-known-issues.md)

**02 Design**
- [Architecture](02-design/architecture.md): components, flows, phases
- [Data and tables](02-design/data-and-tables.md): which tables move, how they are applied, who owns what
- [Performance](02-design/performance.md): the 15-minute target, budget, findings, index fixes
- [Security](02-design/security.md): the air gap, encryption, keys, review checklist

**03 Reference**
- [Package format](03-reference/package-format.md): the `.npsync` file, byte by byte
- [Shared library API](03-reference/shared-api.md): what the website calls in `require("navy-payslip-sync")`
- [Website contract](03-reference/website-contract.md): endpoints, sequence rules, apply / Go live / rollback SQL, exporter approval
- [Exporter commands and files](03-reference/exporter-cli.md)

**04 Guides**
- [Payroll officer guide](04-guides/payroll-officer-guide.md): using the exporter inside the offline network
- [Sync officer guide](04-guides/sync-officer-guide.md): upload, approve, Go live, roll back on the website
- [Developer guide](04-guides/developer-guide.md): set up, code layout, rules, tests, adding a table
- [Build and release](04-guides/build-and-release.md): keys, the `.exe`, hashes, tags, bringing it inside

**05 Delivery**
- [Work split](05-delivery/work-split.md): Dev A / Dev B, day by day
- [Test plan](05-delivery/test-plan.md): automated tests and the test-day checklist

**06 Operations**
- [Monthly procedure](06-operations/monthly-procedure.md)
- [Troubleshooting and recovery](06-operations/troubleshooting-and-recovery.md)

## Status (21 Oct 2026)

- Exporter and shared library: written, 14 automated tests passing. Not yet run against the legacy SQL Server.
- Website side (NAVY-PAYROLL): Dev B starts Day 1 (22 Oct).
- Test day on staging: 24 Oct (see [Work split](05-delivery/work-split.md)).
