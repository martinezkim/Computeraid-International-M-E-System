/**
 * ============================================================
 * FINANCESTAFF.GS — Lightweight project-staff master (Phase 17)
 * ============================================================
 * NOT a login account — this is who Salaries and Reimbursements
 * pay, not who signs into the system. Most paid project staff are
 * not Admins/HubManagers. Admin manages the master list; both roles
 * can fetch the option list to populate a staff picker on
 * expense/reimbursement forms, scoped to the caller's own hub for
 * a Hub Manager (same scoping shape as everywhere else in the app).
 * ============================================================
 */

var FINANCE_STAFF_TABLE = 'FinanceStaff';
var FINANCE_STAFF_STATUSES = ['Active', 'Inactive'];

/** Admin: every staff record, org-wide, with HubName joined. */
function getFinanceStaff(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var all = applyHubScope_(DB.getAll(FINANCE_STAFF_TABLE), resolveAdminHubScope_(identity), 'HubID').map(function (s) {
      return withField_(s, { HubName: hubNames[s.HubID] || s.HubID });
    });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[FINANCE_STAFF_TABLE].searchableColumns,
      sortBy: options.sortBy || 'FullName',
      sortDir: options.sortDir || 'asc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Any authenticated user: active staff as {id, name, hubId} tuples for
 * a picker. Admin gets every hub; a Hub Manager gets only their own
 * hub's staff (matches the hub-scoping every other manager endpoint
 * uses).
 */
function getFinanceStaffOptions(sessionToken) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var all = DB.getAll(FINANCE_STAFF_TABLE).filter(function (s) { return s.Status === 'Active'; });
    if (identity.role === 'HubManager') {
      all = all.filter(function (s) { return s.HubID === identity.hubId; });
    }
    return all
      .sort(function (a, b) { return String(a.FullName).localeCompare(String(b.FullName)); })
      .map(function (s) { return { id: s.StaffID, name: s.FullName, hubId: s.HubID }; });
  });
}

function addFinanceStaff(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var error = validateFinanceStaffInput(data);
    if (error) throw new Error(error);

    var record = DB.insert(FINANCE_STAFF_TABLE, {
      FullName: data.FullName.trim(),
      StaffNumber: (data.StaffNumber || '').trim(),
      RoleTitle: (data.RoleTitle || '').trim(),
      HubID: data.HubID,
      Email: (data.Email || '').trim(),
      Status: data.Status || 'Active'
    });
    logAudit_(identity, 'Create', FINANCE_STAFF_TABLE, record.StaffID, '(record)', '', record.FullName, record.HubID);
    return record;
  });
}

function updateFinanceStaff(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var error = validateFinanceStaffInput(data);
    if (error) throw new Error(error);

    var record = DB.update(FINANCE_STAFF_TABLE, id, {
      FullName: data.FullName.trim(),
      StaffNumber: (data.StaffNumber || '').trim(),
      RoleTitle: (data.RoleTitle || '').trim(),
      HubID: data.HubID,
      Email: (data.Email || '').trim(),
      Status: data.Status || 'Active'
    });
    logAudit_(identity, 'Update', FINANCE_STAFF_TABLE, id, '(record)', '', record.FullName, record.HubID);
    return record;
  });
}

function deleteFinanceStaff(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var inUse = DB.hasDependents(FINANCE_STAFF_TABLE, id, 'Salaries', 'StaffID')
      || DB.hasDependents(FINANCE_STAFF_TABLE, id, 'Reimbursements', 'StaffID')
      || DB.hasDependents(FINANCE_STAFF_TABLE, id, 'Expenses', 'StaffID');
    if (inUse) {
      throw new Error('Cannot delete this staff member: they already have salary, expense, or reimbursement records. Mark them Inactive instead.');
    }
    var existing = DB.getById(FINANCE_STAFF_TABLE, id);
    DB.remove(FINANCE_STAFF_TABLE, id);
    logAudit_(identity, 'Delete', FINANCE_STAFF_TABLE, id, '(record)', existing ? existing.FullName : '', '', existing ? existing.HubID : '');
    return true;
  });
}

function validateFinanceStaffInput(data) {
  return Validate.run([
    [Validate.required, data && data.FullName, 'Full name'],
    [Validate.maxLength, data && data.FullName, 100, 'Full name'],
    [Validate.required, data && data.HubID, 'Hub'],
    [Validate.exists, 'Hubs', data && data.HubID, 'Hub'],
    [Validate.isEmail, data && data.Email, 'Email'],
    [Validate.oneOf, data && data.Status, FINANCE_STAFF_STATUSES, 'Status']
  ]);
}
