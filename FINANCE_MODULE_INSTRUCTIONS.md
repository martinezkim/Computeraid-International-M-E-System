# Master Implementation Instructions — Financial Management & Project Funds Module

**For:** a coding agent (Claude Sonnet 5) working in this repository
**Target codebase:** `mne-system-phase14` — the existing Computeraid International M&E system (Google Apps Script + Google Sheets, deployed via `clasp`)
**Companion:** the beneficiary PWA in `../sch-pwa` is **out of scope** for this module unless a section explicitly says otherwise.

> Read this whole document before writing any code. It is deliberately opinionated so you do **not** re-derive architecture or duplicate things that already exist. Where it says "MUST", it means a convention this codebase already enforces and that a reviewer will reject you for breaking.

---

## 0. What you are building (one paragraph)

A **financial monitoring and project-accountability layer** bolted onto the existing M&E platform, so an Admin can answer at any moment: *how much was received, how much is in the bank, how much is committed but unpaid, how much is actually available, what it was spent on, and what document backs each spend.* It is **not** an accounting system, not payroll, not a general ledger. Every user-facing figure must be **traceable by click-through to the underlying transactions**, and **no financial record is ever hard-deleted** — cancellation is a status, not a row removal.

---

## 1. Three architecture decisions already made (do not re-litigate)

1. **Roles: reuse the existing two roles.** There is no new "Finance" role. `Admin` = full finance visibility + the only approver + the only one who sees individual salaries and full bank-account numbers. `HubManager` = submits invoices/expenses/reimbursements **for their own hub only**, sees **their own hub's** finances, sees staff costs **only as aggregated totals** (never per-person salary lines), and **cannot approve anything**. Separation of duties is enforced by a **"the approver's email must differ from the submitter's email"** rule (`assertNotSelfApproval_`), not by a role.
2. **Financial documents are private and server-gated.** Do **NOT** copy the beneficiary-photo pattern (which uses `DriveApp.Access.ANYONE_WITH_LINK` + a public thumbnail URL). Financial files stay private in a dedicated Drive folder and are returned only through an authenticated Apps Script endpoint that checks the caller's role/hub first. The client never receives a Drive file ID or a Drive URL.
3. **Staff are a new lightweight master table** (`FinanceStaff`). Salaries and reimbursements link to it by `StaffID`. Do not invent a heavyweight HR entity and do not assume paid staff are system users.

---

## 2. Non-negotiable codebase conventions (these already exist — obey them)

### 2.1 The `DB` engine and `SCHEMA` (`Database.gs`, `Config.gs`)
- Every "table" is a Google Sheet declared in the `SCHEMA` object in `Config.gs`. `DB.getAll`, `DB.getById`, `DB.insert`, `DB.update`, `DB.remove` read/write **positionally** by the order of `columns` in the schema.
- **APPEND-ONLY COLUMN RULE (critical):** when adding a column to an existing table you MUST append it at the **end** of that table's `columns` array — never insert or reorder. Old rows then simply read back `''`/`undefined` for the new column until rewritten. New *tables* can be added anywhere in the `SCHEMA` object.
- Primary keys: set `idPrefix`/`idPadding` and let `DB.generateId()` mint IDs (`FA001`, `INV0001`, …). Never use row numbers as identifiers.
- `searchableColumns` feeds the shared search helper; `foreignKeys` documents relationships (used for integrity checks, not enforced by the sheet).

### 2.2 Standard server-function shape
Every client-callable server function follows this exact pattern (copy it):

```js
function createInvoice(sessionToken, data) {
  return safeExecute(function () {              // Utilities.gs — wraps result/error into {success, data, message}
    var identity = requireIdentity_(sessionToken);   // Beneficiaries.gs — throws if not logged in; returns {email, role, hubId}
    // ... validate, mutate via DB.*, logAudit_, return a plain object ...
  });
}
```

