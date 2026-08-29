/**
 * ============================================================
 * FINANCEREPORTS.GS — Monthly / Project / Hub / Category reports (Phase 17)
 * ============================================================
 * All Admin-only, all computed on read from the same source tables
 * the balance engine and Budgets use — no separate report cache to
 * go stale. Each report also returns a flat `records` array so the
 * client can export it with the existing exportRecordsToFile()
 * helper (CoreJS.html) — no separate export code needed here.
 *
 * SCOPE NOTE: this MVP reports "paid within the period" totals, not a
 * full point-in-time reconstructed account balance as of a past date
 * (e.g. "what was the balance on July 31?"). That would require
 * replaying every transaction up to a cutoff date, which is a
 * meaningfully bigger feature — flagged here rather than silently
 * approximated. The Monthly report's "Funding Confirmed" and "Paid
 * Expenditure" totals ARE exact for the chosen month.
 * ============================================================
 */

var FINANCE_OUTFLOW_CATEGORY_TABLES = ['Invoices', 'Expenses', 'Reimbursements']; // tables with an ExpenseCategory field
var SALARY_CATEGORY_LABEL = 'Salaries'; // Salaries has no ExpenseCategory column — bucketed under this fixed label

/**
 * Scans every outflow-bearing table (including Salaries) and returns
 * a normalized flat row for each one where `predicate(row, table)` is
 * true — the shared basis for every report below and for CSV/Excel
 * export.
 */
function collectOutflowRecords_(predicate) {
  var rows = [];
  FINANCE_OUTFLOW_CATEGORY_TABLES.forEach(function (table) {
    DB.getAll(table).forEach(function (row) {
      if (!predicate(row, table)) return;
      rows.push({
        Type: table.slice(0, -1), // 'Invoice' / 'Expense' / 'Reimbursement'
        Category: row.ExpenseCategory,
        Date: row.PaymentDate || row.Date || row.InvoiceDate || '',
        HubID: row.HubID,
        ProjectID: row.ProjectID,
        Amount: outflowAmount_(table, row),
        Currency: row.Currency,
        Status: row.Status,
        PaymentStatus: row.PaymentStatus
      });
    });
  });
  DB.getAll(SALARIES_TABLE).forEach(function (row) {
    if (!predicate(row, SALARIES_TABLE)) return;
    rows.push({
      Type: 'Salary', Category: SALARY_CATEGORY_LABEL, Date: row.PaymentDate || row.Month || '',
      HubID: row.HubID, ProjectID: row.ProjectID, Amount: Number(row.NetProjectCost) || 0,
      Currency: row.Currency, Status: row.Status, PaymentStatus: row.PaymentStatus
    });
  });
  return rows;
}

/** Monthly report: funding confirmed + paid expenditure (by category) for one 'YYYY-MM' month. */
function getMonthlyFinancialReport(sessionToken, month, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var hubScope = resolveAdminHubScope_(identity);
    var countryScope = resolveCountryFilterScope_((options || {}).countryId);
    var filterHubId = (options || {}).hubId;
    var targetMonth = (month && /^\d{4}-\d{2}$/.test(month)) ? month : currentMonthLabel_();

    var fundingConfirmed = sumWhere_('FundingTransactions', function (f) {
      return f.Status === 'Confirmed' && String(f.DateReceived || '').slice(0, 7) === targetMonth &&
        (!hubScope || !f.HubID || !!hubScope[f.HubID]) &&
        (!countryScope || !f.HubID || !!countryScope[f.HubID]) &&
        (!filterHubId || f.HubID === filterHubId);
    }, 'Amount');

    var records = collectOutflowRecords_(function (row) {
      return row.PaymentStatus === 'Paid' && String(row.PaymentDate || '').slice(0, 7) === targetMonth &&
        (!hubScope || !row.HubID || !!hubScope[row.HubID]) &&
        (!countryScope || !row.HubID || !!countryScope[row.HubID]) &&
        (!filterHubId || row.HubID === filterHubId);
    });

    var byCategory = {};
    records.forEach(function (r) {
      byCategory[r.Category] = (byCategory[r.Category] || 0) + r.Amount;
    });
    var totalPaid = records.reduce(function (sum, r) { return sum + r.Amount; }, 0);

    return {
      month: targetMonth,
      fundingConfirmed: fundingConfirmed,
      totalPaid: totalPaid,
      byCategory: Object.keys(byCategory).map(function (k) { return { category: k, amount: byCategory[k] }; }).sort(function (a, b) { return b.amount - a.amount; }),
      records: records
    };
  });
}

/**
 * Project report: funding, actual (paid) + committed (approved-unpaid)
 * expenditure, spend by category, matched Budget (if one exists), and
 * cost-per-beneficiary — a plain cost ratio (total paid ÷
 * TotalNewBeneficiaries already on the Projects record), not a claim
 * of impact or value-for-money.
 */
