/**
 * ============================================================
 * BANKRECONCILIATION.GS — Statement import, matching, reconciliation
 * ============================================================
 * SCOPE (Finance Phase 2): CSV bank statements only for now — CSV is
 * the format virtually every bank can export, and Apps Script has no
 * built-in XLSX parser without extra Advanced Service setup (the
 * Drive-conversion trick). Excel support can be added as a fast
 * follow once CSV is proven out; building a half-working XLSX parser
 * alongside a solid CSV one wasn't worth the risk for this pass.
 *
 * Bank statement date/amount formats vary a lot between banks, so
 * import is a two-step flow: previewBankStatementCsv() shows the
 * Admin the raw columns, then importBankStatement() re-parses using
 * whichever columns they mapped as Date/Description/Amount (or
 * separate Debit/Credit columns).
 *
 * RECONCILIATION SCOPE NOTE: this compares the CURRENT computed
 * balance (see FinanceBalance.gs) against the statement's own
 * ClosingBalance — not a historical point-in-time ledger walk. That
 * is an intentional MVP simplification (this app has no dated
 * transaction ledger to replay), fine when a statement is reconciled
 * soon after its period, but it means reconciling an old, back-dated
 * statement against today's balance isn't meaningful. A mismatch is
 * always surfaced for a human to investigate — never auto-corrected.
 * ============================================================
 */

var BANK_STATEMENTS_TABLE = 'BankStatements';
var BANK_TRANSACTIONS_TABLE = 'BankTransactions';
var RECONCILIATIONS_TABLE = 'Reconciliations';
var BANK_MATCH_DATE_WINDOW_DAYS = 3;
var BANK_MATCH_AMOUNT_TOLERANCE = 0.01;

/** Admin: parses raw CSV text and returns headers + a short preview, so columns can be mapped before committing an import. */
function previewBankStatementCsv(sessionToken, csvText) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    if (!csvText || !csvText.trim()) throw new Error('The file appears to be empty.');
    if (csvText.length > 2000000) throw new Error('File is too large — please split statements over ~2MB into smaller exports.');

    var rows = Utilities.parseCsv(csvText);
    if (rows.length < 2) throw new Error('No data rows found — the first row should be a header.');

    return {
      headers: rows[0],
      previewRows: rows.slice(1, 6),
      totalDataRows: rows.length - 1
    };
  });
}

/**
 * Admin: commits a bank statement import — creates the BankStatements
 * header row, then re-parses the full CSV using the caller-chosen
 * column mapping into BankTransactions rows.
 */
function importBankStatement(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var error = validateBankStatementInput(data);
    if (error) throw new Error(error);

    var rows = Utilities.parseCsv(data.csvText);
    var dataRows = rows.slice(1);

    var statement = DB.insert(BANK_STATEMENTS_TABLE, {
      AccountID: data.AccountID,
      StatementDate: data.StatementDate,
      OpeningBalance: Number(data.OpeningBalance),
      ClosingBalance: Number(data.ClosingBalance),
      Currency: data.Currency,
      FileDocumentID: data.FileDocumentID || '',
      UploadedByEmail: identity.email,
      DateUploaded: new Date(),
      Status: 'Uploaded'
    });
    claimFinancialDocument_(statement.FileDocumentID, BANK_STATEMENTS_TABLE, statement.StatementID);

    var imported = 0;
    dataRows.forEach(function (row) {
      if (!row.length || row.every(function (c) { return String(c).trim() === ''; })) return; // skip blank lines

      var dateVal = row[data.dateCol];
      var descVal = row[data.descCol] || '';
      var amount;
      if (data.amountMode === 'debitcredit') {
        var debit = parseFloat(String(row[data.debitCol]).replace(/,/g, '')) || 0;
        var credit = parseFloat(String(row[data.creditCol]).replace(/,/g, '')) || 0;
        amount = credit - debit;
      } else {
        amount = parseFloat(String(row[data.amountCol]).replace(/,/g, '')) || 0;
      }
      if (!dateVal || amount === 0) return; // nothing usable on this line

      DB.insert(BANK_TRANSACTIONS_TABLE, {
        StatementID: statement.StatementID,
        AccountID: data.AccountID,
        Date: normalizeCsvDate_(dateVal),
        Description: String(descVal).trim(),
        Amount: amount,
        MatchedTable: '',
        MatchedRecordID: '',
        MatchStatus: 'Unmatched'
      });
      imported++;
    });

    logAudit_(identity, 'Create', BANK_STATEMENTS_TABLE, statement.StatementID, '(record)', '', imported + ' transaction(s) imported', '');
    return { statementId: statement.StatementID, imported: imported };
  });
}