- `requireIdentity_(token)` → any authenticated user, returns `{email, role, hubId}`.
- `requireAdminSession_(token)` (Projects.gs) → throws unless role === 'Admin'.
- `requireManagerSession_(token)` (Projects.gs) → throws unless role === 'HubManager', returns `{..., hubId}`.
- `withField_(record, extra)` (AdminInventory.gs) → returns a shallow copy with extra display fields merged in (use for `HubName`, computed masks, etc.).
- `paginateAndFilter(records, {search, searchColumns, sortBy, sortDir, page, pageSize})` (Utilities.gs) → the shared list-endpoint shape. Every "list" endpoint funnels through it.
- `hubNameLookup_()` (AdminInventory.gs) → `{HubID: HubName}`.

### 2.3 Audit logging (`AuditLog.gs`)
Signature: `logAudit_(actor, action, tableName, recordId, fieldName, oldValue, newValue, hubId)` where `actor` is the `identity` object. Call it on **every** create, approve, reject, return, pay, adjust, cancel, and document upload. For status changes, log `oldValue`→`newValue`. Finance rows land in the existing Audit Log page automatically — no separate audit store needed.

### 2.4 Private-function naming caveat
A function name ending in a trailing underscore (`fooBar_`) is **hidden from the Apps Script editor's Run dropdown**. Keep internal helpers underscore-suffixed. Any function that the Admin must run **by name from the editor** (seed/init/migration) MUST **not** end in an underscore.

### 2.5 Currency (`Settings.gs`, `CoreJS.html`)
A single system currency already exists: `getSystemCurrency` / `setSystemCurrency`, default `KES`, exposed to the client as `window.MNE_CURRENCY = {code, symbol}` and formatted via `formatCurrency(amount)` in `CoreJS.html`. **Reuse these.** For Phase 1, each `FinancialAccount` carries its own `Currency` (defaulting to the system currency) and **you never sum across currencies** — see §6.

### 2.6 Client page conventions
- Each page is a pair: `XHT.html` (markup) + `XJS.html` (an IIFE `<script>` that listens for `document.addEventListener('page:loaded', e => { if (e.detail.page !== 'x') return; ... })` and checks `window.MNE_CURRENT_USER.role`).
- Shared client helpers already exist in `CoreJS.html`: `formatCurrency`, `formatDateDisplay`, `animateCount`, `escapeHtml`, `debounce`, `renderPagination`, `exportRecordsToFile`, `runServer` (promise wrapper over `google.script.run`), `showToast`.
- Multi-section pages use the **pill-tab** pattern (`.pill-tabs` / `.pill-tab` / `.usage-pane`) — see `HubUsageHT.html`/`MyHubUsageHT.html` for a live example; prefer this over adding many sidebar links.

### 2.7 Wiring a new page (4 files, every time)
1. `Router.gs` → add `pagekey: 'XHT'` to `ROUTES`, and add the key to `ADMIN_ONLY_PAGES` and/or `MANAGER_ONLY_PAGES`.
2. `Sidebar.html` → add an `<a class="nav-link" data-page="pagekey" data-roles="Admin">` under a section label (see §7 for the Finance section).
3. `CommonJS.html` → add `pagekey: 'Human Title'` to `PAGE_TITLES`.
4. Create `XHT.html` + `XJS.html`.

### 2.8 Deploy workflow (never deviate)
- Push with `clasp push --force`. **Never** `clasp deploy -i` (it has broken web-app access config before).
- The human cuts the live version manually: Deploy → Manage deployments → Edit → Version → **New version** → Deploy. Your job ends at "pushed + tell the human to deploy."
- Syntax-check `.gs` by copying to a `.js` temp and running `node --check`; syntax-check embedded `<script>` blocks by extracting them first. (`.gs` and `.html` are not directly node-checkable.)

### 2.9 Drive/OAuth caveat (flag to the human, don't fight it)
First use of `DriveApp` requires (a) the owner to trigger the OAuth consent screen by running any function once from the editor, and (b) the **Drive API enabled** on the bound GCP project (`303803162605`) via Cloud Console → APIs & Services → Library. Surface this in your handoff notes; it is an environment step, not a code bug.

