/**
 * ============================================================
 * VISITS.GS — Individual Hub Visit capture (Phase 15)
 * ============================================================
 * The spec's primary measure of reach/engagement (§9). A Visit can
 * exist with zero Computer Sessions — ComputerUsed/NumComputersUsed
 * here are a quick summary; Milestone 4's ComputerSessions rows are
 * the source of truth once that module exists.
 *
 * recordVisit() covers both "arrived and left already" (DepartureTime
 * given up front, e.g. logging a visit after the fact) and "still
 * here" (DepartureTime blank, closed later via closeVisit()) — one
 * function instead of separate open/close calls, to keep the Hub
 * Manager's flow to as few taps as possible (spec NFR: ≤5 taps).
 *
 * ProjectID is in the schema (spec §28) but deliberately not exposed
 * on the capture form yet — Projects in this platform are dated
 * beneficiary reports, not a small pickable "program" list, so a
 * usable project-linking UI is left for a later pass once it's clear
 * how Hub Managers would actually want to pick one.
 * ============================================================
 */

var BENEFICIARY_VISITS_TABLE = 'BeneficiaryVisits';
var VISIT_ACTIVITIES_TABLE = 'VisitActivities';

/** Records a Hub Visit. HubID always resolved server-side for a Hub Manager; Admin may specify one. */
function recordVisit(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var hubId;
    if (identity.role === 'HubManager') {
      hubId = identity.hubId;
    } else if (identity.role === 'Admin') {
      if (!data.HubID) throw new Error('Hub is required.');
      if (!DB.getById('Hubs', data.HubID)) throw new Error('Hub not found.');
      hubId = data.HubID;
    } else {
      throw new Error('You do not have permission to record a visit.');
    }

    var error = validateVisitInput(data);
    if (error) throw new Error(error);
    if (!DB.getById('Beneficiaries', data.BeneficiaryID)) throw new Error('Beneficiary not found.');

    var durationInfo = computeVisitDuration_(data.ArrivalTime, data.DepartureTime);
    if (durationInfo.error) throw new Error(durationInfo.error);

    var record = DB.insert(BENEFICIARY_VISITS_TABLE, {
      HubID: hubId,
      BeneficiaryID: data.BeneficiaryID,
      Date: data.Date,
      ArrivalTime: data.ArrivalTime,
      DepartureTime: data.DepartureTime || '',
      DurationMinutes: durationInfo.minutes,
      DepartureEstimated: false,
      VisitorType: data.VisitorType || '',
      Purpose: String(data.Purpose || '').trim(),
      ProjectID: '',
      ComputerUsed: !!data.ComputerUsed,
      NumComputersUsed: data.ComputerUsed ? (Number(data.NumComputersUsed) || 0) : 0,
      EntryMethod: 'WEB',
      Notes: String(data.Notes || '').trim(),
      ClientUUID: Utilities.getUuid(),
      DeviceID: '',
      SyncStatus: 'Synced',
      CreatedByEmail: identity.email,
      CreatedByRole: identity.role
    });

    tagActivities_('Individual', record.VisitID, data.ActivityIDs);

    logAudit_(identity, 'Create', BENEFICIARY_VISITS_TABLE, record.VisitID, '(record)', '',
      'Visit for ' + data.BeneficiaryID + ' on ' + record.Date, hubId);

    return record;
  });
}

/** Sets a still-open visit's departure time and computes its duration. */
function closeVisit(sessionToken, visitId, departureTime) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(BENEFICIARY_VISITS_TABLE, visitId);
    if (!existing) throw new Error('Visit not found.');
    if (identity.role === 'HubManager' && existing.HubID !== identity.hubId) throw new Error('Visit not found.');
    if (existing.DepartureTime) throw new Error('This visit is already closed.');

    var durationInfo = computeVisitDuration_(existing.ArrivalTime, departureTime);
    if (durationInfo.error) throw new Error(durationInfo.error);

    var updated = DB.update(BENEFICIARY_VISITS_TABLE, visitId, {
      DepartureTime: departureTime,
      DurationMinutes: durationInfo.minutes,
      DepartureEstimated: false
    });

    logAuditDiff_(identity, BENEFICIARY_VISITS_TABLE, visitId, existing, updated, existing.HubID);
    return updated;
  });
}

