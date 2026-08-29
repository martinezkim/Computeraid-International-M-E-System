/**
 * ============================================================
 * SALARIES.GS — Salary/payroll expense tracking (Phase 17)
 * ============================================================
 * SECURITY-SENSITIVE: individual Salaries rows are returned ONLY to
 * Admin, from every endpoint in this file. A Hub Manager NEVER
 * receives a Salaries row — see getMyHubStaffCostSummary(), which
 * returns an aggregated total only (no names, no per-person amounts).
 * This is enforced here at the source, not just hidden in the UI.
 *
 * Workflow is simpler than Invoices/Expenses/Reimbursements — no
 * multi-role submit/review split (this whole module is Admin-only end
 * to end) — but still Draft -> Approved -> (PaymentStatus) Paid, with
 * the same self-approval guard as everywhere else: the Admin who
 * created the Draft cannot be the one who approves it.
 * ============================================================
 */

var SALARIES_TABLE = 'Salaries';
var SALARY_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/; // 'YYYY-MM'

/** Admin only. Every salary row, org-wide, with Staff/Hub/Account names joined. */
function getSalaries(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var staffNames = {};
    DB.getAll(FINANCE_STAFF_TABLE).forEach(function (s) { staffNames[s.StaffID] = s.FullName; });
    var accountNames = {};
    DB.getAll(FINANCIAL_ACCOUNTS_TABLE).forEach(function (a) { accountNames[a.AccountID] = a.AccountName; });

    var all = applyHubScope_(DB.getAll(SALARIES_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');
    if (options.hubId) all = all.filter(function (s) { return s.HubID === options.hubId; });
    if (options.month) all = all.filter(function (s) { return s.Month === options.month; });
    if (options.status) all = all.filter(function (s) { return s.Status === options.status; });

    all = all.map(function (s) {
      return withField_(s, {
        HubName: hubNames[s.HubID] || s.HubID,
        StaffName: staffNames[s.StaffID] || s.StaffID,
        AccountName: accountNames[s.AccountID] || s.AccountID
      });
    });

    return paginateAndFilter(all, {
      sortBy: options.sortBy || 'Month',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

function createSalary(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var error = validateSalaryInput(data);
    if (error) throw new Error(error);

    var duplicate = DB.getAll(SALARIES_TABLE).some(function (s) {
      return s.StaffID === data.StaffID && s.Month === data.Month && s.Status !== 'Cancelled';
    });
    if (duplicate) throw new Error('A salary record for this staff member and month already exists.');

    var gross = Number(data.GrossAmount);
    var allowances = Number(data.Allowances) || 0;
    var deductions = Number(data.Deductions) || 0;

    var record = DB.insert(SALARIES_TABLE, {
      StaffID: data.StaffID,
      Month: data.Month,
      ProjectID: data.ProjectID || '',
      HubID: data.HubID,
      GrossAmount: gross,
      Allowances: allowances,
      Deductions: deductions,
      NetProjectCost: gross + allowances - deductions,
      Currency: data.Currency,
      AccountID: data.AccountID,
      PayrollDocumentID: data.PayrollDocumentID || '',
      Status: 'Draft',
      PaymentStatus: 'Unpaid',
      CreatedByEmail: identity.email
    });
    claimFinancialDocument_(record.PayrollDocumentID, SALARIES_TABLE, record.SalaryID);
    logAudit_(identity, 'Create', SALARIES_TABLE, record.SalaryID, '(record)', '', 'Net ' + record.NetProjectCost, record.HubID);
    return record;
  });
}

/** Admin only, and never the Admin who created the Draft — separation of duties even within one role. */
function approveSalary(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(SALARIES_TABLE, id);
    if (!existing) throw new Error('Salary record not found.');
    if (existing.Status !== 'Draft') throw new Error('Only a Draft salary record can be approved.');
    assertNotSelfApproval_(existing.CreatedByEmail, identity);

    var record = DB.update(SALARIES_TABLE, id, { Status: 'Approved', ApprovedByEmail: identity.email, ApprovalDate: new Date() });
    logAudit_(identity, 'Approve', SALARIES_TABLE, id, 'Status', 'Draft', 'Approved', record.HubID);
    return record;
  });
}

function paySalary(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(SALARIES_TABLE, id);
    if (!existing) throw new Error('Salary record not found.');
    if (existing.Status !== 'Approved') throw new Error('Only an Approved salary record can be marked Paid.');
    if (existing.PaymentStatus === 'Paid') throw new Error('This salary has already been paid.');

    var record = DB.update(SALARIES_TABLE, id, {
      PaymentStatus: 'Paid',
      PaymentDate: (data && data.PaymentDate) || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      PaymentReference: (data && data.PaymentReference || '').trim()
    });
    logAudit_(identity, 'Pay', SALARIES_TABLE, id, 'PaymentStatus', 'Unpaid', 'Paid', record.HubID);
    return record;
  });
}