---

## 3. The financial model — the single most important part

There are **four distinct money states**. Never collapse them into one number.

| State | Meaning | Trigger | Effect on balances |
|---|---|---|---|
| **Pending Approval** | Submitted, not yet approved | `Status ∈ {Submitted, Under Review, Returned}` | None on bank/available. Shown as an informational total only. |
| **Committed** | Approved but not yet paid | `Status = Approved` **and** `PaymentStatus ≠ Paid` | Reduces **Available After Commitments**, NOT the bank balance. |
| **Paid (Actual)** | Money has actually left the account | `PaymentStatus = Paid` | Reduces **Current Bank Balance** (and therefore Available too). |
| **Void** | Rejected / Returned-abandoned / Cancelled | `Status ∈ {Rejected, Cancelled}` | Excluded from **all** math. Retained forever for audit. |

### 3.1 The two headline formulas (must be transparent + traceable)

```
Current Bank Balance
  =  Opening Balance
   + Σ Confirmed Funding Received
   + Σ Approved Balance Adjustments (signed)
   + Σ Other actual income / refunds (paid)
   − Σ Paid outflows (invoices + expenses + salaries + reimbursements + bank charges, PaymentStatus = Paid)

Available After Commitments
  =  Current Bank Balance
   − Σ Approved-but-unpaid commitments (invoices + expenses + salaries + reimbursements, Status = Approved & PaymentStatus ≠ Paid)
```

- **An invoice being raised deducts nothing.** Approval moves it into Committed. Payment moves it into Paid. This is the whole point — do not deduct on creation.
- Every figure the dashboard shows must have a **drill-down**: clicking "Committed KES 1,500,000" opens the filtered list of the exact records that sum to it.

### 3.2 Where balances are computed — DECISION: compute on read, do not maintain a synced ledger
Google Sheets has no transactions/atomicity. A separately-stored double-entry ledger that must be kept in sync **will drift** under this engine. Therefore:
- **The source tables are the single source of truth** (Invoices, Expenses, Salaries, Reimbursements, FundingTransactions, BalanceAdjustments).
- The **balance engine** (`FinanceBalance.gs`) computes every figure by scanning those tables and filtering on `Status`/`PaymentStatus`/`AccountID` at query time — exactly how `UsageKPIs.gs` computes M&E KPIs on read today.
- The spec's "central transaction ledger" (§22) is satisfied as a **computed read-only view**: `getFinancialLedger()` unifies rows from the source tables into one chronological list at query time. It is **not** a stored table you must keep in sync. Document this clearly in code comments so a future reader doesn't "fix" it into a stored ledger.

---

## 4. Data model — add these to `SCHEMA` in `Config.gs`

Phase 1 (MVP) tables are marked **[MVP]**; later-phase tables **[P2]**. Column lists below are the **initial** order; obey the append-only rule for any later additions. All tables include `DateCreated, DateModified` as the last two columns (the engine stamps them).

