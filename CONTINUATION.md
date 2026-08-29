# Continuation Notes — Computeraid International M&E System

Read this first when picking this project back up in a new session. Full
phase-by-phase history (what changed, why, and setup steps for each phase)
lives in [README.md](README.md) — this file is just the "where things
stand" summary so you don't have to read all 14 phases to get oriented.

## What this is

A Google Apps Script web app (bound to a Google Sheet acting as the
database) for Computeraid International's Monitoring & Evaluation system.
Two roles — **Admin** and **Hub Manager** — each with their own login and
scoped views. Deployed via `clasp` (see `.clasp.json`, script ID
`1Owv2YgxVX2w1TphbSv8ABQN1hFKmigyXoiy9okmyCvmDFqKJ65ssbaOw`).

- **Backend**: `.gs` files, one module per feature (`Projects.gs`,
  `Inventory.gs`, `Laptops.gs`, `HubHealth.gs`, `AuditLog.gs`, ...), all
  reading/writing through the generic `DB.*` CRUD engine in `Database.gs`.
  Google Sheets tables are defined once in `Config.gs` (`SCHEMA`) and
  **read/written by column position, not header text** — this has bitten
  every phase that changed a schema (see "Schema changes" below).
- **Frontend**: a single-page app shell (`Index.html` + `Sidebar.html` +
  `Topnav.html` + `CommonJS.html`/`CoreJS.html`), with one `*HT.html` +
  `*JS.html` pair per page. Login/reset-password are standalone pages
  outside the SPA shell.

## Current state: Phase 14 complete

Latest work (see README's Phase 14 section for full detail):
- Admin-side **All Inventory** cross-hub view (`AdminInventory.gs`) with
  Excel/CSV/PDF export for 5 report types.
- Per-hub **health snapshot** (`HubHealth.gs` → `getHubHealthMetrics_()`)
  shown on the Hubs page.
- **Audit Log** (`AuditLog.gs`) — every Inventory/Laptops mutation is
  tracked (who/what/old→new/when), admin-viewable.
- Global (cross-hub) serial/asset duplicate checks for laptops.

If the Apps Script project hasn't been synced/redeployed since these
files were last edited locally, do that first — check file mtimes above
against what's actually live (`clasp status` / `clasp push`, then
**Deploy → Manage deployments → Edit → New version** in the Apps Script
editor; pushing via clasp does not itself create a new web app version).

## Known gaps / natural next steps

In priority order, roughly matching what README's own "next steps" notes
flag across phases:

1. **AI-generated M&E reports** — explicitly *not* built yet (see
   Phase 14's "Honest scope note"). `getHubHealthMetrics_()` already
   computes the numbers a report generator would need; the generator
   itself (AI-assisted or not) is unscoped, sizeable, greenfield work.
2. **Disabled "Coming soon" admin sidebar links** (`Sidebar.html:52-56`):
   Indicators, Beneficiaries, Donors, Monitoring Visits, Reports — none
   have a schema, module, or page yet.
3. **Login rate-limiting** — password reset tokens are single-use, but
   there's no throttling on login attempts (Phase 4 note, still open).
4. **Admin-side "force password reset"** action for a Hub Manager — not
   built.
5. **Session-token checks are inconsistent across older read endpoints**
   — `addProject`/`getAllProjects` and the newer inventory/laptop writes
   are session-checked; some older reads (`getCountries`, etc.) predate
   that pattern and were never retrofitted (deliberate incremental
   hardening, called out repeatedly in README, not forgotten).

## Things to know before touching schema or auth

- **Never rename a `.gs` file to match an `.html` page-content file** —
  Apps Script rejects same-named Script+HTML files. That's why page
  content files are suffixed `HT.html` (`DashboardHT.html`, not
  `Dashboard.html`) — see Phase 9 in README for the history.
- **Any change to a table's column set requires deleting that sheet tab
  and re-running `initializeDatabase()`** — reads are positional, so old
  rows under a new schema scramble silently rather than erroring. Every
  past schema change in README follows this same delete-and-recreate
  step; don't try to migrate in place.
- **`HubID` on any Hub-Manager-scoped write is always resolved
  server-side** from the session (`requireManagerSession_`), never taken
  from the client. Keep this pattern for any new Hub-Manager write path.
- `include()` (`Code.gs`) does not re-evaluate `<?!= ?>` scriptlets in
  the included file unless that file is independently templated — see
  README's Phase 11 branding note if touching `Logo.html`/`Sidebar.html`.

## Where to look

- Full history / rationale for every past decision: [README.md](README.md)
  (newest phase at the top).
- Table definitions: `Config.gs` (`SCHEMA`, `APP_CONFIG`).
- Role/session enforcement: `SessionService.gs`, `AdminAuth.gs`,
  `ManagerAuth.gs`, `Router.gs` (`ADMIN_ONLY_PAGES`/`MANAGER_ONLY_PAGES`).
- Shared export helper: `exportRecordsToFile()` in `CoreJS.html`.
- Generic audit logging: `logAudit_()`/`logAuditDiff_()` in `AuditLog.gs`.
