/**
 * ============================================================
 * AGEBANDS.GS — Admin-editable Age Band list (Phase 15)
 * ============================================================
 * Same shape as VisitorTypes.gs. MinAge/MaxAge define the band's
 * range (MaxAge blank means "and above", e.g. 65+); IsYouth flags
 * which band(s) count toward the Youth Participation % KPI (spec
 * §25 KPI 8) — config-driven so "youth" can be redefined without
 * a code change.
 * ============================================================
 */

var AGE_BANDS_TABLE = 'AgeBands';

function getAgeBands(sessionToken, options) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(AGE_BANDS_TABLE);
    var schema = SCHEMA[AGE_BANDS_TABLE];

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

/** Every active age band as {id, name} pairs, for form dropdowns. */
function getAgeBandOptions() {
  return safeExecute(function () {
    var all = DB.getAll(AGE_BANDS_TABLE);
    return all
      .filter(function (a) { return a.Active === true || a.Active === 'true'; })
      .sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
      .map(function (a) { return { id: a.AgeBandID, name: a.Label, isYouth: a.IsYouth === true || a.IsYouth === 'true' }; });
  });
}

function addAgeBand(sessionToken, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateAgeBandInput(data);
    if (error) throw new Error(error);

    return DB.insert(AGE_BANDS_TABLE, {
      Label: data.Label.trim(),
      MinAge: Number(data.MinAge) || 0,
      MaxAge: (data.MaxAge === '' || data.MaxAge === undefined || data.MaxAge === null) ? '' : Number(data.MaxAge),
      IsYouth: !!data.IsYouth,
      Active: data.Active !== false,
      SortOrder: Number(data.SortOrder) || 0
    });
  });
}

function updateAgeBand(sessionToken, id, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateAgeBandInput(data);
    if (error) throw new Error(error);

    return DB.update(AGE_BANDS_TABLE, id, {
      Label: data.Label.trim(),
      MinAge: Number(data.MinAge) || 0,
      MaxAge: (data.MaxAge === '' || data.MaxAge === undefined || data.MaxAge === null) ? '' : Number(data.MaxAge),
      IsYouth: !!data.IsYouth,
      Active: !!data.Active,
      SortOrder: Number(data.SortOrder) || 0
    });
  });
}

function deleteAgeBand(sessionToken, id) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    DB.remove(AGE_BANDS_TABLE, id);
    return true;
  });
}

/**
 * Maps an exact age to its configured band Label (e.g. 27 -> "18-29"),
 * so registration forms can collect a real age while every existing
 * band-based report/KPI keeps reading AgeGroup unchanged. Falls back to
 * the age itself (as a string) if no band covers it, so a beneficiary
 * is never left with a blank AgeGroup just because the Admin hasn't
 * configured a band wide enough to include them yet.
 */
function mapAgeToBand_(age) {
  age = Number(age);
  if (isNaN(age)) return '';
  var bands = DB.getAll(AGE_BANDS_TABLE).filter(function (a) { return a.Active === true || a.Active === 'true'; });
  for (var i = 0; i < bands.length; i++) {
    var b = bands[i];
    var min = Number(b.MinAge) || 0;
    var max = (b.MaxAge === '' || b.MaxAge === undefined || b.MaxAge === null) ? Infinity : Number(b.MaxAge);
    if (age >= min && age <= max) return b.Label;
  }
  return String(age);
}

function validateAgeBandInput(data) {
  var errors = Validate.run([
    [Validate.required, data && data.Label, 'Label'],
    [Validate.maxLength, data && data.Label, 50, 'Label'],
    [Validate.wholeNumber, data && data.MinAge, 'Minimum age']
  ]);
  if (errors) return errors;

  if (data && data.MaxAge !== '' && data.MaxAge !== undefined && data.MaxAge !== null) {
    var maxErr = Validate.wholeNumber(data.MaxAge, 'Maximum age');
    if (maxErr) return maxErr;
    if (Number(data.MaxAge) < Number(data.MinAge)) {
      return 'Maximum age must be greater than or equal to minimum age.';
    }
  }
  return null;
}
