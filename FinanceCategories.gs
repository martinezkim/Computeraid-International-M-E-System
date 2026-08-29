/**
 * ============================================================
 * FINANCECATEGORIES.GS — Admin-editable expense/income category list
 * ============================================================
 * Same shape as Activities.gs/VisitorTypes.gs. Invoices, Expenses,
 * Reimbursements and BudgetLines all store the category NAME
 * directly in their ExpenseCategory column (not a CategoryID FK) —
 * the same convention BeneficiaryVisits.VisitorType already uses —
 * so no join is needed anywhere else to display or filter by
 * category.
 * ============================================================
 */

var FINANCE_CATEGORIES_TABLE = 'FinanceCategories';
var FINANCE_CATEGORY_TYPES = ['Expense', 'Income'];

function getFinanceCategories(sessionToken, options) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    options = options || {};
    var all = DB.getAll(FINANCE_CATEGORIES_TABLE);
    if (options.type) all = all.filter(function (c) { return c.Type === options.type; });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[FINANCE_CATEGORIES_TABLE].searchableColumns,
      sortBy: options.sortBy || 'SortOrder',
      sortDir: options.sortDir || 'asc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Every active category (optionally filtered to Expense/Income) as {id, name, type} tuples, for form dropdowns/checklists. */
function getFinanceCategoryOptions(sessionToken, type) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    var all = DB.getAll(FINANCE_CATEGORIES_TABLE)
      .filter(function (c) { return c.Active === true || c.Active === 'true'; });
    if (type) all = all.filter(function (c) { return c.Type === type; });
    return all
      .sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
      .map(function (c) { return { id: c.CategoryID, name: c.Name, type: c.Type }; });
  });
}

function addFinanceCategory(sessionToken, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateFinanceCategoryInput(data);
    if (error) throw new Error(error);

    return DB.insert(FINANCE_CATEGORIES_TABLE, {
      Name: data.Name.trim(),
      Type: data.Type,
      Active: data.Active !== false,
      SortOrder: Number(data.SortOrder) || 0
    });
  });
}

function updateFinanceCategory(sessionToken, id, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateFinanceCategoryInput(data);
    if (error) throw new Error(error);

    return DB.update(FINANCE_CATEGORIES_TABLE, id, {
      Name: data.Name.trim(),
      Type: data.Type,
      Active: !!data.Active,
      SortOrder: Number(data.SortOrder) || 0
    });
  });
}

function deleteFinanceCategory(sessionToken, id) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var category = DB.getById(FINANCE_CATEGORIES_TABLE, id);
    if (!category) throw new Error('Category not found.');

    // ExpenseCategory columns store the category NAME (see file header
    // comment), so dependency checks must match on Name, not CategoryID.
    var inUse = DB.hasDependents(FINANCE_CATEGORIES_TABLE, category.Name, 'Invoices', 'ExpenseCategory')
      || DB.hasDependents(FINANCE_CATEGORIES_TABLE, category.Name, 'Expenses', 'ExpenseCategory')
      || DB.hasDependents(FINANCE_CATEGORIES_TABLE, category.Name, 'Reimbursements', 'ExpenseCategory')
      || DB.hasDependents(FINANCE_CATEGORIES_TABLE, category.Name, 'BudgetLines', 'ExpenseCategory');
    if (inUse) {
      throw new Error('Cannot delete this category: it is already used on one or more financial records. Mark it Inactive instead.');
    }
    DB.remove(FINANCE_CATEGORIES_TABLE, id);
    return true;
  });
}

function validateFinanceCategoryInput(data) {
  return Validate.run([
    [Validate.required, data && data.Name, 'Name'],
    [Validate.maxLength, data && data.Name, 100, 'Name'],
    [Validate.required, data && data.Type, 'Type'],
    [Validate.oneOf, data && data.Type, FINANCE_CATEGORY_TYPES, 'Type']
  ]);
}
