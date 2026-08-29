/**
 * ============================================================
 * NOTIFICATIONS.GS — Finance event notifications (Finance Phase 2)
 * ============================================================
 * Two ways a notification reaches someone:
 *   - DIRECT: TargetEmail set — "your invoice was approved", seen
 *     only by that person.
 *   - BROADCAST: TargetEmail blank, TargetRole set (+ optionally
 *     TargetHubID) — "an invoice needs approval", seen by every
 *     Admin, or every Hub Manager at one specific hub.
 *
 * notify_() is the one place that creates a row; every workflow
 * function that should raise a notification (Invoices.gs,
 * Expenses.gs, Reimbursements.gs, Funding.gs, BankReconciliation.gs)
 * calls it inline, right after the state change it's reporting.
 * checkFinanceAlertsAndNotify() covers the other kind — conditions
 * that aren't tied to one workflow action (low balance, budget risk,
 * missing receipts) — and is meant to run off a time-driven trigger
 * the Admin sets up once in the Apps Script editor (Triggers → Add
 * Trigger → checkFinanceAlertsAndNotify → Time-driven → Day timer),
 * the same "one-time manual setup" pattern used elsewhere in this
 * project for OAuth/API enablement. It dedupes so it doesn't spam a
 * fresh notification every time it runs while a condition persists.
 * ============================================================
 */

var NOTIFICATIONS_TABLE = 'Notifications';
var NOTIFICATION_DEDUPE_HOURS = 24;

// Convenience shorthands for notify_()'s targetAccessLevels — a
// TargetRole:'Admin' broadcast that's specifically Finance or M&E/Usage
// business should stay out of the AccessLevel that has nothing to do
// with it (an M&E Lead doesn't need to know an invoice was submitted;
// an Accountant doesn't need to know a project report came in). Every
// AccessLevel not named here is CountryDirector/SuperAdmin-only by
// omission — see notificationVisibleTo_.
var FINANCE_ACCESS_LEVELS = ['SuperAdmin', 'CountryDirector', 'Accountant'];
var ME_ACCESS_LEVELS = ['SuperAdmin', 'CountryDirector', 'MELead'];

/** Internal: the one place a Notifications row gets created. */
function notify_(opts) {
  try {
    DB.insert(NOTIFICATIONS_TABLE, {
      Type: opts.type,
      Severity: opts.severity || 'info',
      Message: opts.message,
      TargetEmail: opts.targetEmail || '',
      TargetRole: opts.targetRole || '',
      TargetHubID: opts.targetHubId || '',
      RelatedTable: opts.relatedTable || '',
      RelatedRecordID: opts.relatedRecordId || '',
      ReadByEmails: '',
      TargetAccessLevels: Array.isArray(opts.targetAccessLevels) ? opts.targetAccessLevels.join(',') : '',
      // ISO string, not a raw Date — Database.gs's _rowToObject truncates
      // any Date-typed cell down to a bare 'yyyy-MM-dd' on read (fine for
      // calendar-date fields, wrong here: it silently drops the time of
      // day, which is exactly what the bell's relative-time display and
      // the 24h dedupe window below both depend on).
      CreatedAt: new Date().toISOString()
    });
  } catch (err) {
    // A notification failing to write should never break the workflow
    // action that triggered it (approving an invoice must still
    // succeed even if, say, the Notifications sheet is momentarily
    // locked) — log and move on rather than rethrow.
    Logger.log('notify_ failed: ' + err.message);
  }
}

/**
 * True if `identity` can see `row` — either addressed to them directly,
 * or a broadcast matching their role (and hub, if the broadcast is
 * hub-scoped). For an Admin-role broadcast that also names specific
 * AccessLevels (TargetAccessLevels), SuperAdmin/CountryDirector always
 * pass regardless (they see everything); any other AccessLevel must be
 * explicitly listed.
 */
function notificationVisibleTo_(row, identity) {
  if (row.TargetEmail) return row.TargetEmail === identity.email;
  if (row.TargetRole !== identity.role) return false;
  if (row.TargetHubID) return row.TargetHubID === identity.hubId;
  if (row.TargetAccessLevels && identity.role === 'Admin' &&
    identity.accessLevel !== 'SuperAdmin' && identity.accessLevel !== 'CountryDirector') {
    var allowed = String(row.TargetAccessLevels).split(',').map(function (s) { return s.trim(); });
    if (allowed.indexOf(identity.accessLevel) === -1) return false;
  }
  return true;
}

