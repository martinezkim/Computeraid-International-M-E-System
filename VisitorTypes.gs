/**
 * ============================================================
 * VISITORTYPES.GS — Admin-editable Visitor Type list (Phase 15)
 * ============================================================
 * Same shape as Countries.gs. Reads are open to any page that
 * needs the list for a dropdown (e.g. the Hub Manager's Hub Visit
 * form); mutations require an Admin session — visitor types are a
 * classification list managers use, but only Admin curates it,
 * per the Phase 15 spec's permissions table.
 * ============================================================
 */

var VISITOR_TYPES_TABLE = 'VisitorTypes';

function getVisitorTypes(sessionToken, options) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(VISITOR_TYPES_TABLE);
    var schema = SCHEMA[VISITOR_TYPES_TABLE];

    return paginateAndFilter(all, {
      search: options && options.search,
      searchColumns: schema.searchableColumns,
      sortBy: (options && options.sortBy) || 'SortOrder',
      sortDir: (options && options.sortDir) || 'asc',
      page: (options && options.page) || 1,
      pageSize: (options && options.pageSize) || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Every active visitor type as {id, name} pairs, for form dropdowns. */
function getVisitorTypeOptions(sessionToken) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    var all = DB.getAll(VISITOR_TYPES_TABLE);
    return all
      .filter(function (v) { return v.Active === true || v.Active === 'true'; })
      .sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
      .map(function (v) { return { id: v.VisitorTypeID, name: v.Name }; });
  });
}

function addVisitorType(sessionToken, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateVisitorTypeInput(data);
    if (error) throw new Error(error);

    return DB.insert(VISITOR_TYPES_TABLE, {
      Name: data.Name.trim(),
      Active: data.Active !== false,
      SortOrder: Number(data.SortOrder) || 0
    });
  });
}

function updateVisitorType(sessionToken, id, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateVisitorTypeInput(data);
    if (error) throw new Error(error);

    return DB.update(VISITOR_TYPES_TABLE, id, {
      Name: data.Name.trim(),
      Active: !!data.Active,
      SortOrder: Number(data.SortOrder) || 0
    });
  });
}

function deleteVisitorType(sessionToken, id) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    DB.remove(VISITOR_TYPES_TABLE, id);
    return true;
  });
}

function validateVisitorTypeInput(data) {
  return Validate.run([
    [Validate.required, data && data.Name, 'Name'],
    [Validate.maxLength, data && data.Name, 100, 'Name']
  ]);
}