/**
 * Best-effort normalization of a bank CSV's date cell to 'yyyy-MM-dd'.
 * Tries ISO first, then a generic JS Date parse (handles most
 * unambiguous formats), then falls back to a DD/MM/YYYY reading
 * (common outside the US) before giving up and returning the raw
 * text untouched — an unparsed date just won't match well when
 * reconciling, but it won't crash the import either.
 */
function normalizeCsvDate_(raw) {
  var str = String(raw).trim();
  var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];

  var parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, 'UTC', 'yyyy-MM-dd');
  }

  var dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str);
  if (dm) {
    var day = dm[1].length === 1 ? '0' + dm[1] : dm[1];
    var month = dm[2].length === 1 ? '0' + dm[2] : dm[2];
    return dm[3] + '-' + month + '-' + day;
  }
  return str;
}

function validateBankStatementInput(data) {
  var error = Validate.run([
    [Validate.required, data && data.AccountID, 'Account'],
    [Validate.exists, 'FinancialAccounts', data && data.AccountID, 'Account'],
    [Validate.required, data && data.StatementDate, 'Statement date'],
    [Validate.required, data && data.OpeningBalance, 'Opening balance'],
    [Validate.nonNegativeNumber, data && data.OpeningBalance, 'Opening balance'],
    [Validate.required, data && data.ClosingBalance, 'Closing balance'],
    [Validate.nonNegativeNumber, data && data.ClosingBalance, 'Closing balance'],
    [Validate.required, data && data.Currency, 'Currency'],
    [Validate.required, data && data.csvText, 'CSV file']
  ]);
  if (error) return error;

  // Column indices are zero-based, so 0 is a valid value — Validate.required
  // can't be reused here (it would reject index 0 fine, but undefined/null/''
  // need an explicit check rather than relying on required()'s string coercion).
  if (data.dateCol === undefined || data.dateCol === null || data.dateCol === '') return 'Select which column holds the date.';
  if (data.descCol === undefined || data.descCol === null || data.descCol === '') return 'Select which column holds the description.';
  if (data.amountMode === 'debitcredit') {
    if (data.debitCol === undefined || data.debitCol === null || data.debitCol === '') return 'Select which column holds the debit amount.';
    if (data.creditCol === undefined || data.creditCol === null || data.creditCol === '') return 'Select which column holds the credit amount.';
  } else if (data.amountCol === undefined || data.amountCol === null || data.amountCol === '') {
    return 'Select which column holds the amount.';
  }
  return null;
}

