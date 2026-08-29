/**
 * ============================================================
 * HUBS.GS — Hubs module (Module 2)
 * ============================================================
 * Same shape as Countries.gs. The one addition is a `countryId`
 * filter on getHubs(), which powers the "Filter by Country"
 * dropdown on the Hubs dashboard (a Country has many Hubs).
 * ============================================================
 */

var HUBS_TABLE = 'Hubs';

/**
 * Returns a filtered, sorted, paginated list of hubs, with each
 * record's CountryName resolved for display (CountryID stays the
 * value stored in the sheet).
 * @param {Object} options {search, sortBy, sortDir, page, pageSize, countryId}
 */
function getHubs(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};
    var schema = SCHEMA[HUBS_TABLE];
    var all = DB.getAll(HUBS_TABLE);

    // A scoped CountryDirector never sees another country's hubs, full
    // stop — enforced here regardless of what (if anything) the client
    // requests, unlike the options.countryId filter below (a genuine
    // optional narrowing the caller opts into).
    var scopedCountryId = identity.accessLevel === 'CountryDirector' ? identity.countryId : '';
    if (scopedCountryId) {
      all = all.filter(function (h) { return h.CountryID === scopedCountryId; });
    }

    // Country filter is an exact match, applied before search/sort/pagination.
    if (options.countryId) {
      all = all.filter(function (h) { return h.CountryID === options.countryId; });
    }

    resolveForeignKey(all, 'CountryID', 'Countries', 'CountryName', 'CountryName');

    var result = paginateAndFilter(all, {
      search: options.search,
      searchColumns: schema.searchableColumns,
      sortBy: options.sortBy || 'HubName',
      sortDir: options.sortDir || 'asc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });

    return result;
  });
}

/**
 * Returns every active hub as {id, name} pairs, for populating
 * dropdowns in other modules (e.g. the Managers "Assign to Hub" form).
 */
function getHubOptions(sessionToken) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(HUBS_TABLE);
    return all
      .filter(function (h) { return h.Status === 'Active'; })
      .map(function (h) { return { id: h.HubID, name: h.HubName, countryId: h.CountryID || '' }; });
  });
}

/**
 * Deliberately unauthenticated sibling of getHubOptions() — a kiosk
 * requesting a device key (DeviceRequests.gs) has no credentials yet, so
 * it needs to list hubs to pick one BEFORE any session exists. Called
 * directly from Code.gs's doGet ?api=hubList branch, not through the RPC
 * bridge, and never allowlisted there — same {id, name} shape as
 * getHubOptions, just without the admin gate.
 */
function getHubOptionsPublic_() {
  return safeExecute(function () {
    var all = DB.getAll(HUBS_TABLE);
    return all
      .filter(function (h) { return h.Status === 'Active'; })
      .map(function (h) { return { id: h.HubID, name: h.HubName }; });
  });
}

/**
 * Returns a single hub's {id, name}. Used by the Hub Manager dashboard
 * to show which hub they're managing, without pulling the full list.
 */
function getHubById(sessionToken, hubId) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    var hub = DB.getById(HUBS_TABLE, hubId);
    if (!hub) throw new Error('Hub not found.');
    return { id: hub.HubID, name: hub.HubName };
  });
}

/** Creates a new hub after validating input (including the CountryID FK). */
function addHub(sessionToken, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateHubInput(data);
    if (error) throw new Error(error);

    return DB.insert(HUBS_TABLE, {
      HubName: data.HubName.trim(),
      CountryID: data.CountryID,
      CountyOrState: (data.CountyOrState || '').trim(),
      Town: (data.Town || '').trim(),
      Address: (data.Address || '').trim(),
      Status: data.Status || 'Active',
      EnabledOptionalTabs: normalizeEnabledTabs_(data.EnabledOptionalTabs)
    });
  });
}

/** Updates an existing hub after validating input. */
function updateHub(sessionToken, id, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateHubInput(data);
    if (error) throw new Error(error);

    return DB.update(HUBS_TABLE, id, {
      HubName: data.HubName.trim(),
      CountryID: data.CountryID,
      CountyOrState: (data.CountyOrState || '').trim(),
      Town: (data.Town || '').trim(),
      Address: (data.Address || '').trim(),
      Status: data.Status,
      EnabledOptionalTabs: normalizeEnabledTabs_(data.EnabledOptionalTabs)
    });
  });
}

/** Client sends an array of checked page keys — keep only ones that are actually optional pages, store as a comma-separated string. */
function normalizeEnabledTabs_(value) {
  var keys = Array.isArray(value) ? value : [];
  return keys.filter(function (k) { return MANAGER_OPTIONAL_PAGES.indexOf(k) !== -1; }).join(',');
}

/**
 * A Hub Manager's optional-page allowlist for their own hub — everything
 * in MANAGER_OPTIONAL_PAGES (Router.gs) NOT in this list stays greyed out
 * for them (see applyRoleVisibility in CommonJS.html and getPageContent
 * in Router.gs, the actual server-side enforcement point). Compulsory
 * pages are never affected by this.
 */
function getHubEnabledTabs_(hubId) {
  var hub = DB.getById(HUBS_TABLE, hubId);
  if (!hub || !hub.EnabledOptionalTabs) return [];
  return String(hub.EnabledOptionalTabs).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

/** Deletes a hub, refusing if any Hub Manager is still assigned to it. */
function deleteHub(sessionToken, id) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    if (DB.hasDependents('Hubs', id, 'HubManagers', 'HubID')) {
      throw new Error('Cannot delete this hub: one or more managers are still assigned to it.');
    }
    DB.remove(HUBS_TABLE, id);
    return true;
  });
}

/** Shared validation for add/edit. */
function validateHubInput(data) {
  return Validate.run([
    [Validate.required, data && data.HubName, 'Hub name'],
    [Validate.maxLength, data && data.HubName, 150, 'Hub name'],
    [Validate.required, data && data.CountryID, 'Country'],
    [Validate.exists, 'Countries', data && data.CountryID, 'Country'],
    [Validate.maxLength, data && data.CountyOrState, 100, 'County/State'],
    [Validate.maxLength, data && data.Town, 100, 'Town'],
    [Validate.maxLength, data && data.Address, 250, 'Address'],
    [Validate.oneOf, data && data.Status, ['Active', 'Inactive'], 'Status']
  ]);
}