function isReadBy_(row, email) {
  var list = String(row.ReadByEmails || '').split(',').map(function (e) { return e.trim(); }).filter(Boolean);
  return list.indexOf(email) !== -1;
}

/** Every authenticated user: their visible notifications, newest first, each with an isRead flag computed for the caller. */
function getMyNotifications(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    options = options || {};

    var mine = DB.getAll(NOTIFICATIONS_TABLE)
      .filter(function (r) { return notificationVisibleTo_(r, identity); })
      .map(function (r) { return withField_(r, { isRead: isReadBy_(r, identity.email) }); })
      .sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });

    if (options.unreadOnly) mine = mine.filter(function (r) { return !r.isRead; });

    var limit = options.limit || 20;
    return { records: mine.slice(0, limit), unreadCount: mine.filter(function (r) { return !r.isRead; }).length };
  });
}

/** Lightweight poll target for the notification bell's badge — avoids sending the full list every time. */
function getUnreadNotificationCount(sessionToken) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var count = DB.getAll(NOTIFICATIONS_TABLE)
      .filter(function (r) { return notificationVisibleTo_(r, identity) && !isReadBy_(r, identity.email); })
      .length;
    return { count: count };
  });
}

function markNotificationRead(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var row = DB.getById(NOTIFICATIONS_TABLE, id);
    if (!row) throw new Error('Notification not found.');
    if (isReadBy_(row, identity.email)) return row;

    var list = String(row.ReadByEmails || '').split(',').map(function (e) { return e.trim(); }).filter(Boolean);
    list.push(identity.email);
    return DB.update(NOTIFICATIONS_TABLE, id, { ReadByEmails: list.join(',') });
  });
}

/** Marks every notification currently visible to the caller as read — the "Mark all read" action. */
function markAllNotificationsRead(sessionToken) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var mine = DB.getAll(NOTIFICATIONS_TABLE).filter(function (r) { return notificationVisibleTo_(r, identity) && !isReadBy_(r, identity.email); });
    mine.forEach(function (row) {
      var list = String(row.ReadByEmails || '').split(',').map(function (e) { return e.trim(); }).filter(Boolean);
      list.push(identity.email);
      DB.update(NOTIFICATIONS_TABLE, row.NotificationID, { ReadByEmails: list.join(',') });
    });
    return { updated: mine.length };
  });
}

/** True if a notification of this exact Type+RelatedRecordID was already created within the dedupe window — prevents the periodic alert check from spamming the same standing condition every run. */
function recentDuplicateNotificationExists_(type, relatedRecordId) {
  var cutoff = new Date(Date.now() - NOTIFICATION_DEDUPE_HOURS * 60 * 60 * 1000);
  return DB.getAll(NOTIFICATIONS_TABLE).some(function (r) {
    return r.Type === type && r.RelatedRecordID === relatedRecordId && new Date(r.CreatedAt) > cutoff;
  });
}

/**
 * Time-driven-trigger target (see file header) — checks conditions
 * that persist rather than firing once from a single workflow action:
 * low account balances, at-risk budget lines, and approved/paid
 * expenses or reimbursements still missing a receipt. Every
 * notification here is a broadcast to Admin, deduped per condition so
 * running this daily doesn't produce a new alert every single day a
 * condition remains true.
 */
