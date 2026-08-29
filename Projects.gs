/**
 * ============================================================
 * PROJECTS.GS — Projects module (Module 5)
 * ============================================================
 * A project is a named activity a Hub Manager runs, toggled Active so
 * beneficiaries can tap to join it from the PWA kiosk (see
 * syncProjectJoin_ in Sync.gs) — merged in from what used to be a
 * separate "Group Sessions" feature under Hub Usage. Beneficiary
 * count, Female count, and the age-band breakdown are computed live
 * from who actually joined (see getProjectStats_ below), not
 * hand-entered. ProjectDate/QuotaID are stamped automatically at first
 * activation, not picked by the Hub Manager.
 *
 * Status has two eras: 'Active'/'Inactive' for anything created after
 * this shipped (toggleable, live-computed stats), and the legacy
 * constant 'Submitted' for every project filed under the old 6-field
 * manual-entry wizard before it — those rows are frozen forever with
 * whatever TotalNewBeneficiaries/Female/age-band values were originally
 * typed in, never toggled, never recomputed.
 *
 * Unlike most other writes in this app, HubID is deliberately NOT
 * something the client gets to supply for addProject() — it's resolved
 * server-side from the caller's own session (requireManagerSession_
 * below), so a Hub Manager can only ever file a project against their
 * own hub. getAllProjects() (the admin view) is likewise guarded by
 * requireAdminSession_.
 * ============================================================
 */

var PROJECTS_TABLE = 'Projects';

var AGE_BAND_FIELDS = [
  'Age0to5', 'Age6to10', 'Age11to13', 'Age14to18', 'Age19to23',
  'Age24to28', 'Age29to32', 'Age33to36', 'Age37to64', 'Age65Plus'
];

var AGE_BAND_LABELS = {
  Age0to5: '0-5', Age6to10: '6-10', Age11to13: '11-13', Age14to18: '14-18', Age19to23: '19-23',
  Age24to28: '24-28', Age29to32: '29-32', Age33to36: '33-36', Age37to64: '37-64', Age65Plus: '65+'
};

/**
 * Every project as {id, name, hubId} tuples, for a simple picker —
 * same shape/no-auth convention as getHubOptions() in Hubs.gs. Added
 * for the Finance module (Phase 17), which links accounts, invoices,
 * expenses etc. to a Project.
 */
function getProjectOptions(sessionToken) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    return DB.getAll(PROJECTS_TABLE).map(function (p) {
      return { id: p.ProjectID, name: p.ProjectName, hubId: p.HubID };
    });
  });
}

/**
 * Returns every project filed by the calling Hub Manager's own hub —
 * their "My Projects" list. Filterable by quota, with the usual
 * search/sort/pagination.
 * @param {string} sessionToken
 * @param {Object} options {search, sortBy, sortDir, page, pageSize, quotaId}
 */
function getMyProjects(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};

    var all = DB.getAll(PROJECTS_TABLE).filter(function (p) { return p.HubID === manager.hubId; });

    if (options.quotaId) {
      all = all.filter(function (p) { return p.QuotaID === options.quotaId; });
    }

    attachQuotaLabels_(all);
    attachProjectStats_(all);

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: ['ProjectName', 'QuotaLabel'],
      sortBy: options.sortBy || 'ProjectDate',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Powers the Hub Manager's 3-card dashboard: total beneficiaries, total
 * projects, and total money spent — all scoped to their own hub and to
 * the current reporting year (same "most recent year with data" logic
 * as the admin dashboard's getCurrentReportingYearLabel_() in
 * Dashboard.gs, so both views agree on what "current" means).
 */
function getMyDashboardStats(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);

    var quotas = DB.getAll('ReportingQuotas');
    var currentYearLabel = getCurrentReportingYearLabel_(quotas);
    var yearQuotaIds = quotas
      .filter(function (q) { return q.YearLabel === currentYearLabel; })
      .map(function (q) { return q.QuotaID; });

    var myYearProjects = DB.getAll(PROJECTS_TABLE).filter(function (p) {
      return p.HubID === manager.hubId && yearQuotaIds.indexOf(p.QuotaID) !== -1;
    });

    // Active Users — a lifetime, deduped count of anyone who has ever
    // actually visited this hub (see computeActiveBeneficiariesCount_ in
    // Dashboard.gs), not merely registered.
    var totalBeneficiaries = computeActiveBeneficiariesCount_(manager.hubId);
    var totalCost = myYearProjects.reduce(function (sum, p) {
      return sum + (Number(p.Cost) || 0);
    }, 0);

    return {
      currentYearLabel: currentYearLabel,
      totalProjects: myYearProjects.length,
      totalBeneficiaries: totalBeneficiaries,
      totalCost: totalCost
    };
  });
}