```
FinanceCategories [MVP]   idPrefix 'FC'  — config list, admin-managed (mirrors Activities.gs)
  CategoryID, Name, Type ('Expense'|'Income'), Active, SortOrder, DateCreated, DateModified

FinanceStaff [MVP]        idPrefix 'STF'
  StaffID, FullName, StaffNumber, RoleTitle, HubID, Email, Status, DateCreated, DateModified

FinancialAccounts [MVP]   idPrefix 'FA'
  AccountID, AccountName, BankName, AccountNumber, Currency, AccountType,
  HubID, ProjectID, OpeningBalance, OpeningBalanceDate, Status,
  CreatedByEmail, DateCreated, DateModified
  # AccountNumber is stored full but NEVER returned raw — see §8. Display uses a computed AccountNumberMasked.

FundingTransactions [MVP] idPrefix 'FND'
  FundingID, DateReceived, Amount, Currency, FundingSource, Donor, ProjectID, HubID,
  AccountID, ReferenceNumber, Description, DocumentID, Status ('Recorded'|'Confirmed'),
  EnteredByEmail, DateEntered, DateCreated, DateModified
  # Only 'Confirmed' funding counts toward balances.

Invoices [MVP]            idPrefix 'INV'  idPadding 4
  InvoiceID, InvoiceNumber, InvoiceDate, DateSubmitted, SupplierName, SupplierContact,
  SupplierInvoiceRef, ProjectID, HubID, ExpenseCategory, BudgetLineID, Description,
  Amount, TaxAmount, TotalAmount, Currency, PaymentMethod, AccountID, InvoiceDocumentID,
  Status, SubmittedByEmail, SubmittedByRole, ReviewedByEmail, ApprovedByEmail, ApprovalDate,
  RejectionReason, PaymentStatus, PaymentDate, PaymentReference, Notes, DateCreated, DateModified

Expenses [MVP]            idPrefix 'EXP'  idPadding 4
  ExpenseID, Date, PayeeName, StaffID, Description, Amount, TaxAmount, TotalAmount, Currency,
  ProjectID, HubID, ExpenseCategory, BudgetLineID, PaymentMethod, AccountID, ReceiptDocumentID,
  Status, SubmittedByEmail, SubmittedByRole, ApprovedByEmail, ApprovalDate, RejectionReason,
  PaymentStatus, PaymentDate, PaymentReference, Notes, DateCreated, DateModified

Salaries [MVP]            idPrefix 'SAL'  idPadding 4   # Admin-only visibility of individual rows
  SalaryID, StaffID, Month, ProjectID, HubID, GrossAmount, Allowances, Deductions,
  NetProjectCost, Currency, AccountID, PayrollDocumentID, Status, ApprovedByEmail, ApprovalDate,
  PaymentStatus, PaymentDate, PaymentReference, DateCreated, DateModified

Reimbursements [MVP]      idPrefix 'RMB'  idPadding 4
  ReimbursementID, StaffID, Date, ProjectID, HubID, ActivityRef, ExpenseCategory, BudgetLineID,
  Description, Amount, Currency, Reason, ReceiptDocumentID, Status, ApprovedAmount, ApprovedByEmail,
  ApprovalDate, RejectionReason, PaymentStatus, PaymentDate, PaymentReference, DateCreated, DateModified

Budgets [MVP]             idPrefix 'BGT'
  BudgetID, ProjectID, HubID, Name, FinancialYear, TotalBudget, Currency, Status, DateCreated, DateModified

BudgetLines [MVP]         idPrefix 'BGL'
  BudgetLineID, BudgetID, ExpenseCategory, BudgetedAmount, Currency, DateCreated, DateModified

FinancialDocuments [MVP]  idPrefix 'DOC'  idPadding 4   # PRIVATE — see §8
  DocumentID, DriveFileID, FileName, MimeType, LinkedTable, LinkedRecordID, DocumentType,
  UploadedByEmail, DateUploaded, DateCreated, DateModified

BalanceAdjustments [MVP]  idPrefix 'ADJ'   # controlled; requires reason + approver
  AdjustmentID, Date, AccountID, Amount, Reason, DocumentID, MadeByEmail, ApprovedByEmail,
  ApprovalDate, Status, DateCreated, DateModified

# ---- Phase 2 (design the above so these slot in without migration) ----
BankStatements [P2]       idPrefix 'BST'  (AccountID, StatementDate, ClosingBalance, FileDocumentID, Status, ...)
BankTransactions [P2]     idPrefix 'BTX'  (StatementID, Date, Description, Amount, MatchedTable, MatchedRecordID, MatchStatus, ...)
Reconciliations [P2]      idPrefix 'REC'  (AccountID, StatementDate, SystemBalance, StatementBalance, Status, Notes, ReconciledByEmail, ...)
ExchangeRates [P2]        idPrefix 'FX'   (FromCurrency, ToCurrency, Rate, RateDate, Source, ...)
Notifications [P2]        idPrefix 'NTF'  (Type, Message, TargetRole, TargetEmail, RelatedTable, RelatedRecordID, Read, ...)
```

