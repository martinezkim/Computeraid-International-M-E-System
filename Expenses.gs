/**
 * ============================================================
 * EXPENSES.GS — Expense creation + approval workflow (Phase 17)
 * ============================================================
 * Same Status/PaymentStatus shape and money-state rules as
 * Invoices.gs — see that file's header for the full explanation.
 * StaffID is optional (a vendor expense has no staff payee; PayeeName
 * covers both cases — a staff member's name or a vendor's).
 * ============================================================
 */

var EXPENSES_TABLE = 'Expenses';
var EXPENSE_PAYMENT_METHODS = ['Bank Transfer', 'Mobile Money', 'Cash', 'Cheque', 'Other'];

/** Admin: every expense, org-wide, optionally filtered. */
function getExpenses(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var accountNames = {};
    DB.getAll(FINANCIAL_ACCOUNTS_TABLE).forEach(function (a) { accountNames[a.AccountID] = a.AccountName; });

    var all = applyHubScope_(DB.getAll(EXPENSES_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');
    if (options.hubId) all = all.filter(function (x) { return x.HubID === options.hubId; });
    if (options.status) all = all.filter(function (x) { return x.Status === options.status; });
    if (options.pendingOnly) all = all.filter(function (x) { return FINANCE_PENDING_STATUSES.indexOf(x.Status) !== -1; });

    all = all.map(function (x) {
      return withField_(x, { HubName: hubNames[x.HubID] || x.HubID, AccountName: accountNames[x.AccountID] || x.AccountID });
    });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[EXPENSES_TABLE].searchableColumns,
      sortBy: options.sortBy || 'Date',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Hub Manager: expenses submitted against their own hub only. */
function getMyHubExpenses(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};

    var accountNames = {};
    DB.getAll(FINANCIAL_ACCOUNTS_TABLE).forEach(function (a) { accountNames[a.AccountID] = a.AccountName; });

    var mine = DB.getAll(EXPENSES_TABLE).filter(function (x) { return x.HubID === manager.hubId; });
    mine = mine.map(function (x) { return withField_(x, { AccountName: accountNames[x.AccountID] || x.AccountID }); });

    return paginateAndFilter(mine, {
      sortBy: options.sortBy || 'Date',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

function createExpense(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var hubId = identity.role === 'HubManager' ? identity.hubId : (data.HubID || '');
    var error = validateExpenseInput(data, identity);
    if (error) throw new Error(error);

    var amount = Number(data.Amount);
    var taxAmount = Number(data.TaxAmount) || 0;

    var record = DB.insert(EXPENSES_TABLE, {
      Date: data.Date,
      PayeeName: data.PayeeName.trim(),
      StaffID: data.StaffID || '',
      Description: (data.Description || '').trim(),
      Amount: amount,
      TaxAmount: taxAmount,
      TotalAmount: amount + taxAmount,
      Currency: data.Currency,
      ProjectID: data.ProjectID || '',
      HubID: hubId,
      ExpenseCategory: data.ExpenseCategory,
      BudgetLineID: data.BudgetLineID || '',
      PaymentMethod: data.PaymentMethod || '',
      AccountID: data.AccountID,
      ReceiptDocumentID: data.ReceiptDocumentID || '',
      Status: 'Submitted',
      SubmittedByEmail: identity.email,
      SubmittedByRole: identity.role,
      PaymentStatus: 'Unpaid',
      Notes: (data.Notes || '').trim()
    });
    claimFinancialDocument_(record.ReceiptDocumentID, EXPENSES_TABLE, record.ExpenseID);
    logAudit_(identity, 'Submit', EXPENSES_TABLE, record.ExpenseID, '(record)', '', record.PayeeName + ' ' + record.TotalAmount, record.HubID);
    notify_({
      type: 'ExpenseSubmitted', severity: 'info',
      message: 'Expense for ' + record.PayeeName + ' (' + record.TotalAmount + ' ' + record.Currency + ') submitted for approval.',
      targetRole: 'Admin', targetAccessLevels: FINANCE_ACCESS_LEVELS, relatedTable: EXPENSES_TABLE, relatedRecordId: record.ExpenseID
    });
    return record;
  });
}

function resubmitExpense(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(EXPENSES_TABLE, id);
    if (!existing) throw new Error('Expense not found.');
    if (existing.Status !== 'Returned') throw new Error('Only a Returned expense can be resubmitted.');
    if (identity.role !== 'Admin' && identity.email !== existing.SubmittedByEmail) {
      throw new Error('Only the person who submitted this expense (or an Admin) can resubmit it.');
    }

    var error = validateExpenseInput(data, identity);
    if (error) throw new Error(error);

    var amount = Number(data.Amount);
    var taxAmount = Number(data.TaxAmount) || 0;

    var record = DB.update(EXPENSES_TABLE, id, {
      Date: data.Date,
      PayeeName: data.PayeeName.trim(),
      StaffID: data.StaffID || '',
      Description: (data.Description || '').trim(),
      Amount: amount,
      TaxAmount: taxAmount,
      TotalAmount: amount + taxAmount,
      Currency: data.Currency,
      ProjectID: data.ProjectID || '',
      ExpenseCategory: data.ExpenseCategory,
      BudgetLineID: data.BudgetLineID || '',
      PaymentMethod: data.PaymentMethod || '',
      AccountID: data.AccountID,
      ReceiptDocumentID: data.ReceiptDocumentID || existing.ReceiptDocumentID,
      Status: 'Submitted',
      RejectionReason: '',
      Notes: (data.Notes || '').trim()
    });
    claimFinancialDocument_(data.ReceiptDocumentID, EXPENSES_TABLE, id);
    logAudit_(identity, 'Resubmit', EXPENSES_TABLE, id, 'Status', 'Returned', 'Submitted', record.HubID);
    return record;
  });
}

function markExpenseUnderReview(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(EXPENSES_TABLE, id);
    if (!existing) throw new Error('Expense not found.');
    if (existing.Status !== 'Submitted') throw new Error('Only a Submitted expense can be marked Under Review.');
    var record = DB.update(EXPENSES_TABLE, id, { Status: 'Under Review' });
    logAudit_(identity, 'Review', EXPENSES_TABLE, id, 'Status', 'Submitted', 'Under Review', record.HubID);
    return record;
  });
}