/**
 * ADMIN VIEW: every submitted project across every hub, with Hub name
 * and Quota label resolved for display. Filterable by hub and/or quota,
 * with the usual search/sort/pagination.
 * @param {string} sessionToken
 * @param {Object} options {search, sortBy, sortDir, page, pageSize, hubId, quotaId}
 */
function getAllProjects(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var all = DB.getAll(PROJECTS_TABLE);
    all = applyHubScope_(all, resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');

    if (options.hubId) {
      all = all.filter(function (p) { return p.HubID === options.hubId; });
    }
    if (options.quotaId) {
      all = all.filter(function (p) { return p.QuotaID === options.quotaId; });
    }

    resolveForeignKey(all, 'HubID', 'Hubs', 'HubName', 'HubName');
    attachQuotaLabels_(all);
    attachProjectStats_(all);

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: ['ProjectName', 'HubName', 'QuotaLabel'],
      sortBy: options.sortBy || 'ProjectDate',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Files a new project for the calling Hub Manager's own hub — just a
 * name and a Cost. Everything else (QuotaID, ProjectDate, beneficiary
 * counts) is resolved later, automatically, the moment the project is
 * first toggled Active (see setProjectStatus below). Starts Inactive:
 * a project isn't joinable on the PWA until a Hub Manager turns it on.
 */
function addProject(sessionToken, data) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);

    var error = validateNewProjectInput(data);
    if (error) throw new Error(error);

    var saved = DB.insert(PROJECTS_TABLE, {
      HubID: manager.hubId,
      ProjectName: String(data.ProjectName).trim(),
      Cost: Number(data.Cost),
      Status: 'Inactive'
    });
    var hubName = hubNameLookup_()[manager.hubId] || manager.hubId;
    notify_({
      type: 'ProjectSubmitted', severity: 'info',
      message: 'New project "' + saved.ProjectName + '" added by ' + hubName + '.',
      targetRole: 'Admin', targetAccessLevels: ME_ACCESS_LEVELS, relatedTable: PROJECTS_TABLE, relatedRecordId: saved.ProjectID
    });
    return saved;
  });
}

/** Just a name and a non-negative Cost — everything else about a new project is resolved at activation time. */
function validateNewProjectInput(data) {
  return Validate.run([
    [Validate.required, data && data.ProjectName, 'Project name'],
    [Validate.maxLength, data && data.ProjectName, 150, 'Project name'],
    [Validate.required, data && data.Cost, 'Cost'],
    [Validate.nonNegativeNumber, data && data.Cost, 'Cost']
  ]);
}

/**
 * Toggles a project Active/Inactive. Own-hub-only, and refuses to
 * touch a legacy 'Submitted' project (those are frozen historical
 * reports from before this toggle existed, never meant to be flipped).
 *
 * First-ever activation (ProjectDate still blank) stamps ProjectDate to
 * today and resolves QuotaID via findQuotaForDate_ — both then stay
 * pinned through every later activation. Every deactivation refreshes
 * ProjectEndDate to today; every re-activation clears it back to blank,
 * so the shown range never shows a stale end date while the project is
 * actually running again. No visit rows are touched either way — a
 * join is a one-shot record (see syncProjectJoin_ in Sync.gs), not an
 * open/close pair, so there's nothing left "open" to bulk-close.
 */
function setProjectStatus(sessionToken, projectId, status) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    if (status !== 'Active' && status !== 'Inactive') {
      throw new Error('Status must be Active or Inactive.');
    }

    var project = DB.getById(PROJECTS_TABLE, projectId);
    if (!project) throw new Error('Project not found.');
    if (project.HubID !== manager.hubId) throw new Error('Project not found.');
    if (project.Status === 'Submitted') {
      throw new Error('This is a legacy filed report and cannot be toggled.');
    }

    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var patch = { Status: status };

    if (status === 'Active') {
      if (!project.ProjectDate) {
        var quota = findQuotaForDate_(today);
        patch.QuotaID = quota.QuotaID;
        patch.ProjectDate = parseDateOnly_(today);
      }
      patch.ProjectEndDate = '';
    } else {
      patch.ProjectEndDate = parseDateOnly_(today);
    }

    return DB.update(PROJECTS_TABLE, projectId, patch);
  });
}

/**
 * Deletes a project — mainly for cleaning up test/mistaken entries.
 * Admin may delete any project; a Hub Manager only one filed at their
 * own hub. Same permission shape as deleteBeneficiary in
 * Beneficiaries.gs. Does not cascade: any BeneficiaryVisits rows a
 * beneficiary already joined against this project keep their
 * ProjectID, just pointing at a record that no longer exists — exactly
 * how a deleted Beneficiary's own visit history is left alone too.
 */
