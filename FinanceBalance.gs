/**
 * ============================================================
 * FINANCEBALANCE.GS — The balance calculation engine (Phase 17)
 * ============================================================
 * DELIBERATE DESIGN DECISION — read this before "fixing" it:
 *
 * There is no stored, synced ledger table here. Every figure below is
 * computed FRESH, on every call, by scanning the source tables
 * (FundingTransactions, Invoices, Expenses, Salaries, Reimbursements,
 * BalanceAdjustments) and filtering on Status/PaymentStatus/AccountID
 * — exactly how UsageKPIs.gs computes the M&E dashboards. Google
 * Sheets has no transactional atomicity, so a separately-maintained
 * double-entry ledger that has to be kept perfectly in sync with
 * those source tables WILL drift over time (a failed write, a manual
 * sheet edit, a bug in one update path and not another). Computing
 * on read makes drift structurally impossible: the source tables ARE
 * the ledger. See FINANCE_MODULE_INSTRUCTIONS.md §3.2.
 *
 * The two headline formulas (never change this arithmetic without
 * updating both the code AND the instructions doc):
 *
 *   Current Bank Balance
 *     = Opening Balance + Confirmed Funding + Approved Adjustments
 *       - Paid Outflows (invoices+expenses+salaries+reimbursements)
 *
 *   Available After Commitments
 *     = Current Bank Balance - Approved-but-unpaid commitments
 *
 * Raising an invoice/expense/reimbursement deducts NOTHING. Approval
 * moves it into "Committed". PaymentStatus='Paid' moves it into
 * actual expenditure. Rejected/Returned/Cancelled records are
 * excluded from every total but are never deleted (see FinanceCommon.gs).
 * ============================================================
 */

/** Tables + the field holding the paid/approved amount, for every outflow type that can be linked to an account. */
var FINANCE_OUTFLOW_SOURCES = [
  { table: 'Invoices', amountField: 'TotalAmount' },
  { table: 'Expenses', amountField: 'TotalAmount' },
  { table: 'Salaries', amountField: 'NetProjectCost' },
  { table: 'Reimbursements', amountField: 'ReimbursementApprovedAmount_' } // resolved specially below
];

function outflowAmount_(table, row) {
  if (table === 'Reimbursements') {
    var approved = row.ApprovedAmount;
    return (approved === '' || approved === undefined || approved === null) ? Number(row.Amount) || 0 : Number(approved) || 0;
  }
  var field = FINANCE_OUTFLOW_SOURCES.filter(function (s) { return s.table === table; })[0].amountField;
  return Number(row[field]) || 0;
}

/** Sum of Paid outflows against one account, across every outflow-bearing table. */
function paidOutflowsForAccount_(accountId) {
  var total = 0;
  FINANCE_OUTFLOW_SOURCES.forEach(function (source) {
    DB.getAll(source.table).forEach(function (row) {
      if (row.AccountID === accountId && row.PaymentStatus === 'Paid') {
        total += outflowAmount_(source.table, row);
      }
    });
  });
  return total;
}

/** Sum of Approved-but-unpaid outflows against one account — the "Committed Funds" figure. */
function approvedUnpaidForAccount_(accountId) {
  var total = 0;
  FINANCE_OUTFLOW_SOURCES.forEach(function (source) {
    DB.getAll(source.table).forEach(function (row) {
      if (row.AccountID === accountId && row.Status === 'Approved' && row.PaymentStatus !== 'Paid') {
        total += outflowAmount_(source.table, row);
      }
    });
  });
  return total;
}

/** Sum of Submitted/Under Review/Returned outflows against one account — informational only (Salaries has no such stage). */
function pendingApprovalForAccount_(accountId) {
  var total = 0;
  ['Invoices', 'Expenses', 'Reimbursements'].forEach(function (table) {
    DB.getAll(table).forEach(function (row) {
      if (row.AccountID === accountId && FINANCE_PENDING_STATUSES.indexOf(row.Status) !== -1) {
        total += outflowAmount_(table, row);
      }
    });
  });
  return total;
}