function approveExpense(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(EXPENSES_TABLE, id);
    if (!existing) throw new Error('Expense not found.');
    if (['Submitted', 'Under Review'].indexOf(existing.Status) === -1) {
      throw new Error('Only a Submitted or Under Review expense can be approved.');
    }
    assertNotSelfApproval_(existing.SubmittedByEmail, identity);

    var record = DB.update(EXPENSES_TABLE, id, { Status: 'Approved', ApprovedByEmail: identity.email, ApprovalDate: new Date() });
    logAudit_(identity, 'Approve', EXPENSES_TABLE, id, 'Status', existing.Status, 'Approved', record.HubID);
    notify_({
      type: 'ExpenseApproved', severity: 'info',
      message: 'Your expense for ' + record.PayeeName + ' (' + record.TotalAmount + ' ' + record.Currency + ') was approved.',
      targetEmail: record.SubmittedByEmail, relatedTable: EXPENSES_TABLE, relatedRecordId: id
    });
    return record;
  });
}

function rejectExpense(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(EXPENSES_TABLE, id);
    if (!existing) throw new Error('Expense not found.');
    if (['Submitted', 'Under Review'].indexOf(existing.Status) === -1) {
      throw new Error('Only a Submitted or Under Review expense can be rejected.');
    }
    if (!reason || !reason.trim()) throw new Error('A reason is required to reject an expense.');

    var record = DB.update(EXPENSES_TABLE, id, { Status: 'Rejected', ApprovedByEmail: identity.email, ApprovalDate: new Date(), RejectionReason: reason.trim() });
    logAudit_(identity, 'Reject', EXPENSES_TABLE, id, 'Status', existing.Status, 'Rejected', record.HubID);
    notify_({
      type: 'ExpenseRejected', severity: 'warning',
      message: 'Your expense for ' + record.PayeeName + ' was rejected: ' + reason.trim(),
      targetEmail: record.SubmittedByEmail, relatedTable: EXPENSES_TABLE, relatedRecordId: id
    });
    return record;
  });
}