**Payments:** for MVP, payment is represented by the `PaymentStatus`/`PaymentDate`/`PaymentReference` fields on each source document — do **not** build a separate `Payments` table yet. Note in comments that a `Payments` table can be added in P2 to support partial payments.

**Reuse, never duplicate:** `HubID` → existing `Hubs`; `ProjectID` → existing `Projects` (the platform collapsed "Program" into "Project" earlier — treat "Program" as a free-text/label concept or map it to `Projects`; do **not** create a Programs table). Do not create new Hub/User/Project tables.

---

## 5. Status workflows (implement exactly)

**Invoice:** `Draft → Submitted → Under Review → (Approved | Rejected | Returned)`; after `Approved`: `PaymentStatus: Unpaid → Paid`. Rejected/Returned are terminal-but-retained.
**Expense / Reimbursement:** `Draft → Submitted → Under Review → (Approved | Rejected | Returned) → Paid`.
**Reimbursement** additionally captures `ApprovedAmount` (may differ from requested `Amount`).
**Salary:** `Draft → Approved → Paid` (no beneficiary-style review loop needed, but still Admin-approved).
**Funding:** `Recorded → Confirmed` (only Confirmed counts).
**Balance Adjustment:** `Draft → Approved` (requires `Reason` + a different `ApprovedByEmail`).

Cancellation is a status (`Cancelled`) on any of the above — **never `DB.remove`** a finance record. (This differs from the beneficiary module, which does allow delete. Finance is no-delete.)

---

## 6. Multi-currency rule for Phase 1
- Each account has one currency. Amounts on a document inherit their account's currency.
- **Never sum amounts of different currencies into one total.** Balance/report endpoints group by currency (or by account) and the dashboard labels the reporting currency explicitly.
- Default currency = the system currency from `Settings.gs`.
- True conversion (`ExchangeRates`, converted amounts) is **Phase 2** — leave `Amount` in original currency and design totals as per-currency maps now so conversion drops in later.

---

## 7. Navigation — add a "Finance" section
In `Sidebar.html`, add a new `<div class="nav-section-label" data-roles="Admin,HubManager">Finance</div>` and links below it. Keep the list short by using pill-tabs inside pages. Suggested Phase-1 pages (adapt names to taste, wire per §2.7):

| Page key | Title | Roles | Notes |
|---|---|---|---|
| `financedashboard` | Financial Dashboard | Admin | headline figures + alerts + drill-down |
| `myfinance` | Financial Overview | HubManager | own-hub figures, aggregated staff cost only |
| `financeaccounts` | Bank Accounts & Funding | Admin | tabs: Accounts / Funding Received / Adjustments |
| `invoices` | Invoices | Admin | tabs: All / **Awaiting Approval** / Rejected |
| `myinvoices` | Invoices | HubManager | submit + view own-hub |
| `expenses` | Expenses & Reimbursements | Admin | tabs: Expenses / Reimbursements / Approvals |
| `myexpenses` | Expenses & Reimbursements | HubManager | submit + view own-hub |
| `salaries` | Salaries | Admin **only** | individual salary rows live here |
| `budgets` | Budgets | Admin | budget + lines + Budget-vs-Actual |
| `financereports` | Financial Reports | Admin | monthly / project / hub / category exports |

Finance audit trail = the **existing Audit Log page** (finance actions are logged there). Optionally add a `financeaudit` filtered view later.

---

## 8. Private document storage (implement carefully — this is the security-sensitive part)