/** The full financial picture for one FinancialAccount. */
function getAccountFinancials_(accountId) {
  var account = DB.getById('FinancialAccounts', accountId);
  if (!account) throw new Error('Account not found.');

  var opening = Number(account.OpeningBalance) || 0;

  var fundingConfirmed = sumWhere_('FundingTransactions', function (f) {
    return f.AccountID === accountId && f.Status === 'Confirmed';
  }, 'Amount');

  var adjustments = sumWhere_('BalanceAdjustments', function (a) {
    return a.AccountID === accountId && a.Status === 'Approved';
  }, 'Amount'); // signed

  var paidOut = paidOutflowsForAccount_(accountId);
  var committed = approvedUnpaidForAccount_(accountId);
  var pending = pendingApprovalForAccount_(accountId);

  var currentBank = opening + fundingConfirmed + adjustments - paidOut;

  return {
    accountId: accountId,
    accountName: account.AccountName,
    currency: account.Currency,
    openingBalance: opening,
    fundingConfirmed: fundingConfirmed,
    adjustments: adjustments,
    paidExpenditure: paidOut,
    currentBankBalance: currentBank,
    committedFunds: committed,
    availableAfterCommitments: currentBank - committed,
    pendingApproval: pending
  };
}

/**
 * Admin: every account's financials, plus totals grouped BY CURRENCY
 * (§6 — different currencies are never summed together) and a small
 * set of alert flags. This is intentionally the whole picture in one
 * call; drill-down list endpoints (getInvoices/getExpenses/... with a
 * status filter) supply the underlying records behind any figure here.
 */
function getFinancialDashboard(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};
    var hubScope = resolveAdminHubScope_(identity);
    var countryScope = resolveCountryFilterScope_(options.countryId);
    var filterHubId = options.hubId;

    // Applies the mandatory CountryDirector scope, the voluntary Country
    // filter, and the voluntary Hub filter, in that order — used at
    // every scoped read below so none of the 8 sites can miss one.
    function scopedHub_(table) {
      var records = applyHubScope_(DB.getAll(table), hubScope, 'HubID');
      records = applyHubScope_(records, countryScope, 'HubID');
      if (filterHubId) records = records.filter(function (r) { return r.HubID === filterHubId; });
      return records;
    }

    var accounts = scopedHub_('FinancialAccounts').filter(function (a) { return a.Status === 'Active'; });
    var perAccount = accounts.map(function (a) { return getAccountFinancials_(a.AccountID); });

    var byCurrency = {};
    perAccount.forEach(function (f) {
      if (!byCurrency[f.currency]) {
        byCurrency[f.currency] = {
          currency: f.currency, openingBalance: 0, fundingConfirmed: 0, adjustments: 0,
          paidExpenditure: 0, currentBankBalance: 0, committedFunds: 0,
          availableAfterCommitments: 0, pendingApproval: 0
        };
      }
      var t = byCurrency[f.currency];
      t.openingBalance += f.openingBalance;
      t.fundingConfirmed += f.fundingConfirmed;
      t.adjustments += f.adjustments;
      t.paidExpenditure += f.paidExpenditure;
      t.currentBankBalance += f.currentBankBalance;
      t.committedFunds += f.committedFunds;
      t.availableAfterCommitments += f.availableAfterCommitments;
      t.pendingApproval += f.pendingApproval;
    });

    var lowBalanceThreshold = Number(PropertiesService.getScriptProperties().getProperty('FINANCE_LOW_BALANCE_THRESHOLD')) || 0;
    var lowBalanceAccounts = lowBalanceThreshold > 0
      ? perAccount.filter(function (f) { return f.availableAfterCommitments < lowBalanceThreshold; })
      : [];

    var missingReceipts = scopedHub_('Expenses').filter(function (e) {
      return (e.Status === 'Approved' || e.PaymentStatus === 'Paid') && !e.ReceiptDocumentID;
    }).length + scopedHub_('Reimbursements').filter(function (r) {
      return (r.Status === 'Approved' || r.PaymentStatus === 'Paid') && !r.ReceiptDocumentID;
    }).length;

    var invoicesAwaitingApproval = scopedHub_('Invoices').filter(function (i) {
      return FINANCE_PENDING_STATUSES.indexOf(i.Status) !== -1;
    }).length;
    var expensesAwaitingApproval = scopedHub_('Expenses').filter(function (e) {
      return FINANCE_PENDING_STATUSES.indexOf(e.Status) !== -1;
    }).length;
    var reimbursementsAwaitingApproval = scopedHub_('Reimbursements').filter(function (r) {
      return FINANCE_PENDING_STATUSES.indexOf(r.Status) !== -1;
    }).length;

    var fundingUnconfirmed = scopedHub_('FundingTransactions').filter(function (f) { return f.Status === 'Recorded'; }).length;

    // Budget risk: any line at/over the warning threshold on an Active budget.
    var budgetsAtRisk = [];
    scopedHub_(BUDGETS_TABLE).filter(function (b) { return b.Status === 'Active'; }).forEach(function (b) {
      DB.getAll(BUDGET_LINES_TABLE).filter(function (l) { return l.BudgetID === b.BudgetID; }).forEach(function (l) {
        var f = computeBudgetLineFinancials_(b, l);
        if (f.warningLevel) budgetsAtRisk.push({ budgetId: b.BudgetID, budgetName: b.Name, category: l.ExpenseCategory, percentUsed: f.percentUsed, warningLevel: f.warningLevel });
      });
    });

    // Converted view: an OPTIONAL supplement to byCurrency above, never
    // a replacement for it. Sums every currency's currentBankBalance/
    // committedFunds/availableAfterCommitments into the system
    // currency using the most recently logged rate (ExchangeRates.gs).
    // A currency with no rate ever logged is excluded from the total
    // and listed in excludedCurrencies so the UI can say so plainly —
    // never silently assumed to convert at 1.
    var systemCurrency = PropertiesService.getScriptProperties().getProperty(CURRENCY_PROPERTY_KEY) || DEFAULT_CURRENCY_CODE;
    var convertedTotals = { currentBankBalance: 0, committedFunds: 0, availableAfterCommitments: 0, pendingApproval: 0 };
    var excludedCurrencies = [];
    Object.keys(byCurrency).forEach(function (code) {
      var t = byCurrency[code];
      var bank = convertToSystemCurrency_(t.currentBankBalance, code);
      var committed = convertToSystemCurrency_(t.committedFunds, code);
      var available = convertToSystemCurrency_(t.availableAfterCommitments, code);
      var pending = convertToSystemCurrency_(t.pendingApproval, code);
      if (bank.missingRate) { excludedCurrencies.push(code); return; }
      convertedTotals.currentBankBalance += bank.converted;
      convertedTotals.committedFunds += committed.converted;
      convertedTotals.availableAfterCommitments += available.converted;
      convertedTotals.pendingApproval += pending.converted;
    });

    return {
      accounts: perAccount,
      byCurrency: Object.keys(byCurrency).map(function (k) { return byCurrency[k]; }),
      converted: {
        systemCurrency: systemCurrency,
        totals: convertedTotals,
        excludedCurrencies: excludedCurrencies,
        hasMultipleCurrencies: Object.keys(byCurrency).length > 1
      },
      alerts: {
        lowBalanceAccounts: lowBalanceAccounts,
        missingReceipts: missingReceipts,
        invoicesAwaitingApproval: invoicesAwaitingApproval,
        expensesAwaitingApproval: expensesAwaitingApproval,
        reimbursementsAwaitingApproval: reimbursementsAwaitingApproval,
        fundingUnconfirmed: fundingUnconfirmed,
        budgetsAtRisk: budgetsAtRisk
      }
    };
  });
}

