/**
 * ============================================================
 * COMPUTERSESSIONS.GS — Computer login/logout capture (Phase 15)
 * ============================================================
 * The spec's primary measure of computer utilization (§14-16). A
 * session always identifies Hub + Computer; links to an open Visit
 * for that Beneficiary/Hub/day when one exists, else a minimal Visit
 * is created automatically (§14) so utilization never floats free of
 * the reach data.
 *
 * Validation enforced here, matching spec §22:
 *   - a computer must be eligible (Inventory.Status === 'In Use')
 *   - no second OPEN session on the same computer at once
 *   - Logout must be after Login
 * ============================================================
 */

var COMPUTER_SESSIONS_TABLE = 'ComputerSessions';

/** Starts a live session (web entry point). */
function startSession(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var hubId = resolveSessionHubId_(identity, data);

    // ComputerName (typed in, not picked from the Inventory-backed
    // dropdown) resolves to an existing or newly-created ad hoc computer —
    // see findOrCreateComputerByName_ in Computers.gs. ComputerID still
    // wins if both are somehow present, for backward compatibility with
    // every existing caller.
    if (!data.ComputerID && data.ComputerName) {
      var adHoc = findOrCreateComputerByName_(hubId, data.ComputerName);
      if (!adHoc) throw new Error('A computer name is required.');
      data.ComputerID = adHoc.ComputerID;
    }

    var computer = getComputerWithStatus_(data.ComputerID);
    if (!computer || computer.HubID !== hubId) throw new Error('Computer not found for this Hub.');
    if (computer.Status !== 'In Use') throw new Error('This computer is not currently available for a session (status: ' + computer.Status + ').');

    var openOnThisComputer = DB.getAll(COMPUTER_SESSIONS_TABLE).some(function (s) {
      return s.ComputerID === data.ComputerID && s.Status === 'Open';
    });
    if (openOnThisComputer) throw new Error('This computer already has an open session — close it before starting a new one.');

    if (!DB.getById('Beneficiaries', data.BeneficiaryID)) throw new Error('Beneficiary not found.');

    var now = new Date();
    var nowIso = now.toISOString();
    var visitId = data.VisitID || findOrCreateOpenVisit_(hubId, data.BeneficiaryID, identity);

    var record = DB.insert(COMPUTER_SESSIONS_TABLE, {
      VisitID: visitId,
      BeneficiaryID: data.BeneficiaryID,
      HubID: hubId,
      ComputerID: data.ComputerID,
      LoginTime: nowIso,
      LogoutTime: '',
      DurationMinutes: '',
      DurationEstimated: false,
      ActivityID: data.ActivityID || '',
      ProjectID: '',
      Status: 'Open',
      IdleMinutes: '',
      EntryMethod: 'WEB',
      ClientUUID: Utilities.getUuid(),
      DeviceID: '',
      ClientCapturedAt: nowIso,
      ServerReceivedAt: nowIso,
      NormalizedTime: nowIso,
      SyncStatus: 'Synced',
      CreatedByEmail: identity.email,
      CreatedByRole: identity.role
    });

    logAudit_(identity, 'Create', COMPUTER_SESSIONS_TABLE, record.SessionID, '(record)', '',
      'Session started on ' + data.ComputerID + ' for ' + data.BeneficiaryID, hubId);

    return record;
  });
}

/** Ends a live session, computing its duration. */
function endSession(sessionToken, sessionId) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(COMPUTER_SESSIONS_TABLE, sessionId);
    if (!existing) throw new Error('Session not found.');
    if (identity.role === 'HubManager' && existing.HubID !== identity.hubId) throw new Error('Session not found.');
    if (existing.Status !== 'Open') throw new Error('This session is already closed.');

    var now = new Date();
    var loginDate = new Date(existing.LoginTime);
    var minutes = Math.round((now.getTime() - loginDate.getTime()) / 60000);
    if (minutes < 0) throw new Error('Logout time cannot be before login time.');

    var updated = DB.update(COMPUTER_SESSIONS_TABLE, sessionId, {
      LogoutTime: now.toISOString(),
      DurationMinutes: minutes,
      Status: 'Closed',
      ServerReceivedAt: now.toISOString(),
      NormalizedTime: now.toISOString()
    });

    updateComputerLastActive_(existing.ComputerID);
    closeAutoVisitIfSessionsDone_(existing.VisitID, now.toISOString());
    logAuditDiff_(identity, COMPUTER_SESSIONS_TABLE, sessionId, existing, updated, existing.HubID);
    return updated;
  });
}

