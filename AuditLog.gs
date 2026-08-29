/**
 * ============================================================
 * AUDITLOG.GS — Shared change-history log
 * ============================================================
 * logAudit_() is a fire-and-forget helper any module can call
 * after a mutation to record who changed what. It never throws —
 * a logging failure should never block the actual mutation that
 * triggered it — and it's deliberately generic (table/record/field/
 * old/new) so it works for any module, not just Inventory/Laptops.
 *
 * Currently wired into Inventory.gs and Laptops.gs (add/update/
 * delete). Extending it to other modules later is just a matter of
 * calling logAudit_() at their mutation points too.
 * ============================================================
 */

var AUDIT_TABLE = 'AuditLog';

/**
 * Records one changed field. Call once per field that actually
 * changed (see diffForAudit_ below), not once per save — a Save
 * that changed 3 fields produces 3 audit rows, so "what changed"
 * is precise rather than a full before/after blob to eyeball.
 *
 * @param {Object} actor - { email, role } of whoever made the change
 * @param {string} action - 'Create' | 'Update' | 'Delete'
 * @param {string} tableName - e.g. 'Inventory', 'Laptops'
 * @param {string} recordId
 * @param {string} fieldName - '(record)' for Create/Delete as a whole
 * @param {*} oldValue
 * @param {*} newValue
 * @param {string} [hubId]
 */
function logAudit_(actor, action, tableName, recordId, fieldName, oldValue, newValue, hubId) {
  try {
    DB.insert(AUDIT_TABLE, {
      Timestamp: new Date(),
      ActorEmail: (actor && actor.email) || 'unknown',
      ActorRole: (actor && actor.role) || 'unknown',
      Action: action,
      TableName: tableName,
      RecordID: recordId,
      FieldName: fieldName,
      OldValue: oldValue === undefined || oldValue === null ? '' : String(oldValue),
      NewValue: newValue === undefined || newValue === null ? '' : String(newValue),
      HubID: hubId || ''
    });
  } catch (err) {
    // Never let audit logging break the actual operation.
  }
}

/**
 * Compares an old and new record field-by-field and logs one audit
 * row per field that actually changed. Skips DateModified/DateCreated
 * (housekeeping, not a meaningful change) and no-op "changes" where
 * the value is the same after normalizing to a string.
 */
function logAuditDiff_(actor, tableName, recordId, oldRecord, newRecord, hubId) {
  var skip = { DateModified: true, DateCreated: true };
  Object.keys(newRecord || {}).forEach(function (field) {
    if (skip[field]) return;
    var oldVal = oldRecord ? oldRecord[field] : undefined;
    var newVal = newRecord[field];
    var oldStr = oldVal === undefined || oldVal === null ? '' : String(oldVal);
    var newStr = newVal === undefined || newVal === null ? '' : String(newVal);
    if (oldStr === newStr) return;
    logAudit_(actor, 'Update', tableName, recordId, field, oldVal, newVal, hubId);
  });
}

/**
 * Admin-only audit log viewer, filterable by table/action/search,
 * newest first, paginated like every other list in the app.
 */
function getAuditLog(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var all = applyHubScope_(DB.getAll(AUDIT_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');
    if (options.tableName) all = all.filter(function (r) { return r.TableName === options.tableName; });
    if (options.action) all = all.filter(function (r) { return r.Action === options.action; });
    if (options.hubId) all = all.filter(function (r) { return r.HubID === options.hubId; });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[AUDIT_TABLE].searchableColumns,
      sortBy: options.sortBy || 'Timestamp',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}