/** Admin: every statement, newest first, with AccountName + transaction/match counts joined. */
function getBankStatements(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var accountsById = {};
    DB.getAll(FINANCIAL_ACCOUNTS_TABLE).forEach(function (a) { accountsById[a.AccountID] = a.AccountName; });

    var countsByStatement = {};
    DB.getAll(BANK_TRANSACTIONS_TABLE).forEach(function (t) {
      if (!countsByStatement[t.StatementID]) countsByStatement[t.StatementID] = { total: 0, unmatched: 0 };
      countsByStatement[t.StatementID].total++;
      if (t.MatchStatus === 'Unmatched') countsByStatement[t.StatementID].unmatched++;
    });

    var accountScope = resolveAdminAccountScope_(resolveAdminHubScope_(identity));
    var all = applyHubScope_(DB.getAll(BANK_STATEMENTS_TABLE), accountScope, 'AccountID');
    all = applyHubScope_(all, resolveAdminAccountScope_(resolveCountryFilterScope_(options.countryId)), 'AccountID');
    if (options.accountId) all = all.filter(function (s) { return s.AccountID === options.accountId; });
    all = all.map(function (s) {
      var c = countsByStatement[s.StatementID] || { total: 0, unmatched: 0 };
      return withField_(s, { AccountName: accountsById[s.AccountID] || s.AccountID, TransactionCount: c.total, UnmatchedCount: c.unmatched });
    });

    return paginateAndFilter(all, {
      sortBy: options.sortBy || 'StatementDate',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Admin: every transaction on one statement, oldest first. */
function getBankTransactions(sessionToken, statementId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var accountScope = resolveAdminAccountScope_(resolveAdminHubScope_(identity));
    return applyHubScope_(DB.getAll(BANK_TRANSACTIONS_TABLE), accountScope, 'AccountID')
      .filter(function (t) { return t.StatementID === statementId; })
      .sort(function (a, b) { return String(a.Date).localeCompare(String(b.Date)); });
  });
}

/** {table -> id} pairs already claimed by a Matched bank transaction, so auto/manual matching never double-claims the same system record. */
function alreadyMatchedKeys_() {
  var keys = {};
  DB.getAll(BANK_TRANSACTIONS_TABLE).forEach(function (t) {
    if (t.MatchStatus === 'Matched' && t.MatchedTable && t.MatchedRecordID) {
      keys[t.MatchedTable + ':' + t.MatchedRecordID] = true;
    }
  });
  return keys;
}

function outflowIdField_(table) {
  var map = { Invoices: 'InvoiceID', Expenses: 'ExpenseID', Salaries: 'SalaryID', Reimbursements: 'ReimbursementID' };
  return map[table];
}

/**
 * Admin: attempts to match every Unmatched transaction on a statement
 * against Paid/Confirmed system records on the same account — an
 * inflow (Amount >= 0) against Confirmed FundingTransactions, an
 * outflow (Amount < 0) against Paid Invoices/Expenses/Salaries/
 * Reimbursements (reusing FinanceBalance.gs's FINANCE_OUTFLOW_SOURCES
 * so this stays in sync with whatever the balance engine considers a
 * paid outflow). A transaction is only auto-matched when EXACTLY ONE
 * unclaimed candidate matches its amount (within a cent) and date
 * (within BANK_MATCH_DATE_WINDOW_DAYS) — anything ambiguous is left
 * Unmatched for a human, matching this module's "never guess with
 * money" principle.
 */
function autoMatchBankTransactions(sessionToken, statementId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var statement = DB.getById(BANK_STATEMENTS_TABLE, statementId);
    if (!statement) throw new Error('Statement not found.');

    var transactions = DB.getAll(BANK_TRANSACTIONS_TABLE).filter(function (t) { return t.StatementID === statementId; });
    var claimed = alreadyMatchedKeys_();

    var inflowCandidates = DB.getAll(FUNDING_TABLE)
      .filter(function (f) { return f.AccountID === statement.AccountID && f.Status === 'Confirmed'; })
      .map(function (f) { return { table: FUNDING_TABLE, id: f.FundingID, amount: Number(f.Amount), date: f.DateReceived }; });

    var outflowCandidates = [];
    FINANCE_OUTFLOW_SOURCES.forEach(function (source) {
      DB.getAll(source.table).filter(function (r) { return r.AccountID === statement.AccountID && r.PaymentStatus === 'Paid'; })
        .forEach(function (r) {
          outflowCandidates.push({ table: source.table, id: r[outflowIdField_(source.table)], amount: outflowAmount_(source.table, r), date: r.PaymentDate });
        });
    });

    var matchedCount = 0;
    transactions.filter(function (t) { return t.MatchStatus === 'Unmatched'; }).forEach(function (t) {
      var pool = Number(t.Amount) >= 0 ? inflowCandidates : outflowCandidates;
      var targetAmount = Math.abs(Number(t.Amount));
      var txDate = parseDateOnly_(t.Date);
      if (!txDate) return;

      var candidates = pool.filter(function (c) {
        var key = c.table + ':' + c.id;
        if (claimed[key]) return false;
        if (Math.abs(c.amount - targetAmount) > BANK_MATCH_AMOUNT_TOLERANCE) return false;
        var candDate = parseDateOnly_(c.date);
        if (!candDate) return false;
        var diffDays = Math.abs(candDate.getTime() - txDate.getTime()) / 86400000;
        return diffDays <= BANK_MATCH_DATE_WINDOW_DAYS;
      });

      if (candidates.length === 1) {
        var match = candidates[0];
        DB.update(BANK_TRANSACTIONS_TABLE, t.BankTransactionID, { MatchedTable: match.table, MatchedRecordID: match.id, MatchStatus: 'Matched' });
        claimed[match.table + ':' + match.id] = true;
        matchedCount++;
      }
    });

    logAudit_(identity, 'AutoMatch', BANK_STATEMENTS_TABLE, statementId, 'MatchedCount', '', String(matchedCount), '');
    return { matched: matchedCount };
  });
}

