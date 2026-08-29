/**
 * ============================================================
 * REIMBURSEMENTS.GS — Employee reimbursement workflow (Phase 17)
 * ============================================================
 * Same Status/PaymentStatus shape as Invoices/Expenses, with one
 * addition: approving a reimbursement can set an ApprovedAmount that
 * differs from the Amount requested (e.g. the employee claimed
 * slightly more than the approved policy rate). The balance engine
 * (FinanceBalance.gs's outflowAmount_) always uses ApprovedAmount
 * once set, falling back to the requested Amount only before
 * approval.
 * ============================================================
 */

var REIMBURSEMENTS_TABLE = 'Reimbursements';
var REIMBURSEMENT_PAYMENT_METHODS = ['Bank Transfer', 'Mobile Money', 'Cash', 'Cheque', 'Other'];

/** Admin: every reimbursement, org-wide, optionally filtered. */
function getReimbursements(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var staffNames = {};
    DB.getAll(FINANCE_STAFF_TABLE).forEach(function (s) { staffNames[s.StaffID] = s.FullName; });

    var all = applyHubScope_(DB.getAll(REIMBURSEMENTS_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');
    if (options.hubId) all = all.filter(function (r) { return r.HubID === options.hubId; });
    if (options.status) all = all.filter(function (r) { return r.Status === options.status; });
    if (options.pendingOnly) all = all.filter(function (r) { return FINANCE_PENDING_STATUSES.indexOf(r.Status) !== -1; });

    all = all.map(function (r) {
      return withField_(r, { HubName: hubNames[r.HubID] || r.HubID, StaffName: staffNames[r.StaffID] || r.StaffID });
    });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[REIMBURSEMENTS_TABLE].searchableColumns,
      sortBy: options.sortBy || 'Date',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Hub Manager: reimbursements submitted against their own hub only. */
function getMyHubReimbursements(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};

    var staffNames = {};
    DB.getAll(FINANCE_STAFF_TABLE).forEach(function (s) { staffNames[s.StaffID] = s.FullName; });

    var mine = DB.getAll(REIMBURSEMENTS_TABLE).filter(function (r) { return r.HubID === manager.hubId; });
    mine = mine.map(function (r) { return withField_(r, { StaffName: staffNames[r.StaffID] || r.StaffID }); });

    return paginateAndFilter(mine, {
      sortBy: options.sortBy || 'Date',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

function createReimbursement(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var hubId = identity.role === 'HubManager' ? identity.hubId : (data.HubID || '');
    var error = validateReimbursementInput(data, identity);
    if (error) throw new Error(error);

    var record = DB.insert(REIMBURSEMENTS_TABLE, {
      StaffID: data.StaffID,
      Date: data.Date,
      ProjectID: data.ProjectID || '',
      HubID: hubId,
      ActivityRef: (data.ActivityRef || '').trim(),
      ExpenseCategory: data.ExpenseCategory,
      BudgetLineID: data.BudgetLineID || '',
      Description: (data.Description || '').trim(),
      Amount: Number(data.Amount),
      Currency: data.Currency,
      Reason: data.Reason.trim(),
      ReceiptDocumentID: data.ReceiptDocumentID || '',
      AccountID: data.AccountID,
      PaymentMethod: data.PaymentMethod || '',
      Status: 'Submitted',
      SubmittedByEmail: identity.email,
      SubmittedByRole: identity.role,
      PaymentStatus: 'Unpaid'
    });
    claimFinancialDocument_(record.ReceiptDocumentID, REIMBURSEMENTS_TABLE, record.ReimbursementID);
    logAudit_(identity, 'Submit', REIMBURSEMENTS_TABLE, record.ReimbursementID, '(record)', '', 'Amount ' + record.Amount, record.HubID);
    notify_({
      type: 'ReimbursementSubmitted', severity: 'info',
      message: 'Reimbursement request (' + record.Amount + ' ' + record.Currency + ') submitted for approval.',
      targetRole: 'Admin', targetAccessLevels: FINANCE_ACCESS_LEVELS, relatedTable: REIMBURSEMENTS_TABLE, relatedRecordId: record.ReimbursementID
    });
    return record;
  });
}

function resubmitReimbursement(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(REIMBURSEMENTS_TABLE, id);
    if (!existing) throw new Error('Reimbursement not found.');
    if (existing.Status !== 'Returned') throw new Error('Only a Returned reimbursement can be resubmitted.');
    if (identity.role !== 'Admin' && identity.email !== existing.SubmittedByEmail) {
      throw new Error('Only the person who submitted this reimbursement (or an Admin) can resubmit it.');
    }

    var error = validateReimbursementInput(data, identity);
    if (error) throw new Error(error);

    var record = DB.update(REIMBURSEMENTS_TABLE, id, {
      StaffID: data.StaffID,
      Date: data.Date,
      ProjectID: data.ProjectID || '',
      ActivityRef: (data.ActivityRef || '').trim(),
      ExpenseCategory: data.ExpenseCategory,
      BudgetLineID: data.BudgetLineID || '',
      Description: (data.Description || '').trim(),
      Amount: Number(data.Amount),
      Currency: data.Currency,
      Reason: data.Reason.trim(),
      ReceiptDocumentID: data.ReceiptDocumentID || existing.ReceiptDocumentID,
      AccountID: data.AccountID,
      PaymentMethod: data.PaymentMethod || '',
      Status: 'Submitted',
      RejectionReason: ''
    });
    claimFinancialDocument_(data.ReceiptDocumentID, REIMBURSEMENTS_TABLE, id);
    logAudit_(identity, 'Resubmit', REIMBURSEMENTS_TABLE, id, 'Status', 'Returned', 'Submitted', record.HubID);
    return record;
  });
}

function markReimbursementUnderReview(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(REIMBURSEMENTS_TABLE, id);
    if (!existing) throw new Error('Reimbursement not found.');
    if (existing.Status !== 'Submitted') throw new Error('Only a Submitted reimbursement can be marked Under Review.');
    var record = DB.update(REIMBURSEMENTS_TABLE, id, { Status: 'Under Review' });
    logAudit_(identity, 'Review', REIMBURSEMENTS_TABLE, id, 'Status', 'Submitted', 'Under Review', record.HubID);
    return record;
  });
}

