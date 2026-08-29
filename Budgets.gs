/**
 * ============================================================
 * BUDGETS.GS — Budgets, Budget Lines, and Budget-vs-Actual (Phase 17)
 * ============================================================
 * A Budget is a target figure for one Project (optionally scoped to
 * one Hub) for one financial year; BudgetLines break it down by
 * expense category. Budget-vs-Actual is computed on read, same
 * philosophy as FinanceBalance.gs — no stored running totals to drift
 * out of sync.
 *
 * A line's Actual/Committed is the sum of PAID / APPROVED-UNPAID
 * Invoices+Expenses+Reimbursements whose ProjectID matches the
 * Budget's ProjectID AND whose ExpenseCategory matches the line's
 * category (both blank ProjectID is a valid, intentional match — an
 * org-wide budget tracks org-wide, not-project-tagged spend). Salaries
 * are deliberately excluded here — that table has no ExpenseCategory,
 * so it isn't budget-line-trackable in this MVP.
 * ============================================================
 */

var BUDGETS_TABLE = 'Budgets';
var BUDGET_LINES_TABLE = 'BudgetLines';
var BUDGET_WARN_THRESHOLD = 0.75; // "approaching" warning fires at 75% used
var BUDGET_STATUSES = ['Active', 'Closed'];
var BUDGET_OUTFLOW_TABLES = ['Invoices', 'Expenses', 'Reimbursements'];

/** Sums Actual (Paid) and Committed (Approved, unpaid) for one budget line, scoped by ProjectID + ExpenseCategory. */
function computeBudgetLineFinancials_(budget, line) {
  var actual = 0, committed = 0;
  BUDGET_OUTFLOW_TABLES.forEach(function (table) {
    DB.getAll(table).forEach(function (row) {
      if (row.ProjectID !== budget.ProjectID || row.ExpenseCategory !== line.ExpenseCategory) return;
      if (row.PaymentStatus === 'Paid') actual += outflowAmount_(table, row);
      else if (row.Status === 'Approved') committed += outflowAmount_(table, row);
    });
  });

  var budgeted = Number(line.BudgetedAmount) || 0;
  var remaining = budgeted - actual - committed;
  var percentUsed = budgeted > 0 ? (actual + committed) / budgeted : null;
  var warningLevel = percentUsed === null ? null : (percentUsed >= 1 ? 'exceeded' : (percentUsed >= BUDGET_WARN_THRESHOLD ? 'approaching' : null));

  return { budgeted: budgeted, actual: actual, committed: committed, remaining: remaining, percentUsed: percentUsed, warningLevel: warningLevel };
}

/** Admin: every budget, org-wide, with Hub/Project names joined and a line count. */
function getBudgets(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var projectNames = {};
    DB.getAll('Projects').forEach(function (p) { projectNames[p.ProjectID] = p.ProjectName; });
    var lineCounts = {};
    DB.getAll(BUDGET_LINES_TABLE).forEach(function (l) { lineCounts[l.BudgetID] = (lineCounts[l.BudgetID] || 0) + 1; });

    var all = applyHubScope_(DB.getAll(BUDGETS_TABLE), resolveAdminHubScope_(identity), 'HubID');
    if (options.hubId) all = all.filter(function (b) { return b.HubID === options.hubId; });

    all = all.map(function (b) {
      return withField_(b, {
        HubName: hubNames[b.HubID] || (b.HubID ? b.HubID : '— Org-wide —'),
        ProjectName: projectNames[b.ProjectID] || (b.ProjectID ? b.ProjectID : '— None —'),
        LineCount: lineCounts[b.BudgetID] || 0
      });
    });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[BUDGETS_TABLE].searchableColumns,
      sortBy: options.sortBy || 'FinancialYear',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Hub Manager: read-only visibility into their own hub's budgets. */
function getMyHubBudgets(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var projectNames = {};
    DB.getAll('Projects').forEach(function (p) { projectNames[p.ProjectID] = p.ProjectName; });

    return DB.getAll(BUDGETS_TABLE)
      .filter(function (b) { return b.HubID === manager.hubId; })
      .map(function (b) { return withField_(b, { ProjectName: projectNames[b.ProjectID] || (b.ProjectID ? b.ProjectID : '— None —') }); });
  });
}

/**
 * One budget with every line's computed financials plus an overall
 * total row. Admin can view any budget; a Hub Manager only one scoped
 * to their own hub.
 */
function getBudgetDetail(sessionToken, budgetId) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var budget = DB.getById(BUDGETS_TABLE, budgetId);
    if (!budget) throw new Error('Budget not found.');
    if (identity.role === 'HubManager' && budget.HubID !== identity.hubId) {
      throw new Error('Budget not found.');
    }
    var hubScope = resolveAdminHubScope_(identity);
    if (hubScope && budget.HubID && !hubScope[budget.HubID]) {
      throw new Error('Budget not found.');
    }

    var lines = DB.getAll(BUDGET_LINES_TABLE).filter(function (l) { return l.BudgetID === budgetId; });
    var linesWithFinancials = lines.map(function (l) {
      return withField_(l, computeBudgetLineFinancials_(budget, l));
    });

    var totals = linesWithFinancials.reduce(function (acc, l) {
      acc.budgeted += l.budgeted; acc.actual += l.actual; acc.committed += l.committed; acc.remaining += l.remaining;
      return acc;
    }, { budgeted: 0, actual: 0, committed: 0, remaining: 0 });
    totals.percentUsed = totals.budgeted > 0 ? (totals.actual + totals.committed) / totals.budgeted : null;

    return { budget: budget, lines: linesWithFinancials, totals: totals };
  });
}