/** Admin: unclaimed Paid/Confirmed records for manually matching one bank transaction — 'inflow' -> Funding, 'outflow' -> Invoices/Expenses/Salaries/Reimbursements. */
function getMatchCandidates(sessionToken, accountId, direction) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var claimed = alreadyMatchedKeys_();
    var results = [];

    if (direction === 'inflow') {
      DB.getAll(FUNDING_TABLE).filter(function (f) { return f.AccountID === accountId && f.Status === 'Confirmed'; })
        .forEach(function (f) {
          var key = FUNDING_TABLE + ':' + f.FundingID;
          if (claimed[key]) return;
          results.push({ table: FUNDING_TABLE, id: f.FundingID, label: f.FundingSource + ' — ' + f.DateReceived, amount: Number(f.Amount), date: f.DateReceived });
        });
    } else {
      FINANCE_OUTFLOW_SOURCES.forEach(function (source) {
        DB.getAll(source.table).filter(function (r) { return r.AccountID === accountId && r.PaymentStatus === 'Paid'; })
          .forEach(function (r) {
            var id = r[outflowIdField_(source.table)];
            var key = source.table + ':' + id;
            if (claimed[key]) return;
            var label = (r.PayeeName || r.SupplierName || r.StaffName || source.table) + ' — ' + (r.PaymentDate || '');
            results.push({ table: source.table, id: id, label: label, amount: outflowAmount_(source.table, r), date: r.PaymentDate });
          });
      });
    }
    return results;
  });
}

function manualMatchBankTransaction(sessionToken, bankTransactionId, table, recordId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var tx = DB.getById(BANK_TRANSACTIONS_TABLE, bankTransactionId);
    if (!tx) throw new Error('Bank transaction not found.');
    var validTables = ['Invoices', 'Expenses', 'Salaries', 'Reimbursements', FUNDING_TABLE];
    if (validTables.indexOf(table) === -1) throw new Error('Unrecognized record type.');
    var record = DB.getById(table, recordId);
    if (!record) throw new Error('That record was not found.');

    var updated = DB.update(BANK_TRANSACTIONS_TABLE, bankTransactionId, { MatchedTable: table, MatchedRecordID: recordId, MatchStatus: 'Matched' });
    logAudit_(identity, 'ManualMatch', BANK_TRANSACTIONS_TABLE, bankTransactionId, 'MatchedRecordID', '', table + ':' + recordId, '');
    return updated;
  });
}

function unmatchBankTransaction(sessionToken, bankTransactionId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var tx = DB.getById(BANK_TRANSACTIONS_TABLE, bankTransactionId);
    if (!tx) throw new Error('Bank transaction not found.');
    var updated = DB.update(BANK_TRANSACTIONS_TABLE, bankTransactionId, { MatchedTable: '', MatchedRecordID: '', MatchStatus: 'Unmatched' });
    logAudit_(identity, 'Unmatch', BANK_TRANSACTIONS_TABLE, bankTransactionId, 'MatchStatus', tx.MatchStatus, 'Unmatched', '');
    return updated;
  });
}

/** Marks a bank line as reviewed with no corresponding system record needed (e.g. a bank fee, interest, or an inter-account transfer). */
function ignoreBankTransaction(sessionToken, bankTransactionId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var tx = DB.getById(BANK_TRANSACTIONS_TABLE, bankTransactionId);
    if (!tx) throw new Error('Bank transaction not found.');
    var updated = DB.update(BANK_TRANSACTIONS_TABLE, bankTransactionId, { MatchStatus: 'Ignored' });
    logAudit_(identity, 'Ignore', BANK_TRANSACTIONS_TABLE, bankTransactionId, 'MatchStatus', tx.MatchStatus, 'Ignored', '');
    return updated;
  });
}