/**
 * Admin only. `approvedAmount` is optional — omit it (or pass the same
 * value as the requested Amount) to approve in full; pass a different
 * number to approve a partial amount (e.g. only the policy-compliant
 * portion of the claim).
 */
function approveReimbursement(sessionToken, id, approvedAmount) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(REIMBURSEMENTS_TABLE, id);
    if (!existing) throw new Error('Reimbursement not found.');
    if (['Submitted', 'Under Review'].indexOf(existing.Status) === -1) {
      throw new Error('Only a Submitted or Under Review reimbursement can be approved.');
    }
    assertNotSelfApproval_(existing.SubmittedByEmail, identity);

    var amount = (approvedAmount === undefined || approvedAmount === null || approvedAmount === '')
      ? Number(existing.Amount) : Number(approvedAmount);
    if (isNaN(amount) || amount < 0) throw new Error('Approved amount must be a number of 0 or more.');
    if (amount > Number(existing.Amount)) throw new Error('Approved amount cannot exceed the amount requested.');

    var record = DB.update(REIMBURSEMENTS_TABLE, id, {
      Status: 'Approved', ApprovedAmount: amount, ApprovedByEmail: identity.email, ApprovalDate: new Date()
    });
    logAudit_(identity, 'Approve', REIMBURSEMENTS_TABLE, id, 'Status', existing.Status, 'Approved (' + amount + ')', record.HubID);
    notify_({
      type: 'ReimbursementApproved', severity: 'info',
      message: 'Your reimbursement request was approved for ' + amount + ' ' + record.Currency + '.',
      targetEmail: record.SubmittedByEmail, relatedTable: REIMBURSEMENTS_TABLE, relatedRecordId: id
    });
    return record;
  });
}

function rejectReimbursement(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(REIMBURSEMENTS_TABLE, id);
    if (!existing) throw new Error('Reimbursement not found.');
    if (['Submitted', 'Under Review'].indexOf(existing.Status) === -1) {
      throw new Error('Only a Submitted or Under Review reimbursement can be rejected.');
    }
    if (!reason || !reason.trim()) throw new Error('A reason is required to reject a reimbursement.');

    var record = DB.update(REIMBURSEMENTS_TABLE, id, { Status: 'Rejected', ApprovedByEmail: identity.email, ApprovalDate: new Date(), RejectionReason: reason.trim() });
    logAudit_(identity, 'Reject', REIMBURSEMENTS_TABLE, id, 'Status', existing.Status, 'Rejected', record.HubID);
    notify_({
      type: 'ReimbursementRejected', severity: 'warning',
      message: 'Your reimbursement request was rejected: ' + reason.trim(),
      targetEmail: record.SubmittedByEmail, relatedTable: REIMBURSEMENTS_TABLE, relatedRecordId: id
    });
    return record;
  });
}