function createBudget(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var error = validateBudgetInput(data);
    if (error) throw new Error(error);

    var record = DB.insert(BUDGETS_TABLE, {
      ProjectID: data.ProjectID || '',
      HubID: data.HubID || '',
      Name: data.Name.trim(),
      FinancialYear: data.FinancialYear.trim(),
      TotalBudget: Number(data.TotalBudget),
      Currency: data.Currency,
      Status: 'Active'
    });
    logAudit_(identity, 'Create', BUDGETS_TABLE, record.BudgetID, '(record)', '', record.Name, record.HubID);
    return record;
  });
}

function updateBudget(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(BUDGETS_TABLE, id);
    if (!existing) throw new Error('Budget not found.');
    var error = validateBudgetInput(data);
    if (error) throw new Error(error);

    var record = DB.update(BUDGETS_TABLE, id, {
      ProjectID: data.ProjectID || '',
      HubID: data.HubID || '',
      Name: data.Name.trim(),
      FinancialYear: data.FinancialYear.trim(),
      TotalBudget: Number(data.TotalBudget),
      Status: data.Status || existing.Status
    });
    logAudit_(identity, 'Update', BUDGETS_TABLE, id, 'Name', existing.Name, record.Name, record.HubID);
    return record;
  });
}

function deleteBudget(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    if (DB.hasDependents(BUDGETS_TABLE, id, BUDGET_LINES_TABLE, 'BudgetID')) {
      throw new Error('Cannot delete this budget: it still has budget lines. Remove those first.');
    }
    var existing = DB.getById(BUDGETS_TABLE, id);
    DB.remove(BUDGETS_TABLE, id);
    logAudit_(identity, 'Delete', BUDGETS_TABLE, id, '(record)', existing ? existing.Name : '', '', existing ? existing.HubID : '');
    return true;
  });
}

function addBudgetLine(sessionToken, budgetId, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var budget = DB.getById(BUDGETS_TABLE, budgetId);
    if (!budget) throw new Error('Budget not found.');
    var error = validateBudgetLineInput(data);
    if (error) throw new Error(error);

    var duplicate = DB.getAll(BUDGET_LINES_TABLE).some(function (l) {
      return l.BudgetID === budgetId && l.ExpenseCategory === data.ExpenseCategory;
    });
    if (duplicate) throw new Error('This budget already has a line for that category.');

    var record = DB.insert(BUDGET_LINES_TABLE, {
      BudgetID: budgetId,
      ExpenseCategory: data.ExpenseCategory,
      BudgetedAmount: Number(data.BudgetedAmount),
      Currency: budget.Currency
    });
    logAudit_(identity, 'Create', BUDGET_LINES_TABLE, record.BudgetLineID, '(record)', '', record.ExpenseCategory + ' ' + record.BudgetedAmount, budget.HubID);
    return record;
  });
}

function updateBudgetLine(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(BUDGET_LINES_TABLE, id);
    if (!existing) throw new Error('Budget line not found.');
    var error = validateBudgetLineInput(data);
    if (error) throw new Error(error);

    var record = DB.update(BUDGET_LINES_TABLE, id, {
      ExpenseCategory: data.ExpenseCategory,
      BudgetedAmount: Number(data.BudgetedAmount)
    });
    logAudit_(identity, 'Update', BUDGET_LINES_TABLE, id, 'BudgetedAmount', existing.BudgetedAmount, record.BudgetedAmount, '');
    return record;
  });
}

function deleteBudgetLine(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var inUse = BUDGET_OUTFLOW_TABLES.some(function (table) { return DB.hasDependents(BUDGET_LINES_TABLE, id, table, 'BudgetLineID'); });
    if (inUse) {
      throw new Error('Cannot delete this budget line: invoices, expenses, or reimbursements already reference it.');
    }
    var existing = DB.getById(BUDGET_LINES_TABLE, id);
    DB.remove(BUDGET_LINES_TABLE, id);
    logAudit_(identity, 'Delete', BUDGET_LINES_TABLE, id, '(record)', existing ? existing.ExpenseCategory : '', '', '');
    return true;
  });
}

function validateBudgetInput(data) {
  var checks = [
    [Validate.required, data && data.Name, 'Name'],
    [Validate.maxLength, data && data.Name, 150, 'Name'],
    [Validate.required, data && data.FinancialYear, 'Financial year'],
    [Validate.required, data && data.TotalBudget, 'Total budget'],
    [Validate.nonNegativeNumber, data && data.TotalBudget, 'Total budget'],
    [Validate.required, data && data.Currency, 'Currency']
  ];
  if (data && data.HubID) checks.push([Validate.exists, 'Hubs', data.HubID, 'Hub']);
  if (data && data.ProjectID) checks.push([Validate.exists, 'Projects', data.ProjectID, 'Project']);
  if (data && data.Status) checks.push([Validate.oneOf, data.Status, BUDGET_STATUSES, 'Status']);
  return Validate.run(checks);
}

function validateBudgetLineInput(data) {
  return Validate.run([
    [Validate.required, data && data.ExpenseCategory, 'Expense category'],
    [Validate.required, data && data.BudgetedAmount, 'Budgeted amount'],
    [Validate.nonNegativeNumber, data && data.BudgetedAmount, 'Budgeted amount']
  ]);
}
