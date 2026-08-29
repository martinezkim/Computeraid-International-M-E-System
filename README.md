# M&E Management System — Phase 14 (Admin Inventory Integration, Hub Health, Exports, Audit Log)

Builds the admin side on top of Phases 12–13: cross-hub inventory
visibility, a per-hub health/status snapshot, data exports, and an
audit trail.

## Hub status on the Hubs page

Every hub row now has a **Snapshot** column (reports this year, quota
compliance %, total assets, equipment availability %, and a color-coded
Health Score badge) plus a **View** button opening a full detail modal
— reports vs. this year's quotas, a computer breakdown (in use / in
storage / under repair / faulty / decommissioned), equipment
availability & utilization %, computer-to-beneficiary ratio, and the
hub's laptop sales snapshot. This is powered by a new reusable
function, `getHubHealthMetrics_(hubId)` in `HubHealth.gs` — "computers"
here means Hub Inventory items in the Desktop Computers / Laptops
categories (equipment actually deployed for beneficiaries), not the
Laptops for Sale resale catalog. The Health Score is a simple,
transparent average of reporting compliance and equipment
availability — not a rigid formula, easy to reweight later.

## Admin: All Inventory (`AdminInventory.gs` / `AdminInventoryHT.html`)

A new admin-only page with two tabs — Hub Inventory and Laptops for
Sale — showing every hub's items at once, each card tagged with its
hub name. Filterable by Hub, Category/Status, and search; global stat
cards (hub count, total assets, laptops in stock, laptops sold) at the
top. Admins view and export here; Hub Managers remain the only ones
who can add/edit/delete their own hub's items — nothing on this page
writes to Inventory or Laptops.

## Exports

An **Export** button on the All Inventory page covers all 5 requested
report types (Hub Inventory, Laptop Current Stock, Sold Laptops,
Faulty Laptops, Complete Inventory), each exportable as Excel, CSV, or
PDF. This is a shared `exportRecordsToFile()` helper in `CoreJS.html`
— CSV/Excel are built entirely client-side (Excel via the SheetJS
library already loaded for spreadsheet import), and PDF opens a
print-formatted tab and calls the browser's own print-to-PDF, so there's
no added dependency for it.

## Audit Log (`AuditLog.gs` / `AuditLogHT.html`)

Every Inventory and Laptops add/update/delete — including each row
inserted via spreadsheet import — now writes to a new `AuditLog`
sheet: who, what table/record/field, the old and new value, and when.
Updates log one row per field that actually changed, not one blob per
save, so "what changed" is precise. A new admin-only **Audit Log**
page lists it all, filterable by table/action, searchable, paginated.
`logAudit_()`/`logAuditDiff_()` are generic — extending this to other
modules later is just a matter of calling them at their mutation
points too.

## Data integrity

- Laptop serial-number/asset duplicate checks are now **global**
  across every hub, not just one — this is what actually enforces
  "the same asset can't be assigned to two hubs simultaneously."
- A laptop can only ever have one `Status`, so "sold laptop staying in
  Current Stock" is structurally impossible — Current Stock/Sold/Faulty
  are just filtered views of that one field.
- Inventory IDs are server-generated (never user-supplied), so
  duplicate Inventory IDs can't happen by construction.

## Honest scope note: "AI-generated M&E reports"

No AI-report-generation feature exists anywhere in this codebase yet,
so there was nothing to "integrate" the inventory data into. What Phase
14 does instead: `getHubHealthMetrics_()` is a clean, reusable,
already-computing-everything-requested function (computer counts,
computer-to-beneficiary ratio, equipment availability/utilization) that
any future report generator can call directly — and it's already
surfaced today in the Hub Detail modal. Building the actual report
generator (AI-assisted or not) is a separate, sizeable feature — happy
to scope that whenever you're ready for it.

## Setup for this phase

1. Update `Config.gs`, `Inventory.gs`, `Laptops.gs`, `HubsHT.html`,
   `HubsJS.html`, `Router.gs`, `Sidebar.html`, `CommonJS.html`,
   `Index.html`, `CoreJS.html`.
2. Add the new files: `HubHealth.gs`, `AdminInventory.gs`, `AuditLog.gs`,
   `AdminInventoryHT.html`, `AdminInventoryJS.html`, `AuditLogHT.html`,
   `AuditLogJS.html`.
3. Run `initializeDatabase` (or open the app once) so the new
   `AuditLog` sheet gets created.
4. Redeploy (**Deploy → Manage deployments → Edit → New version**).
5. As Admin: **Hubs** → click the eye icon on any hub → see the
   snapshot. **Inventory → All Inventory** → switch tabs, filter by
   hub, try Export. **Inventory → Audit Log** → edit something as a
   Hub Manager, then confirm it shows up here.

---

# M&E Management System — Phase 13 (Laptops for Sale + Inventory Summary)

Completes the Inventory section: **Laptops for Sale** (with spreadsheet
import) and a combined **Inventory Summary** dashboard.

## Laptops for Sale

- **New table**: `Laptops` in `Config.gs`. One row per laptop; the three
  UI sub-sections are just filtered views of this table keyed on
  `Status` (`Current Stock` / `Sold` / `Faulty`) — a laptop only ever
  has one Status, so it structurally can't appear in two sections at
  once. Moving a laptop between sections is done by editing it and
  changing its Status (e.g. to `Sold`, which then requires Buyer
  Name / Sale Date / Sale Price).
- **New module**: `Laptops.gs` — same hub-scoping pattern as
  `Inventory.gs`/`Projects.gs`. Pill-tab UI in `LaptopsHT.html` /
  `LaptopsJS.html`, with search, and filters for Manufacturer,
  Processor, RAM, Storage, price range, and date-added range.
- **Order numbers**: every laptop carries an `OrderNumber`. Manual
  adds get one auto-suggested (editable); each spreadsheet import
  shares one order number across the whole batch, entered on the
  import preview screen.