function getProjectFinancialReport(sessionToken, projectId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var project = DB.getById('Projects', projectId);
    if (!project) throw new Error('Project not found.');
    var hubScope = resolveAdminHubScope_(identity);
    if (hubScope && project.HubID && !hubScope[project.HubID]) throw new Error('Project not found.');

    var fundingConfirmed = sumWhere_('FundingTransactions', function (f) {
      return f.ProjectID === projectId && f.Status === 'Confirmed';
    }, 'Amount');

    var paidRecords = collectOutflowRecords_(function (row) { return row.ProjectID === projectId && row.PaymentStatus === 'Paid'; });
    var committedRecords = collectOutflowRecords_(function (row) { return row.ProjectID === projectId && row.Status === 'Approved' && row.PaymentStatus !== 'Paid'; });

    var totalPaid = paidRecords.reduce(function (sum, r) { return sum + r.Amount; }, 0);
    var totalCommitted = committedRecords.reduce(function (sum, r) { return sum + r.Amount; }, 0);

    var byCategory = {};
    paidRecords.forEach(function (r) { byCategory[r.Category] = (byCategory[r.Category] || 0) + r.Amount; });

    var budget = DB.getAll(BUDGETS_TABLE).filter(function (b) { return b.ProjectID === projectId; })[0] || null;

    var beneficiaryCount = Number(getProjectStats_(project).TotalNewBeneficiaries) || 0;
    var costPerBeneficiary = beneficiaryCount > 0 ? (totalPaid / beneficiaryCount) : null;

    return {
      project: { id: project.ProjectID, name: project.ProjectName, beneficiaryCount: beneficiaryCount },
      budget: budget,
      fundingConfirmed: fundingConfirmed,
      totalPaid: totalPaid,
      totalCommitted: totalCommitted,
      byCategory: Object.keys(byCategory).map(function (k) { return { category: k, amount: byCategory[k] }; }).sort(function (a, b) { return b.amount - a.amount; }),
      costPerBeneficiary: costPerBeneficiary,
      records: paidRecords.concat(committedRecords)
    };
  });
}

/** Hub report: funding, accounts summary (reusing the balance engine), paid + committed totals for that hub. */
function getHubFinancialReport(sessionToken, hubId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var hub = DB.getById('Hubs', hubId);
    if (!hub) throw new Error('Hub not found.');
    var hubScope = resolveAdminHubScope_(identity);
    if (hubScope && !hubScope[hubId]) throw new Error('Hub not found.');

    var fundingConfirmed = sumWhere_('FundingTransactions', function (f) {
      return f.HubID === hubId && f.Status === 'Confirmed';
    }, 'Amount');

    var accounts = DB.getAll(FINANCIAL_ACCOUNTS_TABLE)
      .filter(function (a) { return a.HubID === hubId && a.Status === 'Active'; })
      .map(function (a) { return getAccountFinancials_(a.AccountID); });

    var paidRecords = collectOutflowRecords_(function (row) { return row.HubID === hubId && row.PaymentStatus === 'Paid'; });
    var committedRecords = collectOutflowRecords_(function (row) { return row.HubID === hubId && row.Status === 'Approved' && row.PaymentStatus !== 'Paid'; });
    var totalPaid = paidRecords.reduce(function (sum, r) { return sum + r.Amount; }, 0);
    var totalCommitted = committedRecords.reduce(function (sum, r) { return sum + r.Amount; }, 0);

    return {
      hub: { id: hub.HubID, name: hub.HubName },
      fundingConfirmed: fundingConfirmed,
      accounts: accounts,
      totalPaid: totalPaid,
      totalCommitted: totalCommitted,
      records: paidRecords.concat(committedRecords)
    };
  });
}

/** Category report: paid + committed totals per expense category, optionally scoped to a hub and/or a PaymentDate range. */
function getCategoryReport(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var hubScope = resolveAdminHubScope_(identity);
    options = options || {};
    var countryScope = resolveCountryFilterScope_(options.countryId);

    function inScope(row) {
      if (options.hubId && row.HubID !== options.hubId) return false;
      if (hubScope && row.HubID && !hubScope[row.HubID]) return false;
      if (countryScope && row.HubID && !countryScope[row.HubID]) return false;
      var date = row.PaymentStatus === 'Paid' ? row.PaymentDate : null;
      if (options.startDate && date && date < options.startDate) return false;
      if (options.endDate && date && date > options.endDate) return false;
      return true;
    }

    var paidRecords = collectOutflowRecords_(function (row) { return row.PaymentStatus === 'Paid' && inScope(row); });
    var committedRecords = collectOutflowRecords_(function (row) { return row.Status === 'Approved' && row.PaymentStatus !== 'Paid' && inScope(row); });

    var byCategory = {};
    paidRecords.forEach(function (r) {
      byCategory[r.Category] = byCategory[r.Category] || { category: r.Category, paid: 0, committed: 0 };
      byCategory[r.Category].paid += r.Amount;
    });
    committedRecords.forEach(function (r) {
      byCategory[r.Category] = byCategory[r.Category] || { category: r.Category, paid: 0, committed: 0 };
      byCategory[r.Category].committed += r.Amount;
    });

    return {
      byCategory: Object.keys(byCategory).map(function (k) { return byCategory[k]; }).sort(function (a, b) { return (b.paid + b.committed) - (a.paid + a.committed); }),
      records: paidRecords.concat(committedRecords)
    };
  });
}
