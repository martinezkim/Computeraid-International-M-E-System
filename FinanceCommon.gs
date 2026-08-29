/**
 * ============================================================
 * FINANCECOMMON.GS — Shared helpers used across every Finance module
 * ============================================================
 * Small, dependency-free helpers so Invoices/Expenses/Reimbursements/
 * BalanceAdjustments/FinancialAccounts don't each reinvent the same
 * self-approval guard, masking, or summing logic.
 * ============================================================
 */

/**
 * Enforces separation of duties: the person approving a finance record
 * must not be the person who submitted/raised it — even if both are
 * Admins. `submitterEmail` is whatever field the record used to stamp
 * who created/submitted it (SubmittedByEmail, MadeByEmail, ...).
 */
function assertNotSelfApproval_(submitterEmail, approverIdentity) {
  if (submitterEmail && approverIdentity && submitterEmail === approverIdentity.email) {
    throw new Error('You cannot approve a financial record you submitted yourself — ask another Admin to review it.');
  }
}

/** '1234567890' -> '•••• 7890'. Never send a full account number to the client. */
function maskAccountNumber_(full) {
  var digits = String(full || '').trim();
  if (digits.length <= 4) return digits ? '•••• ' + digits : '';
  return '•••• ' + digits.slice(-4);
}

/** Sums `amountField` across every row in `table` for which `predicate(row)` is true. */
function sumWhere_(table, predicate, amountField) {
  var total = 0;
  DB.getAll(table).forEach(function (row) {
    if (predicate(row)) total += Number(row[amountField]) || 0;
  });
  return total;
}

/** Current month as 'YYYY-MM' in the script's timezone — the Month value used on Salaries rows. */
function currentMonthLabel_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
}

/**
 * Finance statuses shared across Invoices/Expenses/Reimbursements —
 * the workflow described in FINANCE_MODULE_INSTRUCTIONS.md §5.
 * 'Cancelled' is reachable from any status and is terminal; it is the
 * ONLY way a finance record is ever retired — never DB.remove().
 */
var FINANCE_RECORD_STATUSES = ['Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected', 'Returned', 'Cancelled'];
var FINANCE_PAYMENT_STATUSES = ['Unpaid', 'Paid'];

/** Statuses that count as "pending approval" — informational only, never deducted from any balance. */
var FINANCE_PENDING_STATUSES = ['Submitted', 'Under Review', 'Returned'];

/**
 * The exact category name FinanceInit.gs seeds for salary spend.
 * Invoices/Expenses/Reimbursements must never be filed under this
 * category — Salaries.gs is a deliberately separate, Admin-only
 * workflow (individual amounts are never sent to a Hub Manager
 * client; see Salaries.gs's file header). Without this guard, a Hub
 * Manager could tag a regular Expense "Salaries" and quietly bypass
 * that whole protection — the row would show up in the ordinary
 * Expenses list (visible to Admin same as any other expense) instead
 * of the access-controlled Salaries table. assertNotSalaryCategory_
 * is the shared enforcement point; each module's validate*Input()
 * calls it.
 */
var FINANCE_SALARY_CATEGORY_NAME = 'Salaries';

function assertNotSalaryCategory_(category) {
  if (category === FINANCE_SALARY_CATEGORY_NAME) {
    return 'Salary payments are tracked separately in the Salaries module (Admin-only) — ask an Admin to record this there instead of as a regular expense.';
  }
  return null;
}
