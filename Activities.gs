/**
 * ============================================================
 * ACTIVITIES.GS — Admin-editable Activity list (Phase 15)
 * ============================================================
 * Same shape as VisitorTypes.gs. Every Hub Visit / Group Visit
 * tags one or more Activities (spec §13) via the VisitActivities
 * junction table defined in Visits.gs.
 * ============================================================
 */

var ACTIVITIES_TABLE = 'Activities';

function getActivities(sessionToken, options) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(ACTIVITIES_TABLE);
    var schema = SCHEMA[ACTIVITIES_TABLE];

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

/** Every active activity as {id, name, category} tuples, for form checklists. */
function getActivityOptions(sessionToken) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    var all = DB.getAll(ACTIVITIES_TABLE);
    return all
      .filter(function (a) { return a.Active === true || a.Active === 'true'; })
      .sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
      .map(function (a) { return { id: a.ActivityID, name: a.Name, category: a.Category }; });
  });
}

function addActivity(sessionToken, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateActivityInput(data);
    if (error) throw new Error(error);

    return DB.insert(ACTIVITIES_TABLE, {
      Name: data.Name.trim(),
      Category: (data.Category || '').trim(),
      Active: data.Active !== false,
      SortOrder: Number(data.SortOrder) || 0
    });
  });
}

function updateActivity(sessionToken, id, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateActivityInput(data);
    if (error) throw new Error(error);

    return DB.update(ACTIVITIES_TABLE, id, {
      Name: data.Name.trim(),
      Category: (data.Category || '').trim(),
      Active: !!data.Active,
      SortOrder: Number(data.SortOrder) || 0
    });
  });
}

function deleteActivity(sessionToken, id) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    if (DB.hasDependents('Activities', id, 'VisitActivities', 'ActivityID')) {
      throw new Error('Cannot delete this activity: it is already tagged on one or more visits. Mark it Inactive instead.');
    }
    DB.remove(ACTIVITIES_TABLE, id);
    return true;
  });
}

function validateActivityInput(data) {
  return Validate.run([
    [Validate.required, data && data.Name, 'Name'],
    [Validate.maxLength, data && data.Name, 100, 'Name'],
    [Validate.maxLength, data && data.Category, 50, 'Category']
  ]);
}
