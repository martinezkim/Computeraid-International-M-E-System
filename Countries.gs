/**
 * ============================================================
 * COUNTRIES.GS — Countries module (Module 1)
 * ============================================================
 * Exposes the functions called directly from the client via
 * google.script.run. Business logic and validation live here;
 * raw data access stays in Database.gs. Hubs.gs and Managers.gs
 * will follow this exact same shape.
 * ============================================================
 */

var COUNTRIES_TABLE = 'Countries';

/**
 * Returns a filtered, sorted, paginated list of countries.
 * Called from countries.html on load, search, sort, and page change.
 * @param {Object} options {search, sortBy, sortDir, page, pageSize}
 */
function getCountries(sessionToken, options) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(COUNTRIES_TABLE);
    var schema = SCHEMA[COUNTRIES_TABLE];

    return paginateAndFilter(all, {
      search: options && options.search,
      searchColumns: schema.searchableColumns,
      sortBy: (options && options.sortBy) || 'CountryName',
      sortDir: (options && options.sortDir) || 'asc',
      page: (options && options.page) || 1,
      pageSize: (options && options.pageSize) || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Returns every active country as {id, name} pairs, for populating
 * dropdowns in other modules (e.g. the Hubs "Add Hub" form).
 */
function getCountryOptions(sessionToken) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(COUNTRIES_TABLE);
    return all
      .filter(function (c) { return c.Status === 'Active'; })
      .map(function (c) { return { id: c.CountryID, name: c.CountryName }; });
  });
}

/** Creates a new country after validating input. */
function addCountry(sessionToken, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateCountryInput(data);
    if (error) throw new Error(error);

    return DB.insert(COUNTRIES_TABLE, {
      CountryName: data.CountryName.trim(),
      ISOCode: data.ISOCode.trim().toUpperCase(),
      Status: data.Status || 'Active'
    });
  });
}

/** Updates an existing country after validating input. */
function updateCountry(sessionToken, id, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateCountryInput(data);
    if (error) throw new Error(error);

    return DB.update(COUNTRIES_TABLE, id, {
      CountryName: data.CountryName.trim(),
      ISOCode: data.ISOCode.trim().toUpperCase(),
      Status: data.Status
    });
  });
}

/** Deletes a country, refusing if any Hub still references it. */
function deleteCountry(sessionToken, id) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    if (DB.hasDependents('Countries', id, 'Hubs', 'CountryID')) {
      throw new Error('Cannot delete this country: one or more Hubs are still assigned to it.');
    }
    DB.remove(COUNTRIES_TABLE, id);
    return true;
  });
}

/** Shared validation for add/edit. */
function validateCountryInput(data) {
  return Validate.run([
    [Validate.required, data && data.CountryName, 'Country name'],
    [Validate.maxLength, data && data.CountryName, 100, 'Country name'],
    [Validate.required, data && data.ISOCode, 'ISO code'],
    [Validate.exactLength, data && data.ISOCode, 2, 'ISO code'],
    [Validate.oneOf, data && data.Status, ['Active', 'Inactive'], 'Status']
  ]);
}
