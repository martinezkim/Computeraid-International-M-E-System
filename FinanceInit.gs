/**
 * ============================================================
 * FINANCEINIT.GS — One-time Finance module seeding (Phase 17)
 * ============================================================
 * Run initFinanceModule() ONCE from the Apps Script editor's Run
 * dropdown after the first deploy of the Finance module (also a
 * convenient way to trigger the Drive/Sheets OAuth consent screen
 * the module needs — see FINANCE_MODULE_INSTRUCTIONS.md §2.9).
 * Idempotent/safe to run more than once: each seed only inserts if
 * that exact category doesn't already exist. No trailing underscore
 * on the function name — it must stay visible in the editor's
 * dropdown so it can be run by name (see the "private function"
 * naming caveat elsewhere in this codebase).
 * ============================================================
 */

var FINANCE_DEFAULT_EXPENSE_CATEGORIES = [
  // 'Salaries' is the reserved payroll-only category (see
  // assertNotSalaryCategory_ in FinanceCommon.gs — Invoices/Expenses may
  // never use it). 'Stipend/Salaries' is the separate, Invoice-usable
  // category for things like a Hub Manager's own stipend — see
  // FINANCE_STIPEND_CATEGORY_NAME/isStipendInvoice_ in Invoices.gs.
  'Salaries', 'Stipend/Salaries', 'Transport', 'Accommodation', 'Meals', 'Training', 'Internet',
  'Electricity & Utilities', 'Equipment', 'Supplies & Stationery', 'Fuel',
  'Communication', 'Maintenance & Repairs', 'Venue Hire', 'Travel', 'Other'
];

var FINANCE_DEFAULT_INCOME_CATEGORIES = ['Grant Funding', 'Other Income'];

function initFinanceModule() {
  var existing = DB.getAll(FINANCE_CATEGORIES_TABLE);
  var existingNames = {};
  existing.forEach(function (c) { existingNames[c.Type + '::' + c.Name] = true; });

  var seeded = 0;
  function seed(name, type, sortOrder) {
    if (existingNames[type + '::' + name]) return;
    DB.insert(FINANCE_CATEGORIES_TABLE, { Name: name, Type: type, Active: true, SortOrder: sortOrder });
    seeded++;
  }

  FINANCE_DEFAULT_EXPENSE_CATEGORIES.forEach(function (name, i) { seed(name, 'Expense', i + 1); });
  FINANCE_DEFAULT_INCOME_CATEGORIES.forEach(function (name, i) { seed(name, 'Income', i + 1); });

  // Touching every finance table's sheet here (getSheet auto-creates a
  // missing sheet on first access) means the whole module's spreadsheet
  // structure exists right after this one run, instead of each sheet
  // silently appearing one-by-one the first time each feature is used.
  var financeTables = [
    'FinanceCategories', 'FinanceStaff', 'FinancialAccounts', 'FundingTransactions',
    'Invoices', 'Expenses', 'Salaries', 'Reimbursements', 'Budgets', 'BudgetLines',
    'FinancialDocuments', 'BalanceAdjustments'
  ];
  financeTables.forEach(function (t) { DB.getSheet(t); });

  Logger.log('Finance module initialized. Seeded ' + seeded + ' new categories. ' +
    financeTables.length + ' finance sheets confirmed present.');
  return { categoriesSeeded: seeded, sheetsConfirmed: financeTables.length };
}
