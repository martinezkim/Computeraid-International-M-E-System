/**
 * ============================================================
 * QUOTAS.GS — Reporting Quotas module (Module 4)
 * ============================================================
 * A reporting quota is one quarter of one reporting year (e.g.
 * "Q1 2026"), set up by the admin. Hub Managers see these
 * as cards on their dashboard and file monthly project reports
 * against them (that form is the next step — see the Projects
 * placeholder schema in Config.gs).
 * ============================================================
 */

var QUOTAS_TABLE = 'ReportingQuotas';

/**
 * Fixed mapping of quarter to the 4 calendar months it covers — a
 * calendar-year fiscal structure (three 4-month quarters, not four
 * 3-month ones): Q1 = Jan–Apr, Q2 = May–Aug, Q3 = Sep–Dec. Every
 * quarter is fully contained within ONE calendar year (no rollover
 * into the next year the way a fiscal year starting mid-year would
 * need), so a quota's YearLabel is a single "YYYY" value, not a
 * "YYYY-YYYY" span.
 */
var QUARTER_MONTHS = {
  Q1: ['Jan', 'Feb', 'Mar', 'Apr'],
  Q2: ['May', 'Jun', 'Jul', 'Aug'],
  Q3: ['Sep', 'Oct', 'Nov', 'Dec']
};

var MONTH_INDEX_ = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** 'yyyy-MM-dd' string -> UTC Date at midnight that day (matches the fixed-derivation branch below's convention). */
function parseISODateUTC_(dateStr) {
  var parts = String(dateStr).split('-');
  return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
}

/**
 * Computes a quota's actual [start, end] date range as UTC dates. Used
 * both to constrain the date picker client-side and to validate
 * ProjectDate server-side in Projects.gs.
 *
 * Quotas created after flexible dates were added store QuarterStart/
 * QuarterEnd directly — those are used as-is, whatever range the admin
 * actually set. Any older quota row from before that (no stored dates)
 * falls back to the original fixed calendar-quarter derivation (Q1 =
 * Jan-Apr, Q2 = May-Aug, Q3 = Sep-Dec) so nothing historical breaks.
 * Reads the year via a loose "first 4-digit number" match rather than
 * requiring an exact "YYYY" string, so a quota saved under the even
 * older "YYYY-YYYY" fiscal-year format still resolves too.
 */
function getQuotaDateRange_(quota) {
  if (quota.QuarterStart && quota.QuarterEnd) {
    var flexStart = parseISODateUTC_(quota.QuarterStart);
    var flexEnd = parseISODateUTC_(quota.QuarterEnd);
    if (!isNaN(flexStart.getTime()) && !isNaN(flexEnd.getTime())) return { start: flexStart, end: flexEnd };
  }

  var months = QUARTER_MONTHS[quota.Quarter];
  var yearMatch = String(quota.YearLabel).match(/(\d{4})/);
  if (!months || !yearMatch) {
    throw new Error('This reporting quota has an invalid quarter/year and its date range cannot be computed.');
  }
  var year = Number(yearMatch[1]);

  var startMonthIndex = MONTH_INDEX_[months[0]];
  var endMonthIndex = MONTH_INDEX_[months[months.length - 1]];

  var start = new Date(Date.UTC(year, startMonthIndex, 1));
  var end = new Date(Date.UTC(year, endMonthIndex + 1, 0)); // day 0 of next month = last day of end month
  return { start: start, end: end };
}

/**
 * Public version of the above: returns a quota's valid date range as
 * plain 'yyyy-MM-dd' strings (for a date input's min/max) plus a
 * friendly label, e.g. "Aug 2025 – Oct 2025".
 */
function getQuotaDateRange(sessionToken, quotaId) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    var quota = DB.getById(QUOTAS_TABLE, quotaId);
    if (!quota) throw new Error('Reporting quota not found.');

    var range = getQuotaDateRange_(quota);
    return {
      start: Utilities.formatDate(range.start, 'UTC', 'yyyy-MM-dd'),
      end: Utilities.formatDate(range.end, 'UTC', 'yyyy-MM-dd')
    };
  });
}

/** "Nov 2026 – Jan 2027" — the month-level display for a quota's computed range. */
function formatQuotaDateRangeLabel_(range) {
  return Utilities.formatDate(range.start, 'UTC', 'MMM yyyy') + ' – ' + Utilities.formatDate(range.end, 'UTC', 'MMM yyyy');
}

/**
 * Lets the Admin see which months a Quarter + Reporting Year combo
 * covers BEFORE saving — used by the Add/Edit Reporting Quota modal so
 * the fixed Quarter→month mapping (QUARTER_MONTHS above) doesn't stay
 * invisible/implicit to whoever is setting these up. Accepts the same
 * raw values the form collects, not a saved quota record.
 */
function previewQuotaDateRange(sessionToken, quarter, yearLabel) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    if (!quarter || !QUARTER_MONTHS[quarter]) {
      throw new Error('Select a quarter to see its month range.');
    }
    var match = String(yearLabel || '').trim().match(/^\d{4}$/);
    if (!match) {
      throw new Error('Enter a reporting year (YYYY) to see the month range.');
    }
    var range = getQuotaDateRange_({ Quarter: quarter, YearLabel: match[0] });
    return {
      label: formatQuotaDateRangeLabel_(range),
      start: Utilities.formatDate(range.start, 'UTC', 'yyyy-MM-dd'),
      end: Utilities.formatDate(range.end, 'UTC', 'yyyy-MM-dd')
    };
  });
}

/**
 * Returns a filtered, sorted, paginated list of reporting quotas, each
 * with a `.ProjectCount` attached (how many projects have been filed
 * against it, across every hub) — shown on the admin's quota cards.
 * @param {Object} options {search, sortBy, sortDir, page, pageSize}
 */