function returnReimbursementForCorrection(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(REIMBURSEMENTS_TABLE, id);
    if (!existing) throw new Error('Reimbursement not found.');
    if (['Submitted', 'Under Review'].indexOf(existing.Status) === -1) {
      throw new Error('Only a Submitted or Under Review reimbursement can be returned for correction.');
    }
    if (!reason || !reason.trim()) throw new Error('A reason is required to return a reimbursement for correction.');

    var record = DB.update(REIMBURSEMENTS_TABLE, id, { Status: 'Returned', RejectionReason: reason.trim() });
    logAudit_(identity, 'Return', REIMBURSEMENTS_TABLE, id, 'Status', existing.Status, 'Returned', record.HubID);
    notify_({
      type: 'ReimbursementReturned', severity: 'warning',
      message: 'Your reimbursement request was returned for correction: ' + reason.trim(),
      targetEmail: record.SubmittedByEmail, relatedTable: REIMBURSEMENTS_TABLE, relatedRecordId: id
    });
    return record;
  });
}

function payReimbursement(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(REIMBURSEMENTS_TABLE, id);
    if (!existing) throw new Error('Reimbursement not found.');
    if (existing.Status !== 'Approved') throw new Error('Only an Approved reimbursement can be marked Paid.');
    if (existing.PaymentStatus === 'Paid') throw new Error('This reimbursement has already been paid.');

    var record = DB.update(REIMBURSEMENTS_TABLE, id, {
      PaymentStatus: 'Paid',
      PaymentDate: (data && data.PaymentDate) || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      PaymentReference: (data && data.PaymentReference || '').trim()
    });
    logAudit_(identity, 'Pay', REIMBURSEMENTS_TABLE, id, 'PaymentStatus', 'Unpaid', 'Paid', record.HubID);
    return record;
  });
}

function cancelReimbursement(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(REIMBURSEMENTS_TABLE, id);
    if (!existing) throw new Error('Reimbursement not found.');
    if (existing.PaymentStatus === 'Paid') {
      throw new Error('This reimbursement has already been paid — use a Balance Adjustment if a correction is genuinely needed.');
    }
    var isAdmin = identity.role === 'Admin';
    var isOwnUnapproved = identity.email === existing.SubmittedByEmail && existing.Status !== 'Approved';
    if (!isAdmin && !isOwnUnapproved) throw new Error('You do not have permission to cancel this reimbursement.');
    if (!reason || !reason.trim()) throw new Error('A reason is required to cancel a reimbursement.');

    var record = DB.update(REIMBURSEMENTS_TABLE, id, { Status: 'Cancelled', RejectionReason: reason.trim() });
    logAudit_(identity, 'Cancel', REIMBURSEMENTS_TABLE, id, 'Status', existing.Status, 'Cancelled', record.HubID);
    return record;
  });
}

function validateReimbursementInput(data, identity) {
  var checks = [
    [Validate.required, data && data.StaffID, 'Staff'],
    [Validate.exists, 'FinanceStaff', data && data.StaffID, 'Staff'],
    [Validate.required, data && data.Date, 'Date'],
    [Validate.required, data && data.ExpenseCategory, 'Expense category'],
    [Validate.required, data && data.Amount, 'Amount'],
    [Validate.nonNegativeNumber, data && data.Amount, 'Amount'],
    [Validate.required, data && data.Currency, 'Currency'],
    [Validate.required, data && data.Reason, 'Reason'],
    [Validate.maxLength, data && data.Reason, 500, 'Reason'],
    [Validate.required, data && data.AccountID, 'Account'],
    [Validate.exists, 'FinancialAccounts', data && data.AccountID, 'Account']
  ];
  if (data && data.ProjectID) checks.push([Validate.exists, 'Projects', data.ProjectID, 'Project']);
  if (data && data.BudgetLineID) checks.push([Validate.exists, 'BudgetLines', data.BudgetLineID, 'Budget line']);
  if (data && data.PaymentMethod) checks.push([Validate.oneOf, data.PaymentMethod, REIMBURSEMENT_PAYMENT_METHODS, 'Payment method']);

  var error = Validate.run(checks);
  if (error) return error;
  return assertNotSalaryCategory_(data && data.ExpenseCategory);
}