/**
 * Hub Manager: their own hub's accounts, plus staff cost as an
 * AGGREGATE ONLY — never individual Salaries rows (§9). Queries the
 * Salaries table directly rather than going through a Salaries.gs
 * function so this works correctly even before that module exists.
 *
 * Bank balance figures (openingBalance, fundingConfirmed, adjustments,
 * paidExpenditure, currentBankBalance, availableAfterCommitments) are
 * ADMIN-ONLY — a Hub Manager only gets to see workflow-status figures
 * (committedFunds, pendingApproval) that don't reveal how much money
 * is actually in the organization's account. This is stripped
 * server-side, not just hidden in the UI, so it can't be recovered by
 * inspecting the network response.
 */
function getMyHubFinancialSummary(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);

    var accounts = DB.getAll('FinancialAccounts').filter(function (a) { return a.HubID === manager.hubId && a.Status === 'Active'; });
    var perAccount = accounts.map(function (a) {
      var f = getAccountFinancials_(a.AccountID);
      return {
        accountId: f.accountId,
        accountName: f.accountName,
        currency: f.currency,
        committedFunds: f.committedFunds,
        pendingApproval: f.pendingApproval
      };
    });

    var month = currentMonthLabel_();
    var staffCostThisMonth = sumWhere_('Salaries', function (s) {
      return s.HubID === manager.hubId && s.Month === month && s.PaymentStatus === 'Paid';
    }, 'NetProjectCost');

    return {
      accounts: perAccount,
      staffCostThisMonth: { month: month, total: staffCostThisMonth }
    };
  });
}