function cancelSalary(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(SALARIES_TABLE, id);
    if (!existing) throw new Error('Salary record not found.');
    if (existing.PaymentStatus === 'Paid') {
      throw new Error('This salary has already been paid — use a Balance Adjustment if a correction is genuinely needed.');
    }
    if (!reason || !reason.trim()) throw new Error('A reason is required to cancel a salary record.');

    var record = DB.update(SALARIES_TABLE, id, { Status: 'Cancelled' });
    logAudit_(identity, 'Cancel', SALARIES_TABLE, id, 'Status', existing.Status, 'Cancelled (' + reason.trim() + ')', record.HubID);
    return record;
  });
}

/**
 * Hub Manager (or Admin): an AGGREGATE staff-cost total for their own
 * hub for one month — NEVER individual Salaries rows, names, or
 * amounts. This is the ONLY salary-related information a Hub Manager
 * client is allowed to receive. Defaults to the current month.
 */
function getMyHubStaffCostSummary(sessionToken, month) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var hubId = identity.role === 'HubManager' ? identity.hubId : null;
    if (identity.role === 'Admin' && !hubId) {
      throw new Error('An Admin must specify which hub to summarize (use getSalaries for the full org-wide view).');
    }
    var targetMonth = (month && SALARY_MONTH_PATTERN.test(month)) ? month : currentMonthLabel_();

    var total = sumWhere_(SALARIES_TABLE, function (s) {
      return s.HubID === hubId && s.Month === targetMonth && s.PaymentStatus === 'Paid';
    }, 'NetProjectCost');

    return { month: targetMonth, total: total };
  });
}

function validateSalaryInput(data) {
  var checks = [
    [Validate.required, data && data.StaffID, 'Staff'],
    [Validate.exists, 'FinanceStaff', data && data.StaffID, 'Staff'],
    [Validate.required, data && data.Month, 'Month'],
    [Validate.required, data && data.HubID, 'Hub'],
    [Validate.exists, 'Hubs', data && data.HubID, 'Hub'],
    [Validate.required, data && data.GrossAmount, 'Gross amount'],
    [Validate.nonNegativeNumber, data && data.GrossAmount, 'Gross amount'],
    [Validate.nonNegativeNumber, data && data.Allowances, 'Allowances'],
    [Validate.nonNegativeNumber, data && data.Deductions, 'Deductions'],
    [Validate.required, data && data.Currency, 'Currency'],
    [Validate.required, data && data.AccountID, 'Account'],
    [Validate.exists, 'FinancialAccounts', data && data.AccountID, 'Account']
  ];
  if (data && data.ProjectID) checks.push([Validate.exists, 'Projects', data.ProjectID, 'Project']);

  var error = Validate.run(checks);
  if (error) return error;

  if (data && data.Month && !SALARY_MONTH_PATTERN.test(data.Month)) {
    return 'Month must be in the format YYYY-MM, e.g. 2026-07.';
  }
  return null;
}