**Upload** (`FinanceDocuments.gs`):
```js
// Owner sets this once: Script Properties → FINANCE_DRIVE_FOLDER_ID = <a private Drive folder id>
function uploadFinancialDocument_(identity, opts) {
  // opts: {base64, mimeType, fileName, linkedTable, linkedRecordId, documentType}
  var folderId = PropertiesService.getScriptProperties().getProperty('FINANCE_DRIVE_FOLDER_ID');
  if (!folderId) throw new Error('Financial document storage is not configured (FINANCE_DRIVE_FOLDER_ID).');
  var folder = DriveApp.getFolderById(folderId);
  var blob = Utilities.newBlob(Utilities.base64Decode(opts.base64), opts.mimeType, opts.fileName);
  var file = folder.createFile(blob);
  // DO NOT call file.setSharing(ANYONE_WITH_LINK, ...). Leave it private to the folder/owner.
  var rec = DB.insert('FinancialDocuments', {
    DriveFileID: file.getId(), FileName: opts.fileName, MimeType: opts.mimeType,
    LinkedTable: opts.linkedTable, LinkedRecordID: opts.linkedRecordId,
    DocumentType: opts.documentType, UploadedByEmail: identity.email, DateUploaded: new Date()
  });
  logAudit_(identity, 'UploadDoc', 'FinancialDocuments', rec.DocumentID, 'file', '', opts.fileName, '');
  return rec.DocumentID; // return the DOC id ONLY — never the Drive id/url
}
```

**Serve** (gated read; the only way the client ever sees a file):
```js
function getFinancialDocument(sessionToken, documentId) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var doc = DB.getById('FinancialDocuments', documentId);
    if (!doc) throw new Error('Document not found.');
    // Admin sees all. HubManager only if the linked record belongs to their hub.
    if (identity.role !== 'Admin') {
      assertManagerOwnsLinkedRecord_(identity, doc); // resolve LinkedTable/LinkedRecordID → HubID, compare to identity.hubId
    }
    var file = DriveApp.getFileById(doc.DriveFileID);
    var blob = file.getBlob();
    return { fileName: doc.FileName, mimeType: doc.MimeType,
             base64: Utilities.base64Encode(blob.getBytes()) };
  });
}
```
Client renders/downloads from the returned base64 as a `data:` URL. **The DriveFileID and any Drive URL must never reach the client.** Salary/payroll documents follow the same path but are Admin-only.

---

## 9. Roles, separation of duties, salary privacy (enforce server-side)

- **List endpoints are hub-scoped for managers.** `getMyHubInvoices`/`getMyHubExpenses`/… filter `HubID === identity.hubId`. Admin endpoints (`getAllInvoices`, …) see everything with an optional `hubId` filter — mirror `getAllFeedback`/`getMyHubFeedback` in `Feedback.gs`.
- **Only Admin approves.** Approve/reject/return/pay endpoints call `requireAdminSession_`.
- **Self-approval guard:** every approve endpoint calls `assertNotSelfApproval_(record, identity)` which throws if `record.SubmittedByEmail === identity.email`. (Matters when an Admin also submitted the record — a second Admin must approve.)
- **Salaries:** individual `Salaries` rows are returned **only** to Admin. For managers, expose `getMyHubStaffCostSummary(token, {month})` returning **aggregated totals only** (e.g. `{month:'2026-07', totalStaffCost: 450000, currency:'KES'}`) with **no per-person names or amounts**. Never send a `Salaries` row to a non-Admin client.
- **Account numbers:** strip before returning. Add `maskAccountNumber_(full)` → `'•••• 4321'`; return `AccountNumberMasked` in all responses; return the full number to nobody through the client (mirrors `stripSensitiveManagerFields` in `Managers.gs`).

---

## 10. Balance engine skeleton (`FinanceBalance.gs`)

