/**
 * ============================================================
 * FINANCEACCOUNTS.GS — Bank/mobile-money accounts (Phase 17)
 * ============================================================
 * OpeningBalance/OpeningBalanceDate are set ONCE at creation and are
 * deliberately NOT editable afterward through updateFinancialAccount
 * — changing the starting point of an account after transactions may
 * already exist against it is exactly the "manually overwrite the
 * calculated balance" shortcut FINANCE_MODULE_INSTRUCTIONS.md §6
 * forbids. A genuine correction goes through BalanceAdjustments.gs
 * instead, which is reasoned about and audited.
 * ============================================================
 */

var FINANCIAL_ACCOUNTS_TABLE = 'FinancialAccounts';
var FINANCE_ACCOUNT_TYPES = ['Bank', 'Mobile Money', 'Cash', 'Other'];
var FINANCE_ACCOUNT_STATUSES = ['Active', 'Closed'];

/** Admin: every account, org-wide, with HubName joined and the account number masked. */
function getFinancialAccounts(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var all = applyHubScope_(DB.getAll(FINANCIAL_ACCOUNTS_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');
    if (options.hubId) all = all.filter(function (a) { return a.HubID === options.hubId; });
    all = all.map(function (a) {
      return withField_(a, {
        HubName: hubNames[a.HubID] || a.HubID,
        AccountNumberMasked: maskAccountNumber_(a.AccountNumber)
      });
    });
    all.forEach(function (a) { delete a.AccountNumber; });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[FINANCIAL_ACCOUNTS_TABLE].searchableColumns,
      sortBy: options.sortBy || 'AccountName',
      sortDir: options.sortDir || 'asc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Hub Manager: their own hub's accounts only, read-only, masked. */
function getMyHubFinancialAccounts(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    return DB.getAll(FINANCIAL_ACCOUNTS_TABLE)
      .filter(function (a) { return a.HubID === manager.hubId; })
      .map(function (a) {
        var masked = withField_(a, { AccountNumberMasked: maskAccountNumber_(a.AccountNumber) });
        delete masked.AccountNumber;
        return masked;
      });
  });
}

/**
 * Any authenticated user: accounts as {id, name, currency, hubId}
 * tuples for a picker. Admin gets every active account (optionally
 * filtered to one hub); a Hub Manager only ever gets their own hub's.
 */
function getFinancialAccountOptions(sessionToken, hubId) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var all = DB.getAll(FINANCIAL_ACCOUNTS_TABLE).filter(function (a) { return a.Status === 'Active'; });
    if (identity.role === 'HubManager') {
      all = all.filter(function (a) { return a.HubID === identity.hubId; });
    } else if (hubId) {
      all = all.filter(function (a) { return a.HubID === hubId; });
    }
    return all.map(function (a) {
      return { id: a.AccountID, name: a.AccountName, currency: a.Currency, hubId: a.HubID };
    });
  });
}

function addFinancialAccount(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var error = validateFinancialAccountInput(data, true);
    if (error) throw new Error(error);

    var record = DB.insert(FINANCIAL_ACCOUNTS_TABLE, {
      AccountName: data.AccountName.trim(),
      BankName: (data.BankName || '').trim(),
      AccountNumber: (data.AccountNumber || '').trim(),
      Currency: data.Currency,
      AccountType: data.AccountType,
      HubID: data.HubID || '',
      ProjectID: data.ProjectID || '',
      OpeningBalance: Number(data.OpeningBalance) || 0,
      OpeningBalanceDate: data.OpeningBalanceDate,
      Status: 'Active',
      CreatedByEmail: identity.email
    });
    logAudit_(identity, 'Create', FINANCIAL_ACCOUNTS_TABLE, record.AccountID, '(record)', '', record.AccountName, record.HubID);
    return withField_(record, { AccountNumberMasked: maskAccountNumber_(record.AccountNumber) });
  });
}

/** Metadata-only update — Currency, OpeningBalance and OpeningBalanceDate are intentionally not accepted here (see file header). */
function updateFinancialAccount(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(FINANCIAL_ACCOUNTS_TABLE, id);
    if (!existing) throw new Error('Account not found.');
    var error = validateFinancialAccountInput(data, false);
    if (error) throw new Error(error);

    var record = DB.update(FINANCIAL_ACCOUNTS_TABLE, id, {
      AccountName: data.AccountName.trim(),
      BankName: (data.BankName || '').trim(),
      // Only overwrite the stored number if the caller actually supplied
      // one — the client never receives the real number back (only a
      // masked display), so "not present" must mean "leave unchanged",
      // not "clear it".
      AccountNumber: data.hasOwnProperty('AccountNumber') ? data.AccountNumber.trim() : existing.AccountNumber,
      AccountType: data.AccountType,
      HubID: data.HubID || '',
      ProjectID: data.ProjectID || '',
      Status: data.Status || existing.Status
    });
    logAudit_(identity, 'Update', FINANCIAL_ACCOUNTS_TABLE, id, '(record)', existing.AccountName, record.AccountName, record.HubID);
    return withField_(record, { AccountNumberMasked: maskAccountNumber_(record.AccountNumber) });
  });
}

function validateFinancialAccountInput(data, requireOpeningBalance) {
  var checks = [
    [Validate.required, data && data.AccountName, 'Account name'],
    [Validate.maxLength, data && data.AccountName, 100, 'Account name'],
    [Validate.required, data && data.AccountType, 'Account type'],
    [Validate.oneOf, data && data.AccountType, FINANCE_ACCOUNT_TYPES, 'Account type']
  ];
  if (requireOpeningBalance) {
    checks.push([Validate.required, data && data.Currency, 'Currency']);
    checks.push([Validate.required, data && data.OpeningBalanceDate, 'Opening balance date']);
    checks.push([Validate.nonNegativeNumber, data && data.OpeningBalance, 'Opening balance']);
  }
  if (data && data.HubID) checks.push([Validate.exists, 'Hubs', data.HubID, 'Hub']);
  if (data && data.ProjectID) checks.push([Validate.exists, 'Projects', data.ProjectID, 'Project']);
  return Validate.run(checks);
}
