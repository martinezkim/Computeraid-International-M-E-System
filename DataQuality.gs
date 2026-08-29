/**
 * ============================================================
 * DATAQUALITY.GS — Data-quality issue queue (Phase 15)
 * ============================================================
 * Spec §22's "block vs warn" checks split across two places:
 *   - BLOCKING checks (impossible durations, overlapping sessions,
 *     missing required fields) already reject the write itself —
 *     see validateVisitInput()/recordVisit() in Visits.gs and
 *     startSession()/recordManualSession() in ComputerSessions.gs.
 *   - The softer, comparative checks below (things you can only spot
 *     by looking across records, not from a single write) populate
 *     this queue instead of blocking anything, and are scanned fresh
 *     each time the queue is read — same "recompute on read" choice
 *     as UsageKPIs.gs, for the same reason (MVP data volume doesn't
 *     need a scheduled trigger yet).
 * ============================================================
 */

var DATA_QUALITY_ISSUES_TABLE = 'DataQualityIssues';
var STALE_OPEN_SESSION_HOURS = 12;

/** Internal: runs every comparative check and appends any newly-found issues (skips ones already open). */
function scanForUsageDataQualityIssues_() {
  var existingOpenKeys = {};
  DB.getAll(DATA_QUALITY_ISSUES_TABLE).filter(function (i) { return i.Status === 'Open'; }).forEach(function (i) {
    existingOpenKeys[i.EntityType + ':' + i.EntityID + ':' + i.IssueType] = true;
  });

  function flag(entityType, entityId, hubId, issueType, severity, detail) {
    var key = entityType + ':' + entityId + ':' + issueType;
    if (existingOpenKeys[key]) return;
    existingOpenKeys[key] = true;
    DB.insert(DATA_QUALITY_ISSUES_TABLE, {
      EntityType: entityType, EntityID: entityId, HubID: hubId || '', IssueType: issueType,
      Severity: severity, Detail: detail, Status: 'Open', DetectedAt: new Date().toISOString(),
      ResolvedByEmail: '', ResolvedAt: ''
    });
  }

  // Stale open computer sessions.
  var now = new Date();
  DB.getAll(COMPUTER_SESSIONS_TABLE).filter(function (s) { return s.Status === 'Open'; }).forEach(function (s) {
    var loginDate = new Date(s.LoginTime);
    var hoursOpen = (now.getTime() - loginDate.getTime()) / 3600000;
    if (hoursOpen >= STALE_OPEN_SESSION_HOURS) {
      flag('ComputerSession', s.SessionID, s.HubID, 'StaleOpenSession', 'Warn',
        'Session on ' + s.ComputerID + ' has been open for ' + Math.round(hoursOpen) + ' hours — close it or investigate.');
    }
  });

  // Over-utilization: a computer logging more hours today than the Hub was open.
  var today = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var sessionsToday = DB.getAll(COMPUTER_SESSIONS_TABLE).filter(function (s) {
    return String(s.LoginTime).slice(0, 10) === today && s.DurationMinutes !== '';
  });
  var minutesByComputer = {};
  sessionsToday.forEach(function (s) {
    minutesByComputer[s.ComputerID] = (minutesByComputer[s.ComputerID] || 0) + Number(s.DurationMinutes);
  });
  var hubsById = {};
  DB.getAll('Hubs').forEach(function (h) { hubsById[h.HubID] = h; });
  Object.keys(minutesByComputer).forEach(function (computerId) {
    var computer = DB.getById('Computers', computerId);
    if (!computer) return;
    var openHours = getHubOpenHours_(computer.HubID, today, today);
    if (!openHours.hasSchedule) return;
    var hoursLogged = minutesByComputer[computerId] / 60;
    if (hoursLogged > openHours.totalHours) {
      flag('Computer', computerId, computer.HubID, 'OverUtilization', 'Warn',
        computerId + ' logged ' + Math.round(hoursLogged * 10) / 10 + 'h today — more than the Hub\'s ' + openHours.totalHours + 'h open window.');
    }
  });

  // Possible duplicate beneficiaries (same name-initial + age group + gender + home hub).
  var beneficiaries = DB.getAll('Beneficiaries');
  var groups = {};
  beneficiaries.forEach(function (b) {
    var key = [String(b.FirstName).toLowerCase(), b.SurnameInitial, b.AgeGroup, b.Gender, b.HomeHubID].join('|');
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  });
  Object.keys(groups).forEach(function (key) {
    var group = groups[key];
    if (group.length < 2) return;
    group.forEach(function (b) {
      flag('Beneficiary', b.BeneficiaryID, b.HomeHubID, 'PossibleDuplicate', 'Warn',
        'Matches ' + (group.length - 1) + ' other beneficiary record(s) on name, age group, gender, and home Hub.');
    });
  });
}

/** Hub Manager: their own Hub's open issues. */
function getMyHubDataQualityQueue(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    scanForUsageDataQualityIssues_();
    return DB.getAll(DATA_QUALITY_ISSUES_TABLE).filter(function (i) { return i.HubID === manager.hubId && i.Status === 'Open'; });
  });
}

/** Admin: every open issue, across every Hub. */
function getAllDataQualityIssues(sessionToken) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    scanForUsageDataQualityIssues_();
    var all = DB.getAll(DATA_QUALITY_ISSUES_TABLE).filter(function (i) { return i.Status === 'Open'; });
    return resolveForeignKey(all, 'HubID', 'Hubs', 'HubName', 'HubName');
  });
}

function resolveDataQualityIssue(sessionToken, issueId, newStatus) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(DATA_QUALITY_ISSUES_TABLE, issueId);
    if (!existing) throw new Error('Issue not found.');
    if (identity.role === 'HubManager' && existing.HubID !== identity.hubId) throw new Error('Issue not found.');
    if (['Resolved', 'Ignored'].indexOf(newStatus) === -1) throw new Error('Invalid status.');

    return DB.update(DATA_QUALITY_ISSUES_TABLE, issueId, {
      Status: newStatus, ResolvedByEmail: identity.email, ResolvedAt: new Date().toISOString()
    });
  });
}