```js
function getAccountFinancials_(accountId) {
  var acct = DB.getById('FinancialAccounts', accountId);
  var opening = Number(acct.OpeningBalance) || 0;

  var funding = sumWhere_('FundingTransactions', function (f) {
    return f.AccountID === accountId && f.Status === 'Confirmed';
  }, 'Amount');

  var adjustments = sumWhere_('BalanceAdjustments', function (a) {
    return a.AccountID === accountId && a.Status === 'Approved';
  }, 'Amount'); // Amount is signed

  var paidOut = paidOutflowsForAccount_(accountId);          // invoices+expenses+salaries+reimbursements, PaymentStatus='Paid'
  var committed = approvedUnpaidForAccount_(accountId);       // Status='Approved' && PaymentStatus!='Paid'
  var pending = pendingApprovalForAccount_(accountId);        // Status in Submitted/Under Review/Returned

  var currentBank = opening + funding + adjustments - paidOut;
  return {
    currency: acct.Currency,
    openingBalance: opening,
    fundingConfirmed: funding,
    adjustments: adjustments,
    paidExpenditure: paidOut,
    currentBankBalance: currentBank,
    committedFunds: committed,
    availableAfterCommitments: currentBank - committed,
    pendingApproval: pending
  };
}
```
Provide `getFinancialDashboard(token)` (Admin, all accounts grouped by currency) and `getMyHubFinancialSummary(token)` (manager, own hub, staff cost aggregated). Every summing helper must also be able to **return the underlying record list** for the drill-down (either a second endpoint like `getInvoices({status:'Approved', paymentStatus:'Unpaid'})`, or a `detail:true` flag).

---

## 11. Budget vs Actual (`Budgets.gs`)
For each `BudgetLine`: `Budgeted` (from the line), `Actual` (Σ paid outflows in that `ExpenseCategory` + project), `Committed` (Σ approved-unpaid same scope), `Remaining = Budgeted − Actual − Committed`, `PercentUsed = (Actual+Committed)/Budgeted`. Filterable by project/hub/month/category. Emit a warning flag when `PercentUsed ≥ 0.75` (approaching) and `≥ 1.0` (exceeded).

## 12. Dashboard alerts (compute server-side, render as banners)
Low available balance (below a configurable threshold in Script Properties), budget ≥75%/≥100%, count of approved expenses **missing a receipt** (`ReceiptDocumentID` empty on a Paid/Approved expense), count of invoices awaiting approval, funding recorded-but-not-confirmed. Thresholds live in Script Properties (e.g. `FINANCE_LOW_BALANCE_THRESHOLD`).

## 13. Reports (`FinanceReports.gs`)
Monthly, per-project, per-hub, per-category summaries reusing the balance engine. Export via the existing `exportRecordsToFile(records, columns, format, filename)` (CSV/Excel/PDF) — do not build a new exporter.

## 14. M&E integration (light, Phase 1)
On the project financial report, show **Cost per Beneficiary = total paid project expenditure ÷ project beneficiary count** (pull the count the same way the dashboards already do). Label it plainly as a cost ratio; **do not** frame it as impact/value-for-money. This is display-only; no schema change.

---

## 15. Build order within Phase 1 (push + ask the human to deploy after each group so it's verifiable)

1. **Schema + config lists:** add all `[MVP]` tables to `Config.gs`; build `FinanceCategories.gs` (+ admin config UI, mirror `Activities.gs`) and `FinanceStaff.gs` (+ small admin page). Add a public (no-underscore) `initFinanceModule` function that creates any missing sheets/seeds default categories, runnable from the editor.
2. **Accounts + Funding + Balance engine:** `FinanceAccounts.gs`, `Funding.gs`, `FinanceBalance.gs`, `BalanceAdjustments.gs`, plus the Bank Accounts & Funding page and a first cut of the Financial Dashboard (headline figures, per currency).
3. **Documents:** `FinanceDocuments.gs` (private upload + gated `getFinancialDocument`), wired into an upload control the other modules reuse.
4. **Invoices + approval:** `Invoices.gs` (+ self-approval guard, status workflow), the Admin Invoices page with the **Awaiting Approval** tab, and the manager `myinvoices` submit page.
5. **Expenses + Reimbursements:** `Expenses.gs`, `Reimbursements.gs`, Admin + manager pages, approvals.
6. **Salaries:** `Salaries.gs` (Admin-only rows) + `getMyHubStaffCostSummary` aggregate; Salaries page.
7. **Budgets + Budget-vs-Actual:** `Budgets.gs`, budgets page.
8. **Reports + dashboard alerts:** `FinanceReports.gs`, alert banners, drill-downs from every headline figure.