/** Internal: minutes between two HH:MM times on the same day, or an error message. */
function computeVisitDuration_(arrivalTime, departureTime) {
  if (!departureTime) return { minutes: '' };
  var arrivalMin = timeToMinutes_(arrivalTime);
  var departureMin = timeToMinutes_(departureTime);
  if (arrivalMin === null || departureMin === null) return { error: 'Arrival/departure time must be in HH:MM format.' };
  if (departureMin <= arrivalMin) return { error: 'Departure time must be after arrival time.' };
  return { minutes: departureMin - arrivalMin };
}

/** Internal: tags a Visit with the given ActivityIDs (replaces none — additive on create only). */
function tagActivities_(visitType, visitId, activityIds) {
  if (!activityIds || !activityIds.length) return;
  activityIds.forEach(function (activityId) {
    if (!activityId) return;
    DB.insert(VISIT_ACTIVITIES_TABLE, { VisitType: visitType, VisitID: visitId, ActivityID: activityId });
  });
}

/**
 * Internal: attaches a comma-joined ActivityNames field onto each visit
 * record. VisitID is already globally unique across BeneficiaryVisits, so a
 * VisitType filter here was never actually load-bearing — and now that
 * ActivitySessions.gs tags joined visits as VisitType 'Session' (not
 * 'Individual'), filtering by type would silently hide those visits'
 * activity names. Matches purely by VisitID regardless of type.
 */
function attachActivityNames_(records, idField) {
  var junctions = DB.getAll(VISIT_ACTIVITIES_TABLE);
  var activities = DB.getAll('Activities');
  var activityNameById = {};
  activities.forEach(function (a) { activityNameById[a.ActivityID] = a.Name; });

  var namesByVisitId = {};
  junctions.forEach(function (j) {
    if (!namesByVisitId[j.VisitID]) namesByVisitId[j.VisitID] = [];
    if (activityNameById[j.ActivityID]) namesByVisitId[j.VisitID].push(activityNameById[j.ActivityID]);
  });

  records.forEach(function (r) {
    r.ActivityNames = (namesByVisitId[r[idField]] || []).join(', ');
  });
  return records;
}

/** Hub Manager: their own Hub's visits. */
function getMyHubVisits(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};

    var all = DB.getAll(BENEFICIARY_VISITS_TABLE).filter(function (v) { return v.HubID === manager.hubId; });
    all = resolveForeignKey(all, 'BeneficiaryID', 'Beneficiaries', 'FirstName', 'BeneficiaryFirstName');
    all = attachActivityNames_(all, 'VisitID');

    var schema = SCHEMA[BENEFICIARY_VISITS_TABLE];
    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: schema.searchableColumns,
      sortBy: options.sortBy || 'Date',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Admin: every Hub's visits, optionally filtered to one Hub. */
function getAllVisits(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var all = applyHubScope_(DB.getAll(BENEFICIARY_VISITS_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');
    if (options.hubId) all = all.filter(function (v) { return v.HubID === options.hubId; });
    all = resolveForeignKey(all, 'HubID', 'Hubs', 'HubName', 'HubName');
    all = resolveForeignKey(all, 'BeneficiaryID', 'Beneficiaries', 'FirstName', 'BeneficiaryFirstName');
    all = attachActivityNames_(all, 'VisitID');

    var schema = SCHEMA[BENEFICIARY_VISITS_TABLE];
    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: schema.searchableColumns,
      sortBy: options.sortBy || 'Date',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

function validateVisitInput(data) {
  return Validate.run([
    [Validate.required, data && data.BeneficiaryID, 'Beneficiary'],
    [Validate.required, data && data.Date, 'Date'],
    [Validate.required, data && data.ArrivalTime, 'Arrival time'],
    [Validate.required, data && data.VisitorType, 'Visitor type'],
    [Validate.maxLength, data && data.Purpose, 200, 'Purpose'],
    [Validate.maxLength, data && data.Notes, 500, 'Notes']
  ]);
}