/**
 * If the linked Visit exists purely to represent this computer session
 * (see findOrCreateOpenVisit_'s auto-created Purpose marker) and now has
 * no other open sessions, close it too. Without this, nothing ever sets
 * an auto-created Visit's DepartureTime — it stays "open" indefinitely
 * and findOrCreateOpenVisit_ (same-beneficiary/hub/day, still-open)
 * silently attaches every later computer session that same day to it,
 * however many hours apart, instead of starting a fresh Visit. Visits
 * from any other source (Record Visit, a beneficiary's own Hub
 * Activities check-in) are left untouched — closing those stays
 * whoever created them's own responsibility.
 */
function closeAutoVisitIfSessionsDone_(visitId, logoutIso) {
  if (!visitId) return;
  var visit = DB.getById(BENEFICIARY_VISITS_TABLE, visitId);
  if (!visit || visit.DepartureTime || visit.Purpose !== 'Computer use (auto-created from session)') return;

  var stillOpen = DB.getAll(COMPUTER_SESSIONS_TABLE).some(function (s) {
    return s.VisitID === visitId && s.Status === 'Open';
  });
  if (stillOpen) return;

  var departureTime = Utilities.formatDate(new Date(logoutIso), Session.getScriptTimeZone(), 'HH:mm');
  var duration = computeVisitDuration_(visit.ArrivalTime, departureTime);
  DB.update(BENEFICIARY_VISITS_TABLE, visitId, {
    DepartureTime: departureTime,
    DurationMinutes: duration.error ? '' : duration.minutes,
    DepartureEstimated: false
  });
}

/**
 * ONE-TIME CLEANUP — run once from the Apps Script editor (Run menu),
 * not exposed to any client. Backfills the backlog of auto-created
 * Visits left open before closeAutoVisitIfSessionsDone_ existed; every
 * new session close now closes its Visit correctly on its own.
 *
 * For each open auto-created Visit, uses the LATEST LogoutTime among
 * its own linked ComputerSessions as the real DepartureTime — never
 * guessed, only backfilled from data that's already there. A Visit
 * with a still-genuinely-open session, or with no closed session to
 * backfill from at all, is left untouched. Safe to run more than once
 * — anything already closed is skipped.
 */
function backfillAutoVisitDepartures() {
  var visits = DB.getAll(BENEFICIARY_VISITS_TABLE).filter(function (v) {
    return v.Purpose === 'Computer use (auto-created from session)' && !v.DepartureTime;
  });
  var allSessions = DB.getAll(COMPUTER_SESSIONS_TABLE);
  var tz = Session.getScriptTimeZone();
  var closed = 0, skippedStillOpen = 0, skippedNoData = 0;

  visits.forEach(function (visit) {
    var sessions = allSessions.filter(function (s) { return s.VisitID === visit.VisitID; });
    if (!sessions.length) { skippedNoData++; return; }
    if (sessions.some(function (s) { return s.Status === 'Open'; })) { skippedStillOpen++; return; }

    var latestLogout = null;
    sessions.forEach(function (s) {
      if (!s.LogoutTime) return;
      var t = new Date(s.LogoutTime);
      if (!latestLogout || t > latestLogout) latestLogout = t;
    });
    if (!latestLogout) { skippedNoData++; return; }

    var departureTime = Utilities.formatDate(latestLogout, tz, 'HH:mm');
    var duration = computeVisitDuration_(visit.ArrivalTime, departureTime);
    DB.update(BENEFICIARY_VISITS_TABLE, visit.VisitID, {
      DepartureTime: departureTime,
      DurationMinutes: duration.error ? '' : duration.minutes,
      DepartureEstimated: false
    });
    closed++;
  });

  var summary = 'backfillAutoVisitDepartures: closed ' + closed +
    ', skipped (session still genuinely open) ' + skippedStillOpen +
    ', skipped (no logout data to backfill from) ' + skippedNoData + '.';
  Logger.log(summary);
  return summary;
}