/** Admin: a non-persisted preview of system balance vs statement closing balance, so the difference can be seen before committing a Reconciliations record. */
function previewReconciliation(sessionToken, statementId) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var statement = DB.getById(BANK_STATEMENTS_TABLE, statementId);
    if (!statement) throw new Error('Statement not found.');
    var f = getAccountFinancials_(statement.AccountID);
    return {
      systemBalance: f.currentBankBalance,
      statementBalance: Number(statement.ClosingBalance),
      difference: f.currentBankBalance - Number(statement.ClosingBalance),
      currency: f.currency
    };
  });
}

function createReconciliation(sessionToken, statementId, notes) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var statement = DB.getById(BANK_STATEMENTS_TABLE, statementId);
    if (!statement) throw new Error('Statement not found.');
    var f = getAccountFinancials_(statement.AccountID);
    var difference = f.currentBankBalance - Number(statement.ClosingBalance);
    var status = Math.abs(difference) < BANK_MATCH_AMOUNT_TOLERANCE ? 'Resolved' : 'Open';

    var record = DB.insert(RECONCILIATIONS_TABLE, {
      AccountID: statement.AccountID,
      StatementID: statementId,
      StatementDate: statement.StatementDate,
      SystemBalance: f.currentBankBalance,
      StatementBalance: Number(statement.ClosingBalance),
      Difference: difference,
      Status: status,
      Notes: (notes || '').trim(),
      ReconciledByEmail: identity.email,
      ReconciledAt: new Date()
    });
    DB.update(BANK_STATEMENTS_TABLE, statementId, { Status: status === 'Resolved' ? 'Reconciled' : 'Uploaded' });
    logAudit_(identity, 'Create', RECONCILIATIONS_TABLE, record.ReconciliationID, 'Difference', '', String(difference), '');
    if (status === 'Open') {
      notify_({
        type: 'ReconciliationMismatch', severity: 'danger',
        message: 'Reconciliation for ' + statement.StatementDate + ' found a difference of ' + difference + ' ' + f.currency + ' — needs review.',
        targetRole: 'Admin', targetAccessLevels: FINANCE_ACCESS_LEVELS, relatedTable: BANK_STATEMENTS_TABLE, relatedRecordId: statementId
      });
    }
    return record;
  });
}

/** Admin manually marks an Open reconciliation resolved after investigating the difference — this never touches any account's actual balance, only records that the mismatch was looked into. */
function resolveReconciliation(sessionToken, id, notes) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(RECONCILIATIONS_TABLE, id);
    if (!existing) throw new Error('Reconciliation not found.');
    if (existing.Status === 'Resolved') throw new Error('This reconciliation is already resolved.');
    if (!notes || !notes.trim()) throw new Error('Notes explaining the resolution are required.');

    var record = DB.update(RECONCILIATIONS_TABLE, id, { Status: 'Resolved', Notes: (existing.Notes ? existing.Notes + ' | ' : '') + 'Resolved: ' + notes.trim() });
    DB.update(BANK_STATEMENTS_TABLE, existing.StatementID, { Status: 'Reconciled' });
    logAudit_(identity, 'Resolve', RECONCILIATIONS_TABLE, id, 'Status', 'Open', 'Resolved', '');
    return record;
  });
}

function getReconciliations(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};
    var accountsById = {};
    DB.getAll(FINANCIAL_ACCOUNTS_TABLE).forEach(function (a) { accountsById[a.AccountID] = a.AccountName; });
    var accountScope = resolveAdminAccountScope_(resolveAdminHubScope_(identity));
    var all = applyHubScope_(DB.getAll(RECONCILIATIONS_TABLE), accountScope, 'AccountID');
    all = applyHubScope_(all, resolveAdminAccountScope_(resolveCountryFilterScope_(options.countryId)), 'AccountID');
    if (options.statementId) all = all.filter(function (r) { return r.StatementID === options.statementId; });
    all = all.map(function (r) { return withField_(r, { AccountName: accountsById[r.AccountID] || r.AccountID }); });
    return paginateAndFilter(all, {
      sortBy: options.sortBy || 'ReconciledAt',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}