- **Spreadsheet import**: "Import from Spreadsheet" button → upload a
  `.csv`/`.xlsx`/`.xls` file (parsed **client-side** with SheetJS,
  loaded from jsDelivr — nothing is uploaded to Drive) → columns are
  matched automatically against the recommended headers (`Barcode`,
  `ManName`, `modelname`, `Blancco Processor`, `HDD`, `SerialNumber`,
  ...) and common variants → a preview shows valid rows vs. rows with
  errors (missing serial number, duplicate serial within the file or
  already in inventory, etc.) → confirming inserts the valid rows into
  Current Stock under the chosen order number. Everything is
  re-validated server-side on confirm — the client's "valid" rows
  aren't trusted blindly. A **Download Template** button gives a
  correctly-headed `.csv` to start from.
  - Columns not in our schema (`customerid`, `collectionid`,
    `MEMORYBANKS`, `CD?`) are folded into the laptop's `Notes` field
    rather than dropped, so nothing from the source file is lost.
  - Selling Price and Condition aren't in the recommended import
    columns, so imported laptops default to Condition "Refurbished"
    and Selling Price $0 — pricing is expected to be set afterward via
    Edit. This felt more honest than inventing values; flag if you'd
    rather the import require a price column instead.

## Inventory Summary

A new landing page for the Inventory section (`InventorySummary.gs` /
`InventorySummaryHT.html`) combining:
- **Hub Inventory Summary** — Total Assets plus a tally for every
  equipment category and every status (In Use / In Storage / Under
  Repair / **Faulty** / Decommissioned).
- **Laptop Sales Summary** — Total Laptops for Sale, Current Stock,
  Sold, Faulty, Total Stock Value, Total Sales Value, Number Sold.

Everything on this page is computed live from the two tables — nothing
is manually entered.

**One schema change to flag**: the original "Inventory at the Hub"
spec only had `In Use / In Storage / Under Repair / Decommissioned` as
statuses, but this summary was explicitly asked for a "Faulty Assets"
card too. Rather than overload "Under Repair" to mean two different
things, I added `Faulty` as a fifth status option
(`INVENTORY_STATUSES` in `Inventory.gs`) — it now shows up automatically
in the Inventory at the Hub filters/dropdowns too, since those are
built from that same list.

## Setup for this phase

1. Update `Config.gs`, `Router.gs`, `Sidebar.html`, `CommonJS.html`,
   `Index.html`, `Styles.html`, `Inventory.gs`.
2. Add the new files: `Laptops.gs`, `LaptopsHT.html`, `LaptopsJS.html`,
   `InventorySummary.gs`, `InventorySummaryHT.html`, `InventorySummaryJS.html`.
3. Run `initializeDatabase` (or open the app once) so the `Laptops`
   sheet gets created.
4. Redeploy (**Deploy → Manage deployments → Edit → New version**).
5. As a Hub Manager: **Inventory → Laptops for Sale** → try Add Laptop,
   then Download Template → fill in a couple of rows → Import from
   Spreadsheet → confirm the preview shows them → Confirm Import →
   check they land in Current Stock. Then **Inventory Summary** to see
   both dashboards populate.

---

# M&E Management System — Phase 12 (Inventory at the Hub)

Adds a new **Inventory** section to the Hub Manager sidebar, with two
sub-pages:

1. **Inventory at the Hub** — built in this phase, fully working.
2. **Laptops for Sale** — shown as a disabled "Coming soon" link for
   now (same pattern already used for Admin's future Indicators/
   Beneficiaries/Donors links), since its fields haven't been defined
   yet. Happy to build it next once we agree what it should track
   (likely something like Price, Buyer, Sale Status on top of the
   same asset fields).

## Inventory at the Hub

A Hub Manager can log, edit, and delete equipment/assets physically
located at their own hub — desktops, laptops, printers, projectors,
networking gear, solar equipment, VR headsets, tablets, UPS/power
backup units, and a catch-all "Other Devices" category.

- **New table**: `Inventory` in `Config.gs` — `HubID`, `Category`,
  `ItemName`, `Manufacturer`, `Model`, `SerialNumber`, `Quantity`,
  `Condition` (New/Refurbished), `DateAcquired`, `Status` (In Use/In
  Storage/Under Repair/Decommissioned), and an optional `PhotoURL`.
  Sheets-backed tables can't store an uploaded file directly, so
  "Photo" is a link field for now (e.g. paste a Drive share link) —
  the card grid shows it as a thumbnail when present.
- **New module**: `Inventory.gs`, following the exact same hub-scoping
  pattern as `Projects.gs` — `HubID` is never supplied by the client,
  it's resolved server-side from the caller's own Hub Manager session
  (`requireManagerSession_`), and every edit/delete re-checks the item
  still belongs to that hub before touching it.
- **New page**: `InventoryHT.html` / `InventoryJS.html` — a card grid
  (search, category filter, status filter, sort, pagination) with a
  small "Total Items / In Use / In Storage / Under Repair" summary
  strip up top, and an Add/Edit modal covering every field. Editing an
  item is how its **Condition** and **Status** get updated over time
  (e.g. moving something from "In Use" to "Under Repair") — there's no
  separate quick-status-change control yet, just the one edit form.
- Category, Condition, and Status option lists live in one place
  (`INVENTORY_CATEGORIES` / `INVENTORY_CONDITIONS` / `INVENTORY_STATUSES`
  in `Inventory.gs`, served to the client via `getInventoryFormOptions()`)
  rather than being duplicated between server validation and the
  frontend dropdowns.

## Setup for this phase

1. Update `Config.gs`, `Router.gs`, `Sidebar.html`, `CommonJS.html`,
   `Index.html`, `Styles.html`.
2. Add the new files: `Inventory.gs`, `InventoryHT.html`, `InventoryJS.html`.
3. Run `initializeDatabase` (or just open the app once — `DB.getSheet`
   lazily creates any missing table) so the `Inventory` sheet gets
   created with the correct headers.
4. Redeploy (**Deploy → Manage deployments → Edit → New version**).
5. Log in as a Hub Manager → **Inventory → Inventory at the Hub** →
   Add Item → fill in the form → confirm it appears as a card, and
   that editing it lets you change Condition/Status.

---

# M&E Management System — Phase 11 (Hub Manager Dashboard Split + Branding)

Splits the Hub Manager's single page into two, and applies Computeraid
International's branding throughout.

## Hub Manager: Dashboard and My Projects are now separate pages

Previously, a Hub Manager's "Dashboard" nav link *was* their project
list — clicking it showed the Add Project button and table/cards
directly. That page moved and a real dashboard was added in its place:

- **`myprojects` (new page key) → `ManagerProjects.html` /
  `ManagerProjectsJS.html`** — this is the old `ManagerDashboard.html`
  content, renamed and re-keyed. Everything (the Add Project wizard,
  the card grid, search/sort/filter) is unchanged, just reached via a
  new **My Projects** sidebar link instead of being what "Dashboard"
  showed. Restricted server-side to Hub Managers only (`Router.gs`'s
  new `MANAGER_ONLY_PAGES` guard), the same pattern `ADMIN_ONLY_PAGES`
  already used for admin-only pages.
- **`dashboard` (same page key as before) → new `ManagerDashboard.html`
  / `ManagerDashboardJS.html`** — a fresh 3-card summary: **Total
  Beneficiaries**, **Total Projects**, and **Money Spent**, all scoped
  to the Hub Manager's own hub and the current reporting year (reusing
  the exact "most recent year with data" logic from the admin
  dashboard, via a new `getMyDashboardStats()` in `Projects.gs`, so
  both dashboards agree on what "current year" means).
- `animateCount()` (the count-up animation) moved from `DashboardJS.html`
  into the shared `CoreJS.html` so both dashboards can use it without
  duplicating the function.
- Added a `.stat-grid-3` CSS variant for the 3-card layout (the admin's
  `.stat-grid` is tuned for 5).

Net effect: an Admin's sidebar is unchanged (Dashboard first, admin
pages below); a Hub Manager's sidebar now shows **Dashboard** (the new
3-card summary) and **My Projects** (everything that used to be
"Dashboard") as two separate items.

## Branding: Computeraid International

- `APP_CONFIG.APP_NAME` in `Config.gs` is now "Computeraid
  International M&E System" — this flows automatically into every page
  title, the browser tab title, and email subject lines, since they
  all read from this one config value.
- Added `Logo.html`, containing your logo's SVG (gold `#FECA38` + white
  — already matched this app's exact accent color, no palette changes
  needed). Sized via a `.brand-logo-svg` CSS class rather than fixed
  width/height attributes, so it scales cleanly in different contexts.
- **Where it's used, and why differently in different files**: Apps
  Script's `include()` (see `Code.gs`) just inserts a file's raw text —
  it does **not** re-evaluate `<?!= ... ?>` scriptlets inside that
  text. `Login.html` and `ResetPassword.html` are each independently
  templated (`HtmlService.createTemplateFromFile`), so they can use
  `<?!= include('Logo'); ?>` directly. `Sidebar.html` is only ever
  pulled into `Index.html` via `include()` — it is *not* independently
  templated — so a scriptlet inside it would never run; the logo is
  inlined directly into `Sidebar.html`'s source instead. If you ever
  need to update the logo, edit `Logo.html` **and** copy the same
  change into `Sidebar.html`'s inlined copy.
- Removed the old generic icon-badge + "M&E System" text treatment from
  the sidebar and both auth pages.

## Setup for this phase

1. Update the changed files: `Config.gs`, `Projects.gs`, `Router.gs`,
   `Sidebar.html`, `CommonJS.html`, `CoreJS.html`, `DashboardJS.html`,
   `Index.html`, `Login.html`, `ResetPassword.html`, `Styles.html`.
2. Add the new files: `Logo.html`, `ManagerDashboard.html` (replaces
   the old one — same name, new content), `ManagerDashboardJS.html`
   (same), `ManagerProjects.html`, `ManagerProjectsJS.html`.
3. **Delete the old `ManagerDashboard.html` / `ManagerDashboardJS.html`
   content before pasting the new versions in** — same filenames, but
   the content is completely different now (3-card summary, not the
   project list).
4. No schema changes — nothing to re-run in `initializeDatabase()`.
5. Redeploy (**Deploy → Manage deployments → Edit → New version**).
6. Log in as a Hub Manager → confirm **Dashboard** shows 3 cards and
   **My Projects** (new sidebar link) shows the project list/wizard you
   had before.
7. Confirm the Computeraid International logo appears in the sidebar
   and on both the Login and Reset Password pages, and that the browser
   tab title reads "Computeraid International M&E System."

## Previously: Phase 10 — Login Redirect, Quota Cards, Dashboard Bug, Idle Timeout

## Fix: bare exec link went to the dashboard instead of login

**Root cause**: `doGet()` in `Code.gs` defaulted the missing-`?page`
case to `'dashboard'`, which served the full SPA shell immediately and
relied entirely on client-side JS to notice there's no session and
redirect. That's fixed at the source — the default is now `'login'`.
An unauthenticated visitor never sees the SPA shell render at all, not
even briefly, so there's no "freeze" window where the app half-loads
with no session behind it. `?page=dashboard` still works as before —
it's the *default* (no `?page` at all) that changed.

## Fix: Projects / Total Beneficiaries cards showed no data

**Root cause**: `getCurrentReportingYearLabel_()` in `Dashboard.gs`
computed "the current reporting year" purely from **today's real
calendar date** (Aug-Jul fiscal cycle), completely independent of what
quotas and projects actually exist. If your test data used a
`YearLabel` that doesn't match whatever today's date resolves to (e.g.
you're testing with "2026-2027" quotas, but today's date resolves to
"2025-2026"), the cards would correctly show 0 for a year with no
data — which looks exactly like "not retrieving data" even though the
query itself was working fine.

**Fix**: the "current" year is now derived from your actual data — the
most recent `YearLabel` among your `ReportingQuotas` — with the old
date-based calculation only used as a fallback when there are no
quotas at all yet. Whatever year you're actively creating quotas and
filing projects against is automatically what the dashboard shows.

## Reporting Quotas: now cards, with a project count

The admin's Reporting Quotas page matches the same card treatment as
Submitted Reports now — no more table. Each card shows the quarter,
year, status, and **how many projects have been filed against it**
(`ProjectCount`, attached server-side in `getQuotas()` by counting
`Projects` grouped by `QuotaID` — no extra round trip). Edit/Delete
are still per-card buttons; search got a "Sort by" dropdown (Year,
Quarter, Most Projects) replacing the old column-header sorting, same
pattern as the Projects cards.

## Idle timeout: 5 minutes, with a warning banner

Applies to both Admins and Hub Managers, implemented once in
`CommonJS.html` since both share the same SPA shell:

- Any mouse, keyboard, scroll, or touch activity resets a 5-minute
  clock (throttled to at most once/second so constant `mousemove`
  events don't hammer it).
- **30 seconds before logout**, a banner slides down from the top of
  the screen — above everything, including modals — with a "Stay
  Signed In" button that resets the clock.
- If it expires anyway, the session is closed server-side
  (`logout()`, the same function the manual sign-out button uses) and
  the browser is sent to `?page=login&reason=timeout`, which shows a
  toast explaining why.
- This is a **client-side convenience layer**, not a replacement for
  server-side session expiry (`SESSION_HOURS` in `Config.gs`, several
  hours by design). It protects an unattended, already-unlocked
  browser tab; it doesn't shorten how long a session token itself
  remains valid if someone never triggers the client-side timer at all
  (e.g. calling server functions directly). Worth knowing, not
  currently a practical concern for an internal tool at this scale.

## Setup for this phase

1. Update the changed files: `Code.gs`, `Dashboard.gs`, `Quotas.gs`,
   `QuotasHT.html`, `QuotasJS.html`, `CommonJS.html`, `Index.html`,
   `Login.html`, `Styles.html`.
2. No schema changes — nothing to re-run in `initializeDatabase()`.
3. Redeploy (**Deploy → Manage deployments → Edit → New version**).
4. Open the bare `.../exec` URL in a fresh/incognito window → confirm
   it lands on the login page, not a frozen dashboard.
5. Log in as Admin → Reporting Quotas → confirm cards with a project
   count, and that Dashboard's Projects/Total Beneficiaries cards now
   show real numbers for whatever year you've been testing with.
6. Log in, then leave the tab alone for ~4.5 minutes → confirm the red
   banner appears with a 30-second countdown context, and that either
   clicking "Stay Signed In" or waiting it out behaves as expected
   (reset vs. redirect to login with the toast).

## Previously: Phase 9 — Review Pass (Naming, Email, Dashboard, Cost)

## ⚠️ File rename — do this in Apps Script before pasting anything else

Apps Script won't let a Script file and an HTML file share the same base
name — `Dashboard.gs` + `Dashboard.html` (both literally named
"Dashboard") gets rejected in the editor even though the extensions
differ, and the same was true for `Countries`, `Hubs`, `Managers`,
`Quotas`, and `Projects`. This was a real bug in every earlier phase's
setup instructions, not just a cosmetic issue.

**Fix**: every page-content HTML file that shares a name with a `.gs`
module is now suffixed `HT`:

| Old name | New name |
|---|---|
| `Dashboard.html` | `DashboardHT.html` |
| `Countries.html` | `CountriesHT.html` |
| `Hubs.html` | `HubsHT.html` |
| `Managers.html` | `ManagersHT.html` |
| `Quotas.html` | `QuotasHT.html` |
| `Projects.html` | `ProjectsHT.html` |

Files with no colliding `.gs` name (`Sidebar.html`, `Login.html`,
`ManagerDashboard.html`, `CoreJS.html`, every `*JS.html`, ...) are
unaffected — don't rename those. If you already have the old-named
files in your Apps Script project, delete them and add the renamed
ones; `Router.gs` was updated to point at the new names.

## Welcome email no longer shows the temporary password

`EmailService.sendManagerWelcomeEmail()` dropped the "Temporary
password: ..." line from both the plain-text and HTML email bodies —
the "Set My Password" link is the only thing a new Hub Manager needs.
A random password is still generated and hashed internally (it has to
go in `PasswordHash` as *something* until the manager sets their own),
it's just never displayed anywhere now.

## Admin dashboard: 5 cards, evenly spread

Added two new live cards — **Projects** and **Total Beneficiaries** —
both scoped to the *current reporting year* (e.g. "(2026-2027)"),
computed automatically from today's date using the same Aug-start
fiscal cycle as `QUARTER_MONTHS`. `getCurrentReportingYearLabel_()` in
`Dashboard.gs` does the computation; `getDashboardStats()` then finds
every `ReportingQuota` with that year label, filters `Projects` down to
those quotas, and returns the count plus the summed
`TotalNewBeneficiaries`. The stat grid switched from a compact
left-clustered row to a uniform `repeat(5, 1fr)` grid so all 5 cards
spread evenly across the row (narrowing to 3 / 2 / 1 columns as the
viewport shrinks).

## Projects: new Cost field + card-based overview (5 per row)

- **`Cost`** (dollars, decimals allowed) is now a required field on
  every project — added right after Date/Quota in the wizard's first
  step, validated with a new `Validate.nonNegativeNumber` (unlike
  `wholeNumber`, this allows cents). Shown in the shared detail modal as
  a 4th stat tile alongside Total New / Female / Male.
- **Both the admin's Submitted Reports page and the Hub Manager's My
  Projects page now show projects as cards instead of a table** — 5 per
  row on wide screens, narrowing responsively down to 1 per row on
  mobile. Each card shows the project name, hub (admin view only),
  quota, date, beneficiary count, and cost; clicking anywhere on a card
  opens the same shared detail modal as before. Column-header sorting
  was replaced with a "Sort by" dropdown (Date, Name, Cost, Beneficiaries)
  since cards don't have column headers.
- **Fixed a latent sort bug** while touching this: `paginateAndFilter()`
  in `Utilities.gs` sorted every column as a string, which silently
  misordered numbers (e.g. "9" sorting after "10"). It now sorts
  numerically when both values are actual numbers — this was already
  wrong for Total New/Female sorting, and would have been very visibly
  wrong for the new "Cost (Highest)" sort option.

## ⚠️ Schema changed again — delete & recreate the `Projects` sheet

`Projects` gained a `Cost` column. Same reasoning as every earlier
schema change: delete the `Projects` sheet tab, run
`initializeDatabase()` again, redeploy.

## Setup for this phase

1. Do the file rename above first (delete old-named files, add the
   `HT`-suffixed ones).
2. Update the changed files: `Router.gs`, `EmailService.gs`,
   `Managers.gs`, `Config.gs`, `Validation.gs`, `Dashboard.gs`,
   `Projects.gs`, `Utilities.gs`, `CoreJS.html`, `Styles.html`,
   `DashboardJS.html`, `ProjectDetailModal.html`, `ProjectDetailJS.html`,
   `ManagerDashboard.html`, `ManagerDashboardJS.html`, `ProjectsJS.html`.
3. Delete the `Projects` sheet, run `initializeDatabase()`.
4. Redeploy (**Deploy → Manage deployments → Edit → New version**).
5. Add a Hub Manager → confirm the welcome email has no password in it.
6. Log in as Admin → Dashboard → confirm 5 evenly-spread cards, with
   Projects/Total Beneficiaries showing the current year in parentheses.
7. Add a project as a Hub Manager, including a Cost → confirm it shows
   as a card (not a table row) on both "My Projects" and the admin's
   "Submitted Reports," 5 per row, with Cost visible on the card and in
   the detail modal.

## Previously: Phase 8 — Projects Are Now Named & Dated

## ⚠️ Schema changed — delete & recreate the `Projects` sheet

`Projects` dropped `ReportingMonth` and gained **`ProjectName`** and
**`ProjectDate`** (columns are read/written by position, so a sheet
created under the old schema will scramble under the new one — same
reasoning as every earlier schema change in this project). If you have
an existing `Projects` sheet:

1. Delete the `Projects` sheet/tab entirely (any old data won't carry
   over — this is a schema change, not a migration).
2. Run `initializeDatabase()` once more to recreate it with the correct
   headers.
3. Redeploy.

## What changed

- **`ProjectName`** (required) and **`ProjectDate`** (an actual date,
  not a month picker) replace the old month-only model. A hub can file
  any number of projects against the same quota — even the same date —
  since they're now distinct named activities, not one-slot-per-month.
  The old "one report per hub/quota/month" duplicate check is gone.
- **`ProjectDate` must still fall within its quota's 3-month window** —
  that validation didn't go away, it just moved from "pick one of these
  3 months" to "pick a date inside this range." `getQuotaDateRange()` in
  `Quotas.gs` computes the actual start/end dates (e.g. "Q1 2025-2026" →
  Aug 1–Oct 31, 2025) since every quarter is 3 *consecutive* months; the
  date picker's min/max are set from this, and the server checks it
  again regardless of what the client sends.
- **Hub Manager's main page is now a proper list page**, not a grid of
  quota cards. "My Projects" has a page-header with an **Add Project**
  button at the top-right — the same pattern as Countries/Hubs/Hub
  Managers/Reporting Quotas — followed by a searchable, sortable,
  paginated table (Project Name, Quota, Date, Total New, Female) with a
  Quota filter dropdown. A **View** button opens the shared detail modal,
  identical to the admin's Submitted Reports table.
- **The Add Project wizard's Step 1 changed**: Project Name, a Reporting
  Quota dropdown, and a Date field replace the old month-only step.
  Choosing a quota fetches its valid date range and updates the date
  input's `min`/`max` plus a hint ("Must fall between Aug 1, 2025 and
  Oct 31, 2025"). Steps 2–6 (totals, the three age-band groups, review)
  are unchanged.
- **The shared detail modal's title is now the project's own name**
  (`ProjectName`), with Hub/Quota/Date as a subtitle line underneath —
  used identically by the admin's Submitted Reports table and the Hub
  Manager's own "My Projects" table.
- Admin's Submitted Reports table gained a **Project Name** column and
  swapped **Month** for **Date**; the redundant "Submitted" timestamp
  column was dropped to keep the table compact.

## Setup for this phase

1. Update the changed files: `Config.gs`, `Quotas.gs`, `Projects.gs`,
   `CoreJS.html`, `ProjectDetailModal.html`, `ProjectDetailJS.html`,
   `Projects.html`, `ProjectsJS.html`, `ManagerDashboard.html`,
   `ManagerDashboardJS.html`, `Styles.html`.
2. **Delete the `Projects` sheet** and run `initializeDatabase()` (see
   the warning above).
3. Redeploy (**Deploy → Manage deployments → Edit → New version**).
4. Log in as a Hub Manager → **Add Project** → fill in a name, pick a
   quota, pick a date within its range → complete the wizard → confirm
   it appears in the table below → click **View**.
5. Log in as Admin → **Submitted Reports** → confirm the same project
   shows up with its name and date, filterable by Hub/Quota.

## Previously: Phase 7 — Viewing Submitted Data + Quarter Correction

## Correction: quarters are now fixed to specific months

Previously the month dropdown offered all 12 months regardless of which
quota you were reporting against. That's fixed — every quarter now maps
to exactly 3 calendar months, defined once in `QUARTER_MONTHS` in
`Quotas.gs`:

| Quarter | Months |
|---|---|
| Q1 | Aug, Sep, Oct |
| Q2 | Nov, Dec, Jan |
| Q3 | Feb, Mar, Apr |
| Q4 | May, Jun, Jul |

This is a fiscal year starting in August, not the calendar year — so
"Q2 2025-2026" covers Nov & Dec **2025** plus Jan **2026**. The Add
Project wizard's month dropdown is now populated per-quota from this
mapping (via the new `getMonthsForQuota()`), already-submitted months
are shown disabled, and `validateProjectInput()` in `Projects.gs`
rejects any month that doesn't belong to the quota's actual quarter —
this is checked server-side, not just hidden in the dropdown. Quota
cards and the wizard now say "X of **3** months reported," not 12.

## Admin: Submitted Reports (new page)

A new **Submitted Reports** admin page shows every project filed across
every hub, filterable by Hub and by Reporting Quota, with search, sort,
and pagination — the same pattern as every other admin list in this app.

**On responsiveness**, given how many data fields a project has (month,
2 totals, 10 age bands): the table intentionally shows only Hub, Quota,
Month, Total New, Female, and Submitted date — six columns that stay
readable on a phone without horizontal scrolling. A **View** button per
row opens the age-band breakdown in a modal instead of cramming 10 more
columns into the table. That breakdown modal renders each age band as a
small proportional bar (like a horizontal bar chart) rather than a wall
of numbers, and shows Total/Female/Male as three stat tiles up top.
Nothing about the underlying data is hidden — it's one click away — but
the table itself stays scannable at any screen size.

## Hub Manager: View Submissions (new)

Each quota card's "X of 3 months reported" text is now a clickable link
(only when there's at least one submission) opening a small list of
that hub's own submitted months. Clicking any month opens the exact same
detail modal the admin uses — same bars, same stat tiles — just scoped
to their own hub's data (`getMyProjectsForQuota` already only returns
rows for the manager's own `hubId`, enforced server-side).

## Shared component: `ProjectDetailModal.html` / `ProjectDetailJS.html`

Both views call the same `showProjectDetail(project, headerLabel)` — one
modal, defined once at the shell level in `Index.html` (a sibling of
`#main-content`, not inside it), so it's always present regardless of
which page is currently loaded and never gets swapped out. Placing it
outside `#main-content` also sidesteps the pop-in-animation/modal-trap
issue noted in earlier phases, since it was never a child of the
animated container to begin with.

## What's now enforced server-side (recap + one addition)

`getAllProjects()` (the admin's cross-hub read) now requires a valid
Admin session token, same pattern as `addProject()`'s Hub Manager check
from Phase 6. Still not retrofitted to older reads like `getCountries`
— this remains a deliberate, incremental hardening rather than a full
pass, as noted in earlier phases.

## Setup for this phase

1. Paste in the new files: `Projects.html`, `ProjectsJS.html`,
   `ProjectDetailModal.html`, `ProjectDetailJS.html`.
2. Update the changed files: `Quotas.gs`, `Projects.gs`, `Router.gs`,
   `Sidebar.html`, `CommonJS.html`, `CoreJS.html`, `Index.html`,
   `ManagerDashboard.html`, `ManagerDashboardJS.html`, `Styles.html`.
3. No schema changes — nothing to re-run in `initializeDatabase()`.
4. Redeploy (**Deploy → Manage deployments → Edit → New version**).
5. Log in as Admin → **Submitted Reports** → filter by Hub or Quota,
   click **View** on any row.
6. Log in as a Hub Manager → click the "X of 3 months reported" link on
   a quota card with at least one submission → click a month to see its
   breakdown.

## Previously: Phase 6 — Monthly Project Reports (Progressive Form)

## What's new in Phase 6

- **`Projects.gs`** — Hub Managers can now file one report per
  (their Hub, Reporting Quota, Month) via `addProject()`. **`HubID` is
  never supplied by the client** — it's resolved from the caller's own
  session (`requireManagerSession_()`), so there's no way for a Hub
  Manager to (accidentally or otherwise) file a report against a
  different hub, even by tampering with the request. This is the first
  module that enforces that boundary; the "known gap" noted in earlier
  phases is now closed for this one write path.
- **The "Add Project" button opens a real progressive wizard**, not a
  toast anymore: a 6-step modal (Month → Totals → Ages 0–18 → Ages
  19–36 → Ages 37+ → Review), with a progress bar, per-step validation,
  a live "allocated so far: X of Y" hint while entering age bands, and a
  final review screen before submitting.
- **Data integrity rule enforced both client- and server-side**: the 10
  age-band fields must add up *exactly* to Total New Beneficiaries. The
  review step blocks the Submit button while they don't match, and
  `validateProjectInput()` in `Projects.gs` re-checks this (and
  everything else) again server-side regardless of what the client
  claims. Duplicate (Hub + Quota + Month) submissions are also blocked.
- **Quota cards now show progress** — each card fetches
  `getMyProjectsForQuota()` and displays "X of 12 months reported,"
  updated live right after a successful submission.

## A wording correction from the last phase

The Phase 5 notes said "11 age-band columns" — it's actually **10**
(0-5, 6-10, 11-13, 14-18, 19-23, 24-28, 29-32, 33-36, 37-64, 65+), which
is what the `Projects` schema in `Config.gs` always actually had. Just a
typo in the prose, not a schema change.

## Setup for this phase

1. Paste in the new file: `Projects.gs`.
2. Update the changed files: `Validation.gs` (new `wholeNumber`
   validator), `ManagerDashboard.html`, `ManagerDashboardJS.html`,
   `Styles.html`.
3. No schema changes — `Projects` was already created back in Phase 5.
   No need to re-run `initializeDatabase()` for this step.
4. Redeploy (**Deploy → Manage deployments → Edit → New version**).
5. Log in as a Hub Manager → click **Add Project** on any quota card →
   step through the wizard → submit. Try submitting the same month
   twice to confirm the duplicate check fires.

## Still not covered

- No way yet to **view or edit** a submitted project after the fact —
  today it's add-only. An admin-facing view of everything submitted
  (per hub, per quota) is a natural next module.
- Every *other* write in the app (`addCountry`, `addHub`, etc.) still
  doesn't check who's calling — `addProject` is the first, deliberately
  scoped to the one place it mattered most right now (a Hub Manager
  writing data tied to a specific hub). Extending the same pattern to
  the rest is still on the list.

## Previously: Phase 5 — Reporting Quotas + Role-Split Dashboards

## What's new in Phase 5

- **`ReportingQuotas` table + `Quotas.gs`** (Module 4, admin-only) — CRUD
  for reporting quotas: a Quarter (Q1–Q4) dropdown + a Reporting Year text
  field (format `YYYY-YYYY`, e.g. `2025-2026`). Duplicate Quarter+Year
  combos are blocked, and a quota can't be deleted once a project has been
  filed against it (that check is already wired up, ready for step 4).
- **`Projects` table — schema only, not wired up yet.** Defined now in
  `Config.gs` with every field steps 4 will need (reporting month, total
  new beneficiaries, female count, and all 11 age-band columns), the same
  way Hubs/HubManagers were pre-created ahead of their own modules. No
  `Projects.gs` or add-form exists yet — that's the next step.
- **Hub Managers now get a genuinely different dashboard.** Logging in as
  a Hub Manager shows `ManagerDashboard.html`: their hub's name, and a
  colorful card per *active* reporting quota with an **Add Project**
  button. Clicking it currently shows a toast — the actual monthly
  project form is step 4.
- **This is the first real, server-enforced role split.** `Router.gs`'s
  `getPageContent()` now takes the caller's session token: for the shared
  `dashboard` page key, it decides server-side which HTML file to return
  based on role (not just which one the client asked for), and it
  outright refuses to return Countries/Hubs/Hub Managers/Reporting Quotas
  content to anyone who isn't an Admin — regardless of what the sidebar
  looks like on their screen. The sidebar also hides admin-only links via
  `data-roles="Admin"` attributes + `applyRoleVisibility()` in
  `CommonJS.html`, but that's a UX nicety on top of the server-side check,
  not a substitute for it.

## Still not covered (matches earlier scope notes)

Other data functions (`getCountries`, `addHub`, etc.) still don't check a
session token themselves — only page *content* routing is role-checked so
far. Extending the same `getIdentity()`-based check into each module's
CRUD functions is the natural next hardening pass once the Projects form
(step 4) is built and we know the full shape of what a Hub Manager should
be allowed to touch (their own hub's projects, nothing else).

## Setup for this phase

1. Paste in the new files: `Quotas.gs`, `Quotas.html`, `QuotasJS.html`,
   `ManagerDashboard.html`, `ManagerDashboardJS.html`.
2. Update the changed files: `Config.gs`, `Router.gs`, `Sidebar.html`,
   `CommonJS.html`, `Index.html`, `DashboardJS.html`, `Hubs.gs`,
   `Styles.html`.
3. Run `initializeDatabase()` once so the new `ReportingQuotas` and
   `Projects` sheets get created.
4. Redeploy (**Deploy → Manage deployments → Edit → New version**).
5. Log in as Admin → **Reporting Quotas** → add one, e.g. Quarter `Q1`,
   Reporting Year `2025-2026`.
6. Log in as a Hub Manager (or open an incognito window) → the dashboard
   should now show that quota as a card with an **Add Project** button.

## Previously: Phase 4 — Real Admin Login

assumption with the same kind of credential-based login Hub Managers
already have.

## What's new in Phase 4

- **`Admins` table** (`Config.gs`) — Email is the primary key, same
  salted-hash password pattern as `HubManagers`.
- **`AdminAuth.gs`** — `adminLogin()`, and a one-time
  **`createInitialAdmin()`** you run from the Apps Script editor to
  create your first admin account (there's no self-registration —
  someone has to be the first admin).
- **`SessionService.gs`** — session creation/lookup used to be
  duplicated inside `ManagerAuth.gs`; it's now shared by both Admins and
  Hub Managers, plus a role-agnostic `getIdentity(token)` the SPA shell
  calls on load without needing to know which kind of user it is.
- **`Login.html`** — one login page for both roles, with an Admin /
  Hub Manager tab. Replaces the old standalone `ManagerLogin.html`
  (deleted). Reachable at `?page=login`, `?page=adminlogin`, or
  `?page=managerlogin` (the last one is what's already baked into every
  welcome email sent so far — kept working on purpose).
- **The dashboard now actually gates on login.** `Index.html` checks
  `localStorage` for a session token on load and calls the new
  `getIdentity()`; no valid session → redirect to `?page=login`. Before
  this, the SPA would render for anyone who opened the URL — Google's
  session was only ever used for *display*, never enforcement.
- `Auth.gs` (the old Google-session scaffold) is no longer called
  anywhere; kept only as a reference, clearly marked as legacy.

## ⚠️ Important — what login does *not* yet do

The gate above stops an anonymous visitor from **loading the dashboard
UI**. It does **not** yet stop someone from calling the underlying data
functions directly (`getCountries`, `addHub`, `deleteManager`, etc.) —
none of those check a session token yet. That's next on the list, once
the Hub Manager dashboard scoping (Projects/Quotas, steps 2–4 of your
plan) is far enough along to know what each role should actually be
allowed to touch. Treat this phase as "real login, UI gated" rather than
"fully access-controlled" for now.

## Setup for this phase

1. Paste in the new files: `AdminAuth.gs`, `SessionService.gs`,
   `Login.html`. Delete `ManagerLogin.html` if you still have it — it's
   superseded.
2. In the Apps Script editor, open `AdminAuth.gs`, edit the four values
   at the top of `createInitialAdmin()` (email, password, first/last
   name), then run it once from the function dropdown. Run it again
   later (with different details) any time you need another admin.
3. If you haven't already, run `initializeDatabase()` once so the new
   `Admins` sheet gets created.
4. Redeploy (**Deploy → Manage deployments → Edit → New version**).
5. Visit `<your web app URL>?page=login` and sign in with the admin
   account you just created.

## Previously: Schema changed — delete & recreate `HubManagers` and `Sessions`

`HubManagers` is keyed by **Email** (not an auto-generated `ManagerID`,
and not `DateAssigned` — that field is gone). It now collects
**FirstName, LastName, Phone** (matching the modal) plus the auth columns:
`PasswordHash`, `PasswordSalt`, `MustResetPassword`, `ResetToken`,
`ResetTokenExpiry`.

**Google Sheets reads/writes purely by column position, not by header
text.** If your `HubManagers` sheet was created by an earlier version of
this code (or has any manually-added columns), its physical column order
won't match what the current code expects — every field will read back
from the wrong cell, causing exactly the symptoms already seen: forms
that don't match the data, duplicate emails slipping through, and broken
password resets. **Before testing this version:**

1. Open your spreadsheet and **delete the `HubManagers` sheet/tab
   entirely** (and delete `Sessions` too, if it exists).
2. In the Apps Script editor, run `initializeDatabase` once more — this
   recreates both with the correct headers, empty.
3. Re-add any hub managers you need through the app (their old accounts
   won't carry over — this is a schema change, not a data migration).

### The password-reset "crash" is fixed

Root cause: `Database.gs` formats every `Date`-typed cell down to a bare
`yyyy-MM-dd` string when reading it back — fine for display dates, but it
silently dropped the *time* off `ResetTokenExpiry` and session
`ExpiresAt`. A link generated at, say, 2pm and meant to last 48 hours
could look expired as soon as the calendar date changed — sometimes
within hours. Fixed by storing those two fields as full ISO-8601 strings
at write time (see the comments in `Managers.gs` and `ManagerAuth.gs`) so
they never pass through that truncation. This is exactly why step 1
above (deleting the old sheet) matters — old rows have the truncated
format baked in and won't self-heal.

## What's included

**Server-side (.gs files)**
- `Code.gs` — web app entry point (`doGet`), now also routing to the
  standalone Manager Login / Reset Password pages
- `Config.gs` — `SCHEMA` (table definitions) and `APP_CONFIG`
- `Database.gs` — generic CRUD engine (`DB.*`); now also supports
  natural-key tables (`autoId: false`) like `HubManagers` (keyed by Email)
  and `Sessions` (keyed by token)
- `Auth.gs` — Google-session scaffold for the **admin** (`AUTH.*`)
- `ManagerAuth.gs` — separate auth track for **Hub Managers**: password
  reset (`validateResetToken`, `resetManagerPassword`), login
  (`managerLogin`), session lookup (`getManagerSession`), logout
- `Utilities.gs` — response envelope, pagination/search/sort, foreign-key
  resolution, and password/token helpers (`hashPassword`, `verifyPassword`,
  `generateRandomPassword`, `generateSecureToken`)
- `Validation.gs` — reusable field validators (`Validate.*`)
- `EmailService.gs` — outbound transactional email (currently the Hub
  Manager welcome email); the place to add future emails (notifications,
  report delivery, ...)
- `Router.gs` — maps page keys to HTML partials for the single-page app
- `Countries.gs`, `Hubs.gs`, `Managers.gs` — CRUD for each module
- `Dashboard.gs` — dashboard summary stats

**Frontend — SPA shell (.html files)**
- `Index.html` — SPA shell (sidebar + topnav + content area)
- `Sidebar.html`, `Topnav.html`, `Styles.html` — layout & styling
- `CoreJS.html` — low-level utilities with no shell dependency
  (`runServer`, `showToast`, `debounce`, `renderPagination`, `escapeHtml`) —
  shared by the SPA **and** the standalone auth pages below
- `CommonJS.html` — SPA-shell-specific JS: page routing, nav state, and
  top-nav identity (detects a logged-in Hub Manager vs. the Google-session admin)
- `Dashboard.html` / `DashboardJS.html`, `Countries.html` / `CountriesJS.html`,
  `Hubs.html` / `HubsJS.html`, `Managers.html` / `ManagersJS.html` — one
  page + one script per module

**Frontend — standalone auth pages (outside the SPA shell)**
- `ManagerLogin.html` — email + password login for returning Hub Managers
- `ResetPassword.html` — reached from the welcome-email link; sets a new
  password and auto-logs the manager straight into the dashboard

## How Hub Manager accounts work

1. **Admin adds a Hub Manager** (First Name, Last Name, Phone, Email, Hub) from the Hub
   Managers page. `Managers.gs#addManager`:
   - Validates the Hub exists and the email isn't already registered.
   - Generates a random temporary password and a long random reset token.
   - Stores only a **salted SHA-256 hash** of the password — the plaintext
     password is never written to the sheet.
   - Emails the manager (via `EmailService.gs`) their login email, the
     temporary password, and a "Set My Password" link.
2. **Manager clicks the link** → lands on `ResetPassword.html`
   (`?page=resetpassword&email=...&token=...`). The token is validated
   server-side (`validateResetToken`) before showing the form.
3. **Manager sets a new password** → `resetManagerPassword` hashes it,
   clears the reset token so it can't be reused, and **immediately issues
   a session** — the manager is auto-logged-in and redirected straight to
   the dashboard, per the requested flow (no separate login step needed
   the first time).
4. **On later visits**, the manager goes to `?page=managerlogin` and signs
   in with their email + the password they set. A session token is stored
   in the browser's `localStorage` (Apps Script's `HtmlService` has no
   server-side cookie session of its own) and validated against the
   `Sessions` table on every page load.
5. **Today, a logged-in Hub Manager sees the exact same dashboard as the
   admin** — no data or menu restrictions yet. That's intentional per your
   instructions; scoping their view to just their own hub is a follow-up.

Admins are unaffected — they still access the app directly via their
Google session (`Auth.gs`), with no login screen. The two identity systems
are deliberately kept separate; `CommonJS.html` just decides which one to
display in the top nav.

## Setup

1. Create a new Google Apps Script project (script.google.com → New
   project), or create a Google Sheet and open **Extensions → Apps Script**.
2. Create each file listed above with the exact same name (Apps Script
   needs `.gs` files as Script files and `.html` files as HTML files) and
   paste in the matching content.
3. In `Config.gs`, leave `SPREADSHEET_ID` blank if the script is bound to a
   Sheet, or paste a Spreadsheet ID if running standalone.
4. Run `initializeDatabase` once from the script editor (function dropdown
   → `initializeDatabase` → Run). This creates `Countries`, `Hubs`,
   `HubManagers`, and `Sessions` with the correct headers. **If you had a
   Phase 2 `HubManagers` sheet, delete it first** (see the warning above).
5. Deploy: **Deploy → New deployment → Web app**. Set "Execute as: Me" and
   "Who has access: Anyone" (Hub Managers won't have Google accounts tied
   to this project, so they need anonymous access to the login/reset
   pages). Deploy and open the URL.
6. The first time the app sends an email, Google will prompt you to
   **authorize the "Send email as you" permission** for `MailApp` — approve
   it, or welcome emails will silently fail. `MailApp` sends from your own
   Google account and is subject to your daily Gmail sending quota.

## Try it

- **Countries / Hubs**: unchanged from Phase 2 — full CRUD, search, sort,
  pagination, the Country dropdown/filter on Hubs.
- **Hub Managers**: add one with a real email address you can check. You
  should receive a welcome email within a minute or two. Click **Set My
  Password** in that email, choose a password (8+ characters), and you'll
  land straight in the dashboard.
- Open an incognito window and go to `<your web app URL>?page=managerlogin`
  to try logging back in with that manager's email + new password.
- On the Hub Managers list: the **Account** column shows "Awaiting setup"
  vs. "Password set." Use the resend icon (<i class="bi bi-envelope-arrow-up"></i>)
  to re-issue credentials if a link expires (`RESET_TOKEN_HOURS` in
  `Config.gs`, default 48 hours) or the email gets lost.
- Deleting a Hub is blocked once a manager is assigned to it
  (`DB.hasDependents('Hubs', id, 'HubManagers', 'HubID')`).

## Known simplifications (by design, for now)

- Hub Managers see the full admin dashboard after logging in — no
  restriction to their own hub's data yet. You mentioned handling
  restrictions later; the identity is already available client-side via
  `window.MNE_CURRENT_MANAGER` (`{ email, fullName, hubId }`) and
  server-side via `getManagerSession()` whenever you're ready to scope views.
- Sessions live in a `Sessions` sheet rather than a hardened auth
  provider — reasonable for an internal tool at this scale, but if this
  ever needs to survive serious concurrent load or stricter security
  requirements, that's the component to swap out first.
- Password reset links are single-use per issuance (the token is cleared
  after a successful reset) but there's no rate-limiting on login attempts
  yet — worth adding before wider rollout.

## Next steps

Natural follow-ups from here: scoping a Hub Manager's dashboard to just
their own hub (Projects, Indicators, Monitoring Visits, etc. filtered by
`hubId`), an admin-side "force password reset" action, and building out
the next M&E modules (Projects, Indicators, Beneficiaries, ...) using the
same schema-first, `DB.*`-only pattern established so far.