Each step: `node --check` the `.gs`/extracted scripts → `clasp push --force` → tell the human to cut a new version → verify live.

---

## 16. Testing plan (verify before declaring done — mirrors the source spec §49)

**Balance math**
- Opening 5,000,000; Confirm funding 2,000,000; mark one expense 1,000,000 Paid ⇒ Current Bank = **6,000,000**.
- Approve an invoice 1,500,000 but leave Unpaid ⇒ Current Bank still **6,000,000**, Committed = **1,500,000**, Available After Commitments = **4,500,000**.
- Raise a fresh invoice (Submitted) ⇒ **no** change to bank/available; Pending Approval reflects it.
- Reject an invoice ⇒ excluded from all totals but still listed/auditable.

**Workflows** — create→submit→approve→pay for invoice, expense, reimbursement (incl. `ApprovedAmount ≠ Amount`); reject with mandatory reason; return-for-correction; cancel (row persists as `Cancelled`).

**Budget** — Budgeted − Actual − Committed = Remaining; 75%/100% warnings fire.

**Security** (each must FAIL for the wrong actor)
- HubManager cannot read another hub's invoices/expenses/accounts.
- HubManager cannot approve anything.
- HubManager cannot retrieve an individual `Salaries` row or a salary document; only the aggregate.
- An Admin who submitted a record cannot self-approve it.
- `getFinancialDocument` denies a manager a document linked to a different hub.
- No endpoint returns a full `AccountNumber`.
- No delete path exists for any finance table; a "cancel" leaves the row present with `Status='Cancelled'` and an audit entry.

**Audit** — every create/approve/reject/return/pay/adjust/upload writes an Audit Log row with actor, action, old→new.

---

## 17. Before you write code — produce a short design confirmation
Post a brief confirmation (not a novel) covering: final table list + any column deltas from §4, the exact status enums, the balance-engine function list, and the Phase-1 page/nav list. Then build in the §15 order. Most of the design is already fixed above — you are confirming and filling gaps, not redesigning.

## 18. Hard rules recap (a reviewer will reject violations)
- Append-only columns; new tables anywhere; never reorder.
- Every server fn: `safeExecute` + an identity/role guard.
- No hard delete of any finance record — ever. Cancel = status.
- Raising an invoice deducts nothing; approve→Committed; pay→Bank.
- Never sum across currencies (Phase 1).
- Financial documents private + server-gated; no `ANYONE_WITH_LINK`; no Drive id/url to client.
- Individual salaries + full account numbers: Admin only, stripped for everyone else.
- `logAudit_` on every state change.
- `clasp push --force` only; human cuts the version.
- This is **financial monitoring, not accounting** — no claim of statutory accounts, tax, payroll compliance, or GL replacement; no AI auto-approval of anything (AI is draft-only and human-reviewed, Phase 3).

---

### Appendix A — Phased scope
- **Phase 1 (this build):** everything above marked `[MVP]` — dashboard, accounts, opening balance, funding, invoices + approval, expenses, receipts (private), reimbursements, payment status, current/committed/available balances, monthly + category summaries, basic budgets, budget-vs-actual, alerts, audit trail, role-based access, secure document upload.
- **Phase 2:** bank reconciliation, CSV/Excel statement import + matching, multi-currency conversion (`ExchangeRates`), configurable notifications, AI receipt extraction, `Payments` table for partial payments.
- **Phase 3:** cost-per-beneficiary / cost-per-output analytics, AI anomaly detection (unusual/duplicate/underused-budget flags), forecasting, cash-flow projection. AI output is always human-reviewed and never auto-approves.