function getQuotas(sessionToken, options) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    options = options || {};
    var schema = SCHEMA[QUOTAS_TABLE];
    var all = DB.getAll(QUOTAS_TABLE);

    var projectCounts = {};
    DB.getAll('Projects').forEach(function (p) {
      projectCounts[p.QuotaID] = (projectCounts[p.QuotaID] || 0) + 1;
    });
    all.forEach(function (q) {
      q.ProjectCount = projectCounts[q.QuotaID] || 0;
      try {
        q.DateRangeLabel = formatQuotaDateRangeLabel_(getQuotaDateRange_(q));
      } catch (err) {
        q.DateRangeLabel = ''; // malformed legacy YearLabel, if any — don't break the whole list over one bad row
      }
    });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: schema.searchableColumns,
      sortBy: options.sortBy || 'YearLabel',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Returns every active quota as {id, label} pairs (e.g. "Q1 2026"),
 * used both by the admin's dropdowns and the Hub Manager's dashboard cards.
 */
function getQuotaOptions(sessionToken) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    var all = DB.getAll(QUOTAS_TABLE);
    return all
      .filter(function (q) { return q.Status === 'Active'; })
      .map(function (q) { return { id: q.QuotaID, quarter: q.Quarter, yearLabel: q.YearLabel, label: quotaLabel_(q) }; })
      .sort(function (a, b) { return a.label.localeCompare(b.label); });
  });
}

/**
 * Distinct Project Year labels across every quota (newest first), for
 * the year-selector on the Beneficiaries registration-bands breakdown
 * and anywhere else "which project year" needs picking. Skips quotas
 * from before ProjectYear existed (empty string).
 */
function getProjectYearOptions(sessionToken) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    var years = {};
    DB.getAll(QUOTAS_TABLE).forEach(function (q) {
      if (q.ProjectYear) years[q.ProjectYear] = true;
    });
    return Object.keys(years).sort().reverse();
  });
}

/** Creates a new reporting quota after validating input. */
function addQuota(sessionToken, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateQuotaInput(data, null);
    if (error) throw new Error(error);

    var saved = DB.insert(QUOTAS_TABLE, {
      Quarter: data.Quarter,
      YearLabel: String(data.YearLabel).trim(),
      Status: data.Status || 'Active',
      ProjectYear: String(data.ProjectYear).trim(),
      QuarterStart: data.QuarterStart,
      QuarterEnd: data.QuarterEnd
    });
    if (saved.Status === 'Active') {
      notify_({
        type: 'QuotaOpened', severity: 'info',
        message: 'New reporting quota ' + quotaLabel_(saved) + ' is now open for filing.',
        targetRole: 'HubManager', relatedTable: QUOTAS_TABLE, relatedRecordId: saved.QuotaID
      });
    }
    return saved;
  });
}

/** Updates an existing reporting quota after validating input. */
function updateQuota(sessionToken, id, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateQuotaInput(data, id);
    if (error) throw new Error(error);

    return DB.update(QUOTAS_TABLE, id, {
      Quarter: data.Quarter,
      YearLabel: String(data.YearLabel).trim(),
      Status: data.Status,
      ProjectYear: String(data.ProjectYear).trim(),
      QuarterStart: data.QuarterStart,
      QuarterEnd: data.QuarterEnd
    });
  });
}

/** Deletes a reporting quota, refusing if any project has already been filed against it. */
function deleteQuota(sessionToken, id) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    if (DB.hasDependents('ReportingQuotas', id, 'Projects', 'QuotaID')) {
      throw new Error('Cannot delete this reporting quota: projects have already been submitted against it.');
    }
    DB.remove(QUOTAS_TABLE, id);
    return true;
  });
}

/** Computes the "Q1 2026" display label from a quota's raw fields. */
function quotaLabel_(quota) {
  return quota.Quarter + ' ' + quota.YearLabel;
}

/**
 * Validates quarter/year/status, and blocks duplicate quarter+year combos
 * (e.g. two separate "Q1 2026" entries). `excludeId` lets updateQuota
 * skip the record being edited when checking for duplicates.
 */
function validateQuotaInput(data, excludeId) {
  var error = Validate.run([
    [Validate.required, data && data.Quarter, 'Quarter'],
    [Validate.oneOf, data && data.Quarter, ['Q1', 'Q2', 'Q3'], 'Quarter'],
    [Validate.required, data && data.YearLabel, 'Reporting year'],
    [Validate.required, data && data.ProjectYear, 'Project year'],
    [Validate.required, data && data.QuarterStart, 'Quarter start date'],
    [Validate.required, data && data.QuarterEnd, 'Quarter end date'],
    [Validate.oneOf, data && data.Status, ['Active', 'Inactive'], 'Status']
  ]);
  if (error) return error;

  var yearLabel = String(data.YearLabel).trim();
  if (!/^\d{4}$/.test(yearLabel)) {
    return 'Reporting year must be a 4-digit year, e.g. 2026.';
  }

  if (new Date(data.QuarterEnd) <= new Date(data.QuarterStart)) {
    return 'Quarter end date must be after the start date.';
  }

  var duplicate = DB.getAll(QUOTAS_TABLE).some(function (q) {
    var sameCombo = q.Quarter === data.Quarter && q.YearLabel === yearLabel;
    var isSelf = excludeId && q.QuotaID === excludeId;
    return sameCombo && !isSelf;
  });
  if (duplicate) {
    return 'A reporting quota for ' + data.Quarter + ' ' + yearLabel + ' already exists.';
  }

  return null;
}
