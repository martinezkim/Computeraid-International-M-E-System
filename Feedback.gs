/**
 * ============================================================
 * FEEDBACK.GS — Beneficiary feedback (Phase 16+)
 * ============================================================
 * Captured almost entirely from the PWA kiosk before a beneficiary
 * leaves. Admin-readable via getAllFeedback(); actual creation
 * happens through Sync.gs's syncFeedback_ (offline) — no online web
 * capture path exists yet since this was built PWA-first.
 * ============================================================
 */

var FEEDBACK_TABLE = 'Feedback';

/** Admin: every feedback entry, optionally filtered to one Hub, newest first by default. */
function getAllFeedback(sessionToken, options) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var beneficiariesById = {};
    DB.getAll('Beneficiaries').forEach(function (b) { beneficiariesById[b.BeneficiaryID] = b; });

    var all = DB.getAll(FEEDBACK_TABLE);
    if (options.hubId) all = all.filter(function (f) { return f.HubID === options.hubId; });

    all = all.map(function (f) {
      var b = beneficiariesById[f.BeneficiaryID];
      return withField_(f, {
        HubName: hubNames[f.HubID] || f.HubID,
        BeneficiaryName: b ? (b.FirstName + ' ' + (b.SurnameInitial || '') + '.') : '(anonymous)'
      });
    });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[FEEDBACK_TABLE].searchableColumns,
      sortBy: options.sortBy || 'DateCreated',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Hub Manager: feedback left at their own Hub only, newest first by default. */
function getMyHubFeedback(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};

    var beneficiariesById = {};
    DB.getAll('Beneficiaries').forEach(function (b) { beneficiariesById[b.BeneficiaryID] = b; });

    var mine = DB.getAll(FEEDBACK_TABLE).filter(function (f) { return f.HubID === manager.hubId; });
    mine = mine.map(function (f) {
      var b = beneficiariesById[f.BeneficiaryID];
      return withField_(f, {
        BeneficiaryName: b ? (b.FirstName + ' ' + (b.SurnameInitial || '') + '.') : '(anonymous)'
      });
    });

    return paginateAndFilter(mine, {
      search: options.search,
      searchColumns: SCHEMA[FEEDBACK_TABLE].searchableColumns,
      sortBy: options.sortBy || 'DateCreated',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}