function checkFinanceAlertsAndNotify() {
  var lowBalanceThreshold = Number(PropertiesService.getScriptProperties().getProperty('FINANCE_LOW_BALANCE_THRESHOLD')) || 0;
  var created = 0;

  if (lowBalanceThreshold > 0) {
    DB.getAll(FINANCIAL_ACCOUNTS_TABLE).filter(function (a) { return a.Status === 'Active'; }).forEach(function (a) {
      var f = getAccountFinancials_(a.AccountID);
      if (f.availableAfterCommitments < lowBalanceThreshold && !recentDuplicateNotificationExists_('LowBalance', a.AccountID)) {
        notify_({
          type: 'LowBalance', severity: 'danger',
          message: 'Available balance for ' + a.AccountName + ' is below the configured threshold (' + f.availableAfterCommitments + ' ' + f.currency + ').',
          targetRole: 'Admin', targetAccessLevels: FINANCE_ACCESS_LEVELS, relatedTable: 'FinancialAccounts', relatedRecordId: a.AccountID
        });
        created++;
      }
    });
  }

  DB.getAll(BUDGETS_TABLE).filter(function (b) { return b.Status === 'Active'; }).forEach(function (b) {
    DB.getAll(BUDGET_LINES_TABLE).filter(function (l) { return l.BudgetID === b.BudgetID; }).forEach(function (l) {
      var f = computeBudgetLineFinancials_(b, l);
      if (f.warningLevel && !recentDuplicateNotificationExists_('BudgetRisk', l.BudgetLineID)) {
        notify_({
          type: 'BudgetRisk', severity: f.warningLevel === 'exceeded' ? 'danger' : 'warning',
          message: b.Name + ' / ' + l.ExpenseCategory + ' has ' + (f.warningLevel === 'exceeded' ? 'exceeded its budget' : 'reached ' + Math.round(f.percentUsed * 100) + '% of its budget') + '.',
          targetRole: 'Admin', targetAccessLevels: FINANCE_ACCESS_LEVELS, relatedTable: 'BudgetLines', relatedRecordId: l.BudgetLineID
        });
        created++;
      }
    });
  });

  ['Expenses', 'Reimbursements'].forEach(function (table) {
    DB.getAll(table).filter(function (r) { return (r.Status === 'Approved' || r.PaymentStatus === 'Paid') && !r.ReceiptDocumentID; })
      .forEach(function (r) {
        var id = table === 'Expenses' ? r.ExpenseID : r.ReimbursementID;
        if (!recentDuplicateNotificationExists_('MissingReceipt', id)) {
          notify_({
            type: 'MissingReceipt', severity: 'warning',
            message: 'An approved ' + (table === 'Expenses' ? 'expense' : 'reimbursement') + ' (' + id + ') has no receipt attached.',
            targetRole: 'Admin', targetAccessLevels: FINANCE_ACCESS_LEVELS, relatedTable: table, relatedRecordId: id
          });
          created++;
        }
      });
  });

  Logger.log('checkFinanceAlertsAndNotify created ' + created + ' notification(s).');
  return created;
}

/**
 * ONE-TIME CLEANUP — run once from the Apps Script editor's Run
 * dropdown after deploying the AccessLevel-aware notification targeting
 * above. Every Admin-broadcast notification created BEFORE that change
 * has a blank TargetAccessLevels, so it's still visible to every
 * AccessLevel (the old, pre-Module-3 behavior) — this backfills the
 * correct scoping onto existing rows by their Type, same categorization
 * the live notify_() calls now use, so an M&E Lead or Accountant
 * doesn't keep seeing old Finance/Setup notifications that predate the
 * fix. Safe to run more than once — only touches rows that still have a
 * blank TargetAccessLevels.
 */
function backfillNotificationAccessLevels() {
  var typeToAccessLevels = {
    ManagerEmailChangeRequested: ['SuperAdmin', 'CountryDirector']
  };
  ['ReconciliationMismatch', 'ExpenseSubmitted', 'FundingRecorded', 'LowBalance', 'BudgetRisk', 'MissingReceipt', 'InvoiceSubmitted', 'ReimbursementSubmitted']
    .forEach(function (t) { typeToAccessLevels[t] = FINANCE_ACCESS_LEVELS; });
  ['ProjectSubmitted', 'LowFeedbackRating']
    .forEach(function (t) { typeToAccessLevels[t] = ME_ACCESS_LEVELS; });

  var updated = 0;
  DB.getAll(NOTIFICATIONS_TABLE).forEach(function (row) {
    if (row.TargetRole !== 'Admin' || row.TargetAccessLevels) return; // only untouched Admin broadcasts
    var levels = typeToAccessLevels[row.Type];
    if (!levels) return; // not a type we scope by AccessLevel — stays visible to every Admin, unchanged
    DB.update(NOTIFICATIONS_TABLE, row.NotificationID, { TargetAccessLevels: levels.join(',') });
    updated++;
  });

  Logger.log('backfillNotificationAccessLevels updated ' + updated + ' existing notification(s).');
  return updated;
}
