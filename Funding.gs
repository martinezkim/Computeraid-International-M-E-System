/**
 * ============================================================
 * FUNDING.GS — Funds received into a Financial Account (Phase 17)
 * ============================================================
 * A funding transaction is 'Recorded' the moment anyone logs it, but
 * only counts toward the balance engine once an Admin marks it
 * 'Confirmed' — matching the platform-wide rule that only an Admin
 * finalizes anything financial. This also means a Hub Manager can log
 * funding they're told about immediately, without being able to
 * inflate the hub's available balance themselves.
 * ============================================================
 */

var FUNDING_TABLE = 'FundingTransactions';
var FUNDING_STATUSES = ['Recorded', 'Confirmed', 'Cancelled'];

/** Admin: every funding transaction, org-wide, optionally filtered to one hub/account/project. */
function getFundingTransactions(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var all = applyHubScope_(DB.getAll(FUNDING_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');
    if (options.hubId) all = all.filter(function (f) { return f.HubID === options.hubId; });
    if (options.accountId) all = all.filter(function (f) { return f.AccountID === options.accountId; });
    if (options.status) all = all.filter(function (f) { return f.Status === options.status; });

    all = all.map(function (f) { return withField_(f, { HubName: hubNames[f.HubID] || f.HubID }); });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[FUNDING_TABLE].searchableColumns,
      sortBy: options.sortBy || 'DateReceived',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Hub Manager: funding recorded against their own hub only. */
function getMyHubFundingTransactions(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};
    var mine = DB.getAll(FUNDING_TABLE).filter(function (f) { return f.HubID === manager.hubId; });

    return paginateAndFilter(mine, {
      sortBy: options.sortBy || 'DateReceived',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

function recordFundingTransaction(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var error = validateFundingInput(data);
    if (error) throw new Error(error);

    // A Hub Manager can only ever log funding against their own hub —
    // never spoof another hub's HubID from the client.
    var hubId = identity.role === 'HubManager' ? identity.hubId : (data.HubID || '');

    var record = DB.insert(FUNDING_TABLE, {
      DateReceived: data.DateReceived,
      Amount: Number(data.Amount),
      Currency: data.Currency,
      FundingSource: data.FundingSource.trim(),
      Donor: (data.Donor || '').trim(),
      ProjectID: data.ProjectID || '',
      HubID: hubId,
      AccountID: data.AccountID,
      ReferenceNumber: (data.ReferenceNumber || '').trim(),
      Description: (data.Description || '').trim(),
      DocumentID: data.DocumentID || '',
      Status: 'Recorded',
      EnteredByEmail: identity.email,
      DateEntered: new Date()
    });
    claimFinancialDocument_(record.DocumentID, FUNDING_TABLE, record.FundingID);
    logAudit_(identity, 'Create', FUNDING_TABLE, record.FundingID, '(record)', '', record.FundingSource + ' ' + record.Amount, record.HubID);
    notify_({
      type: 'FundingRecorded', severity: 'info',
      message: 'Funding of ' + record.Amount + ' ' + record.Currency + ' from ' + record.FundingSource + ' recorded — confirm once the transfer has cleared.',
      targetRole: 'Admin', targetAccessLevels: FINANCE_ACCESS_LEVELS, relatedTable: FUNDING_TABLE, relatedRecordId: record.FundingID
    });
    return record;
  });
}

/** Admin only — the point at which a funding transaction starts counting toward any balance. */
function confirmFundingTransaction(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(FUNDING_TABLE, id);
    if (!existing) throw new Error('Funding transaction not found.');
    if (existing.Status !== 'Recorded') throw new Error('Only a Recorded funding transaction can be confirmed.');

    var record = DB.update(FUNDING_TABLE, id, { Status: 'Confirmed' });
    logAudit_(identity, 'Confirm', FUNDING_TABLE, id, 'Status', 'Recorded', 'Confirmed', record.HubID);
    return record;
  });
}

/** Admin only — retires a funding entry that turns out to be wrong (e.g. duplicate). Never deleted, only marked Cancelled. */
function cancelFundingTransaction(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(FUNDING_TABLE, id);
    if (!existing) throw new Error('Funding transaction not found.');
    if (existing.Status === 'Cancelled') throw new Error('This funding transaction is already cancelled.');
    if (!reason || !reason.trim()) throw new Error('A reason is required to cancel a funding transaction.');

    var record = DB.update(FUNDING_TABLE, id, {
      Status: 'Cancelled',
      Description: (existing.Description || '') + ' [Cancelled: ' + reason.trim() + ']'
    });
    logAudit_(identity, 'Cancel', FUNDING_TABLE, id, 'Status', existing.Status, 'Cancelled', record.HubID);
    return record;
  });
}

function validateFundingInput(data) {
  return Validate.run([
    [Validate.required, data && data.DateReceived, 'Date received'],
    [Validate.required, data && data.Amount, 'Amount'],
    [Validate.nonNegativeNumber, data && data.Amount, 'Amount'],
    [Validate.required, data && data.Currency, 'Currency'],
    [Validate.required, data && data.FundingSource, 'Funding source'],
    [Validate.maxLength, data && data.FundingSource, 150, 'Funding source'],
    [Validate.required, data && data.AccountID, 'Account'],
    [Validate.exists, 'FinancialAccounts', data && data.AccountID, 'Account']
  ]);
}