function deleteProject(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(PROJECTS_TABLE, id);
    if (!existing) throw new Error('Project not found.');
    if (identity.role === 'HubManager' && existing.HubID !== identity.hubId) {
      throw new Error('Project not found.');
    }

    DB.remove(PROJECTS_TABLE, id);
    logAudit_(identity, 'Delete', PROJECTS_TABLE, id, '(record)', existing.ProjectName, '', existing.HubID);
    return true;
  });
}

/**
 * Finds the single ReportingQuota open for filing on a given date —
 * used to auto-resolve a project's quota the moment it's first
 * activated. Fails loudly rather than guessing: quotas can have
 * custom, overlapping date ranges since flexible dates shipped, so
 * silently picking one of several matches could misattribute a
 * project's reporting quarter with no way to notice later.
 */
function findQuotaForDate_(dateStr) {
  var target = parseDateOnly_(dateStr);
  var matches = DB.getAll('ReportingQuotas').filter(function (q) {
    if (q.Status !== 'Active') return false;
    try {
      var range = getQuotaDateRange_(q);
      return target >= range.start && target <= range.end;
    } catch (err) {
      return false; // malformed legacy quota — skip rather than error the whole lookup
    }
  });

  if (matches.length === 0) {
    throw new Error('No reporting quota is currently open for today\'s date — ask your Admin to set one up before activating a project.');
  }
  if (matches.length > 1) {
    throw new Error('More than one open reporting quota covers today\'s date (' +
      matches.map(quotaLabel_).join(', ') + ') — ask your Admin to fix the overlap before activating a project.');
  }
  return matches[0];
}

/**
 * Maps a raw age to one of the 10 fixed Project age-band field names
 * (AGE_BAND_FIELDS above) — deliberately separate from the
 * Admin-configurable AgeBands table (AgeBands.gs) that drives
 * Beneficiaries.AgeGroup, since that one's bands are independently
 * configurable and not guaranteed to line up with these fixed columns.
 */
function bucketAgeForProject_(age) {
  age = Number(age);
  if (isNaN(age)) return null;
  if (age <= 5) return 'Age0to5';
  if (age <= 10) return 'Age6to10';
  if (age <= 13) return 'Age11to13';
  if (age <= 18) return 'Age14to18';
  if (age <= 23) return 'Age19to23';
  if (age <= 28) return 'Age24to28';
  if (age <= 32) return 'Age29to32';
  if (age <= 36) return 'Age33to36';
  if (age <= 64) return 'Age37to64';
  return 'Age65Plus';
}

/**
 * Live beneficiary/Female/age-band stats for one project, computed
 * from who actually joined (BeneficiaryVisits.ProjectID), deduped by
 * BeneficiaryID so a repeat visitor across many days still counts
 * once. Legacy 'Submitted' projects skip all this and just return
 * their original stored columns unchanged. Prefer attachProjectStats_
 * for a list of projects — it does the full-table reads once instead
 * of once per project.
 */
function getProjectStats_(project) {
  return attachProjectStats_([project])[0];
}

/** Batch version of getProjectStats_ — fetches BeneficiaryVisits/Beneficiaries once for the whole list, mutates and returns `projects`. */
function attachProjectStats_(projects) {
  var needsLiveStats = projects.some(function (p) { return p.Status !== 'Submitted'; });
  var visitsByProject = {};
  var beneficiaries = {};

  if (needsLiveStats) {
    DB.getAll(BENEFICIARY_VISITS_TABLE).forEach(function (v) {
      if (!v.ProjectID) return;
      (visitsByProject[v.ProjectID] = visitsByProject[v.ProjectID] || []).push(v);
    });
    DB.getAll('Beneficiaries').forEach(function (b) { beneficiaries[b.BeneficiaryID] = b; });
  }

  projects.forEach(function (project) {
    if (project.Status === 'Submitted') return; // legacy — stored columns stand as-is

    var stats = { TotalNewBeneficiaries: 0, Female: 0 };
    AGE_BAND_FIELDS.forEach(function (field) { stats[field] = 0; });

    var uniqueBeneficiaryIds = {};
    (visitsByProject[project.ProjectID] || []).forEach(function (v) { uniqueBeneficiaryIds[v.BeneficiaryID] = true; });

    Object.keys(uniqueBeneficiaryIds).forEach(function (beneficiaryId) {
      var b = beneficiaries[beneficiaryId];
      if (!b) return; // beneficiary since deleted — skip rather than error the whole stat
      stats.TotalNewBeneficiaries++;
      if (b.Gender === 'Female') stats.Female++;
      var band = bucketAgeForProject_(b.Age);
      if (band) stats[band]++;
    });

    Object.keys(stats).forEach(function (key) { project[key] = stats[key]; });
  });

  return projects;
}