/** Records a session after the fact (Hub Manager fallback, EntryMethod = MANUAL). */
function recordManualSession(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var hubId = resolveSessionHubId_(identity, data);

    var computer = getComputerWithStatus_(data.ComputerID);
    if (!computer || computer.HubID !== hubId) throw new Error('Computer not found for this Hub.');
    if (!DB.getById('Beneficiaries', data.BeneficiaryID)) throw new Error('Beneficiary not found.');

    var error = Validate.run([
      [Validate.required, data.Date, 'Date'],
      [Validate.required, data.LoginTime, 'Login time'],
      [Validate.required, data.LogoutTime, 'Logout time']
    ]);
    if (error) throw new Error(error);

    var durationInfo = computeVisitDuration_(data.LoginTime, data.LogoutTime);
    if (durationInfo.error) throw new Error(durationInfo.error);

    var overlap = DB.getAll(COMPUTER_SESSIONS_TABLE).some(function (s) {
      if (s.ComputerID !== data.ComputerID || !s.LoginTime) return false;
      var sameDay = String(s.LoginTime).slice(0, 10) === data.Date;
      if (!sameDay) return false;
      var existingLogin = timeToMinutes_(String(s.LoginTime).slice(11, 16));
      var existingLogout = s.LogoutTime ? timeToMinutes_(String(s.LogoutTime).slice(11, 16)) : 1440;
      var newLogin = timeToMinutes_(data.LoginTime);
      var newLogout = timeToMinutes_(data.LogoutTime);
      return newLogin < existingLogout && newLogout > existingLogin;
    });
    if (overlap) throw new Error('This computer already has a session recorded that overlaps this time range.');

    var loginIso = data.Date + 'T' + data.LoginTime + ':00';
    var logoutIso = data.Date + 'T' + data.LogoutTime + ':00';
    var visitId = data.VisitID || findOrCreateOpenVisit_(hubId, data.BeneficiaryID, identity);

    var record = DB.insert(COMPUTER_SESSIONS_TABLE, {
      VisitID: visitId,
      BeneficiaryID: data.BeneficiaryID,
      HubID: hubId,
      ComputerID: data.ComputerID,
      LoginTime: loginIso,
      LogoutTime: logoutIso,
      DurationMinutes: durationInfo.minutes,
      DurationEstimated: false,
      ActivityID: data.ActivityID || '',
      ProjectID: '',
      Status: 'Closed',
      IdleMinutes: '',
      EntryMethod: 'MANUAL',
      ClientUUID: Utilities.getUuid(),
      DeviceID: '',
      ClientCapturedAt: new Date().toISOString(),
      ServerReceivedAt: new Date().toISOString(),
      NormalizedTime: loginIso,
      SyncStatus: 'Synced',
      CreatedByEmail: identity.email,
      CreatedByRole: identity.role
    });

    updateComputerLastActive_(data.ComputerID);
    logAudit_(identity, 'Create', COMPUTER_SESSIONS_TABLE, record.SessionID, '(record)', '',
      'Manual session on ' + data.ComputerID + ' for ' + data.BeneficiaryID, hubId);

    return record;
  });
}

function updateComputerLastActive_(computerId) {
  DB.update('Computers', computerId, { LastActiveDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd') });
}

function resolveSessionHubId_(identity, data) {
  if (identity.role === 'HubManager') return identity.hubId;
  if (identity.role === 'Admin') {
    if (!data.HubID) throw new Error('Hub is required.');
    return data.HubID;
  }
  throw new Error('You do not have permission to record a computer session.');
}

/** Internal: finds today's open Visit for this Beneficiary at this Hub, or creates a minimal one (spec §14). */
function findOrCreateOpenVisit_(hubId, beneficiaryId, identity) {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var openVisit = DB.getAll(BENEFICIARY_VISITS_TABLE).filter(function (v) {
    return v.HubID === hubId && v.BeneficiaryID === beneficiaryId && v.Date === today && !v.DepartureTime;
  })[0];
  if (openVisit) return openVisit.VisitID;

  var nowTime = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm');
  var minimalVisit = DB.insert(BENEFICIARY_VISITS_TABLE, {
    HubID: hubId,
    BeneficiaryID: beneficiaryId,
    Date: today,
    ArrivalTime: nowTime,
    DepartureTime: '',
    DurationMinutes: '',
    DepartureEstimated: false,
    VisitorType: '',
    Purpose: 'Computer use (auto-created from session)',
    ProjectID: '',
    ComputerUsed: true,
    NumComputersUsed: 1,
    EntryMethod: 'WEB',
    Notes: '',
    ClientUUID: Utilities.getUuid(),
    DeviceID: '',
    SyncStatus: 'Synced',
    CreatedByEmail: identity.email,
    CreatedByRole: identity.role
  });
  return minimalVisit.VisitID;
}

/** Hub Manager: their own Hub's sessions. */
function getMyHubComputerSessions(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};
    var all = DB.getAll(COMPUTER_SESSIONS_TABLE).filter(function (s) { return s.HubID === manager.hubId; });
    all = resolveForeignKey(all, 'BeneficiaryID', 'Beneficiaries', 'FirstName', 'BeneficiaryFirstName');
    return paginateAndFilter(all, {
      sortBy: options.sortBy || 'LoginTime',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Admin: every Hub's sessions, optionally filtered to one Hub. */
function getAllComputerSessions(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};
    var all = applyHubScope_(DB.getAll(COMPUTER_SESSIONS_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');
    if (options.hubId) all = all.filter(function (s) { return s.HubID === options.hubId; });
    all = resolveForeignKey(all, 'HubID', 'Hubs', 'HubName', 'HubName');
    all = resolveForeignKey(all, 'BeneficiaryID', 'Beneficiaries', 'FirstName', 'BeneficiaryFirstName');
    return paginateAndFilter(all, {
      sortBy: options.sortBy || 'LoginTime',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}
