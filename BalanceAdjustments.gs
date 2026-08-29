/**
 * ============================================================
 * BALANCEADJUSTMENTS.GS — Controlled, audited balance corrections (Phase 17)
 * ============================================================
 * The ONLY sanctioned way to correct an account's calculated balance
 * outside of the normal funding/expenditure flow (e.g. a bank charge
 * the source tables don't otherwise capture). Amount is signed
 * (+ increases the balance, - decreases it). Requires a Reason and,
 * like every other finance approval, the approver must be a different
 * person from whoever raised it — see assertNotSelfApproval_ in
 * FinanceCommon.gs.
 * ============================================================
 */

var BALANCE_ADJUSTMENTS_TABLE = 'BalanceAdjustments';
var BALANCE_ADJUSTMENT_STATUSES = ['Draft', 'Approved', 'Rejected'];

/** Admin only — the whole adjustments workflow is Admin-to-Admin by design. */
function getBalanceAdjustments(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var accountsById = {};
    DB.getAll(FINANCIAL_ACCOUNTS_TABLE).forEach(function (a) { accountsById[a.AccountID] = a.AccountName; });

    var accountScope = resolveAdminAccountScope_(resolveAdminHubScope_(identity));
    var all = applyHubScope_(DB.getAll(BALANCE_ADJUSTMENTS_TABLE), accountScope, 'AccountID');
    all = applyHubScope_(all, resolveAdminAccountScope_(resolveCountryFilterScope_(options.countryId)), 'AccountID');
    if (options.accountId) all = all.filter(function (a) { return a.AccountID === options.accountId; });
    all = all.map(function (a) { return withField_(a, { AccountName: accountsById[a.AccountID] || a.AccountID }); });

    return paginateAndFilter(all, {
      sortBy: options.sortBy || 'Date',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

function createBalanceAdjustment(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var error = validateBalanceAdjustmentInput(data);
    if (error) throw new Error(error);

    var record = DB.insert(BALANCE_ADJUSTMENTS_TABLE, {
      Date: data.Date,
      AccountID: data.AccountID,
      Amount: Number(data.Amount),
      Reason: data.Reason.trim(),
      DocumentID: data.DocumentID || '',
      MadeByEmail: identity.email,
      Status: 'Draft'
    });
    claimFinancialDocument_(record.DocumentID, BALANCE_ADJUSTMENTS_TABLE, record.AdjustmentID);
    logAudit_(identity, 'Create', BALANCE_ADJUSTMENTS_TABLE, record.AdjustmentID, '(record)', '', record.Reason + ' ' + record.Amount, '');
    return record;
  });
}

/** A second Admin (never the one who raised it) approves before the adjustment affects any balance. */
function approveBalanceAdjustment(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(BALANCE_ADJUSTMENTS_TABLE, id);
    if (!existing) throw new Error('Adjustment not found.');
    if (existing.Status !== 'Draft') throw new Error('Only a Draft adjustment can be approved.');
    assertNotSelfApproval_(existing.MadeByEmail, identity);

    var record = DB.update(BALANCE_ADJUSTMENTS_TABLE, id, {
      Status: 'Approved',
      ApprovedByEmail: identity.email,
      ApprovalDate: new Date()
    });
    logAudit_(identity, 'Approve', BALANCE_ADJUSTMENTS_TABLE, id, 'Status', 'Draft', 'Approved', '');
    return record;
  });
}

function rejectBalanceAdjustment(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(BALANCE_ADJUSTMENTS_TABLE, id);
    if (!existing) throw new Error('Adjustment not found.');
    if (existing.Status !== 'Draft') throw new Error('Only a Draft adjustment can be rejected.');
    if (!reason || !reason.trim()) throw new Error('A reason is required to reject an adjustment.');

    var record = DB.update(BALANCE_ADJUSTMENTS_TABLE, id, {
      Status: 'Rejected',
      ApprovedByEmail: identity.email,
      ApprovalDate: new Date(),
      Reason: existing.Reason + ' [Rejected: ' + reason.trim() + ']'
    });
    logAudit_(identity, 'Reject', BALANCE_ADJUSTMENTS_TABLE, id, 'Status', 'Draft', 'Rejected', '');
    return record;
  });
}

function validateBalanceAdjustmentInput(data) {
  return Validate.run([
    [Validate.required, data && data.Date, 'Date'],
    [Validate.required, data && data.AccountID, 'Account'],
    [Validate.exists, 'FinancialAccounts', data && data.AccountID, 'Account'],
    [Validate.required, data && data.Amount, 'Amount'],
    [Validate.required, data && data.Reason, 'Reason'],
    [Validate.maxLength, data && data.Reason, 500, 'Reason']
  ]);
}