/** {projectId, projectName}[] for a hub's currently-Active projects — feeds the PWA bootstrap payload, same shape/purpose as the old getOpenActivitySessionsForBootstrap_. */
function getActiveProjectsForBootstrap_(hubId) {
  return DB.getAll(PROJECTS_TABLE)
    .filter(function (p) { return p.HubID === hubId && p.Status === 'Active'; })
    .map(function (p) { return { projectId: p.ProjectID, projectName: p.ProjectName }; });
}

/** Attaches a `.QuotaLabel` (e.g. "Q1 2026") to each project record for display. */
function attachQuotaLabels_(projects) {
  var quotaLookup = {};
  DB.getAll('ReportingQuotas').forEach(function (q) { quotaLookup[q.QuotaID] = quotaLabel_(q); });
  projects.forEach(function (p) { p.QuotaLabel = quotaLookup[p.QuotaID] || ''; });
  return projects;
}

/**
 * Parses a "YYYY-MM-DD" date-only string (as produced by an <input
 * type="date">) as UTC midnight, avoiding the timezone drift that a
 * plain `new Date(str)` can introduce for date-only values.
 */
function parseDateOnly_(dateStr) {
  var parts = String(dateStr).split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

/**
 * Confirms the token belongs to an active Hub Manager session and
 * returns their identity (including hubId). Throws otherwise — this is
 * the enforcement point, not a suggestion.
 */
function requireManagerSession_(sessionToken) {
  var identityResult = getIdentity(sessionToken);
  if (!identityResult.success || identityResult.data.role !== 'HubManager') {
    throw new Error('You must be logged in as a Hub Manager to do this.');
  }
  return identityResult.data;
}

/** Confirms the token belongs to an active Admin session. */
function requireAdminSession_(sessionToken) {
  var identityResult = getIdentity(sessionToken);
  if (!identityResult.success || identityResult.data.role !== 'Admin') {
    throw new Error('You must be logged in as an Admin to do this.');
  }
  return identityResult.data;
}

/**
 * LEGACY — no live caller. This was addProject's full validation back
 * when a Hub Manager hand-typed the date range, totals, and every
 * age-band field (including the rule that the age bands must add up
 * exactly to the total new beneficiaries). Left in place, unused, per
 * this codebase's convention of not deleting dormant code — addProject
 * now takes just a name and a Cost (see validateNewProjectInput).
 */
function validateProjectInput(data, quota) {
  var error = Validate.run([
    [Validate.required, data && data.ProjectName, 'Project name'],
    [Validate.maxLength, data && data.ProjectName, 150, 'Project name'],
    [Validate.required, data && data.ProjectDate, 'Start date'],
    [Validate.required, data && data.ProjectEndDate, 'End date'],
    [Validate.required, data && data.Cost, 'Cost'],
    [Validate.nonNegativeNumber, data && data.Cost, 'Cost'],
    [Validate.required, data && data.TotalNewBeneficiaries, 'Total new beneficiaries'],
    [Validate.wholeNumber, data && data.TotalNewBeneficiaries, 'Total new beneficiaries'],
    [Validate.required, data && data.Female, 'Female beneficiaries'],
    [Validate.wholeNumber, data && data.Female, 'Female beneficiaries']
  ]);
  if (error) return error;

  var startDate = parseDateOnly_(data.ProjectDate);
  if (!startDate || isNaN(startDate.getTime())) {
    return 'Start date must be a valid date.';
  }
  var endDate = parseDateOnly_(data.ProjectEndDate);
  if (!endDate || isNaN(endDate.getTime())) {
    return 'End date must be a valid date.';
  }
  if (endDate < startDate) {
    return 'End date cannot be before the start date.';
  }
  var range = getQuotaDateRange_(quota);
  if (startDate < range.start || startDate > range.end || endDate < range.start || endDate > range.end) {
    return 'The start and end dates must both fall within ' + quotaLabel_(quota) + ' (' +
      Utilities.formatDate(range.start, 'UTC', 'MMM d, yyyy') + ' – ' +
      Utilities.formatDate(range.end, 'UTC', 'MMM d, yyyy') + ').';
  }

  var total = Number(data.TotalNewBeneficiaries);
  var female = Number(data.Female);
  if (female > total) {
    return 'Female beneficiaries cannot be more than total new beneficiaries.';
  }

  var ageSum = 0;
  for (var i = 0; i < AGE_BAND_FIELDS.length; i++) {
    var field = AGE_BAND_FIELDS[i];
    var value = data[field];
    var fieldError = Validate.run([
      [Validate.required, value, 'Age ' + AGE_BAND_LABELS[field]],
      [Validate.wholeNumber, value, 'Age ' + AGE_BAND_LABELS[field]]
    ]);
    if (fieldError) return fieldError;
    ageSum += Number(value);
  }

  if (ageSum !== total) {
    return 'The age bands add up to ' + ageSum + ', but total new beneficiaries is ' + total + '. These must match.';
  }

  return null;
}