function returnExpenseForCorrection(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(EXPENSES_TABLE, id);
    if (!existing) throw new Error('Expense not found.');
    if (['Submitted', 'Under Review'].indexOf(existing.Status) === -1) {
      throw new Error('Only a Submitted or Under Review expense can be returned for correction.');
    }
    if (!reason || !reason.trim()) throw new Error('A reason is required to return an expense for correction.');

    var record = DB.update(EXPENSES_TABLE, id, { Status: 'Returned', RejectionReason: reason.trim() });
    logAudit_(identity, 'Return', EXPENSES_TABLE, id, 'Status', existing.Status, 'Returned', record.HubID);
    notify_({
      type: 'ExpenseReturned', severity: 'warning',
      message: 'Your expense for ' + record.PayeeName + ' was returned for correction: ' + reason.trim(),
      targetEmail: record.SubmittedByEmail, relatedTable: EXPENSES_TABLE, relatedRecordId: id
    });
    return record;
  });
}

function payExpense(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(EXPENSES_TABLE, id);
    if (!existing) throw new Error('Expense not found.');
    if (existing.Status !== 'Approved') throw new Error('Only an Approved expense can be marked Paid.');
    if (existing.PaymentStatus === 'Paid') throw new Error('This expense has already been paid.');

    var record = DB.update(EXPENSES_TABLE, id, {
      PaymentStatus: 'Paid',
      PaymentDate: (data && data.PaymentDate) || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      PaymentReference: (data && data.PaymentReference || '').trim()
    });
    logAudit_(identity, 'Pay', EXPENSES_TABLE, id, 'PaymentStatus', 'Unpaid', 'Paid', record.HubID);
    return record;
  });
}

function cancelExpense(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(EXPENSES_TABLE, id);
    if (!existing) throw new Error('Expense not found.');
    if (existing.PaymentStatus === 'Paid') {
      throw new Error('This expense has already been paid — use a Balance Adjustment if a correction is genuinely needed.');
    }
    var isAdmin = identity.role === 'Admin';
    var isOwnUnapproved = identity.email === existing.SubmittedByEmail && existing.Status !== 'Approved';
    if (!isAdmin && !isOwnUnapproved) throw new Error('You do not have permission to cancel this expense.');
    if (!reason || !reason.trim()) throw new Error('A reason is required to cancel an expense.');

    var record = DB.update(EXPENSES_TABLE, id, { Status: 'Cancelled', RejectionReason: reason.trim() });
    logAudit_(identity, 'Cancel', EXPENSES_TABLE, id, 'Status', existing.Status, 'Cancelled', record.HubID);
    return record;
  });
}

function validateExpenseInput(data, identity) {
  var checks = [
    [Validate.required, data && data.PayeeName, 'Payee name'],
    [Validate.maxLength, data && data.PayeeName, 150, 'Payee name'],
    [Validate.required, data && data.Date, 'Date'],
    [Validate.required, data && data.ExpenseCategory, 'Expense category'],
    [Validate.required, data && data.Amount, 'Amount'],
    [Validate.nonNegativeNumber, data && data.Amount, 'Amount'],
    [Validate.nonNegativeNumber, data && data.TaxAmount, 'Tax amount'],
    [Validate.required, data && data.Currency, 'Currency'],
    [Validate.required, data && data.AccountID, 'Account'],
    [Validate.exists, 'FinancialAccounts', data && data.AccountID, 'Account']
  ];
  if (data && data.StaffID) checks.push([Validate.exists, 'FinanceStaff', data.StaffID, 'Staff']);
  if (identity.role === 'Admin' && data && data.HubID) checks.push([Validate.exists, 'Hubs', data.HubID, 'Hub']);
  if (data && data.ProjectID) checks.push([Validate.exists, 'Projects', data.ProjectID, 'Project']);
  if (data && data.BudgetLineID) checks.push([Validate.exists, 'BudgetLines', data.BudgetLineID, 'Budget line']);
  if (data && data.PaymentMethod) checks.push([Validate.oneOf, data.PaymentMethod, EXPENSE_PAYMENT_METHODS, 'Payment method']);

  var error = Validate.run(checks);
  if (error) return error;
  return assertNotSalaryCategory_(data && data.ExpenseCategory);
}
