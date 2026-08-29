/**
 * ============================================================
 * SYNC.GS — Offline batch sync API (Phase 16 Milestone C)
 * ============================================================
 * doPost(e) in Code.gs routes here. This is the data/API contract
 * for the future offline PWA (and later the desktop agent) — the
 * client-facing PWA itself, and real CORS validation from a Firebase-
 * hosted origin, are follow-up work (see the Phase 16 plan).
 *
 * Request body:
 *   { device_id, api_key, batch_id, records: [ {type, client_uuid, payload} ] }
 * Response body:
 *   { status: 'ok'|'error', batch_id, results: [ {client_uuid, status, canonical_id, issues[]} ] }
 *
 * Idempotency: every synced record carries a client_uuid; before
 * writing, each handler checks whether a row with that ClientUUID
 * already exists in the target table and returns the existing
 * canonical ID instead of inserting again (spec §18's "linchpin").
 *
 * Device auth reuses the exact same hashPassword()/verifyPassword()
 * helpers (Utilities.gs) as human login — a device's API key is
 * salted+hashed at provisioning time, never stored plain.
 * ============================================================
 */

var SYNC_DEVICES_TABLE = 'SyncDevices';
var SYNC_LOGS_TABLE = 'SynchronizationLogs';

/** Entry point called from Code.gs's doPost(e). Always returns a JSON ContentService response. */
function handleSyncRequest_(e) {
  var batchId = '(unknown)';
  try {
    var body = JSON.parse(e.postData.contents);
    batchId = body.batch_id || Utilities.getUuid();

    var device = authenticateSyncDevice_(body.device_id, body.api_key);
    var records = body.records || [];

    var results = records.map(function (record) { return processSyncRecord_(record, device); });

    var writtenCount = results.filter(function (r) { return r.status === 'ok'; }).length;
    var duplicateCount = results.filter(function (r) { return r.status === 'duplicate'; }).length;
    var errorCount = results.filter(function (r) { return r.status === 'error'; }).length;

    DB.update(SYNC_DEVICES_TABLE, device.DeviceID, { LastSyncAt: new Date().toISOString() });
    logSyncBatch_(device.DeviceID, batchId, records.length, writtenCount, duplicateCount, errorCount, '');

    return jsonResponse_({ status: 'ok', batch_id: batchId, results: results });
  } catch (err) {
    logSyncBatch_((e && e.parameter && e.parameter.device_id) || '(unknown)', batchId, 0, 0, 0, 0, err.message);
    return jsonResponse_({ status: 'error', batch_id: batchId, message: err.message });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Entry point called from Code.gs's doGet(e) when ?api= is present.
 * Device-authenticated (device_id/api_key as query params, same
 * credentials as the sync endpoint). Currently only 'bootstrap' is
 * implemented — everything the offline PWA needs to work without a
 * connection: this Hub's own beneficiaries (for offline search),
 * computers, and the Activities/VisitorTypes pick lists. Scoped to
 * the device's own Hub only — an org-wide pull was judged unnecessary
 * complexity for the MVP (see Phase 16 plan notes on offline scope).
 */
function handleApiGetRequest_(e) {
  try {
    var device = authenticateSyncDevice_(e.parameter.device_id, e.parameter.api_key);
    var action = e.parameter.api;

    if (action === 'bootstrap') return jsonResponse_({ status: 'ok', data: buildBootstrapPayload_(device) });

    return jsonResponse_({ status: 'error', message: 'Unknown api action: ' + action });
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message });
  }
}

function buildBootstrapPayload_(device) {
  var hub = DB.getById('Hubs', device.HubID);

  // Counted once here (not per-beneficiary DB.getAll calls) so a hub
  // with thousands of visits/sessions still produces one bootstrap
  // payload quickly — this is what powers the kiosk's personal
  // "your visits so far" stat after someone signs in (offline-safe,
  // no extra round-trip needed at sign-in time).
  var visitCounts = {};
  DB.getAll('BeneficiaryVisits').forEach(function (v) {
    visitCounts[v.BeneficiaryID] = (visitCounts[v.BeneficiaryID] || 0) + 1;
  });
  var sessionCounts = {};
  DB.getAll(COMPUTER_SESSIONS_TABLE).forEach(function (s) {
    sessionCounts[s.BeneficiaryID] = (sessionCounts[s.BeneficiaryID] || 0) + 1;
  });

  var beneficiaries = DB.getAll('Beneficiaries')
    .filter(function (b) { return b.HomeHubID === device.HubID; })
    .map(function (b) {
      return {
        id: b.BeneficiaryID, firstName: b.FirstName, lastName: b.LastName, surnameInitial: b.SurnameInitial,
        age: b.Age, ageGroup: b.AgeGroup, gender: b.Gender, community: b.Community,
        // Full profile fields — cached so the PWA's "My Profile" screen
        // can show/edit them offline without a live round-trip.
        country: b.Country, region: b.Region, educationLevel: b.EducationLevel, occupation: b.Occupation,
        userCategory: b.UserCategory, phone: b.Phone, email: b.Email, disabilityInfo: b.DisabilityInfo,
        photoUrl: b.PhotoUrl || '',
        visitCount: visitCounts[b.BeneficiaryID] || 0, sessionCount: sessionCounts[b.BeneficiaryID] || 0
      };
    });

  var computers = provisionAndGetHubComputers_(device.HubID).map(function (c) {
    return { id: c.ComputerID, itemName: c.ItemName, status: c.Status };
  });

  var openSessionComputerIds = DB.getAll(COMPUTER_SESSIONS_TABLE)
    .filter(function (s) { return s.HubID === device.HubID && s.Status === 'Open'; })
    .map(function (s) { return s.ComputerID; });

  // Read directly rather than through getActivityOptions()/getVisitorTypeOptions()
  // — those require a logged-in user sessionToken (requireIdentity_), but this
  // whole payload is built for a kiosk device authenticated separately via its
  // device ID/API key, with no user session at all. Calling them bare (no
  // token) always failed silently and fell back to an empty list; every other
  // field here already reads its table directly for the same reason.
  var activities = DB.getAll(ACTIVITIES_TABLE)
    .filter(function (a) { return a.Active === true || a.Active === 'true'; })
    .sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
    .map(function (a) { return { id: a.ActivityID, name: a.Name, category: a.Category }; });
  var visitorTypes = DB.getAll(VISITOR_TYPES_TABLE)
    .filter(function (v) { return v.Active === true || v.Active === 'true'; })
    .sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
    .map(function (v) { return { id: v.VisitorTypeID, name: v.Name }; });
  var schedule = getHubScheduleForHub_(device.HubID);

  return {
    hub: { id: hub.HubID, name: hub.HubName },
    hubSchedule: schedule ? { openDays: schedule.OpenDays, openTime: schedule.OpenTime, closeTime: schedule.CloseTime } : null,
    beneficiaries: beneficiaries,
    computers: computers,
    openSessionComputerIds: openSessionComputerIds,
    activities: activities,
    visitorTypes: visitorTypes,
    // Named distinctly from openSessionComputerIds above — these are
    // Hub-Manager-activated Projects a beneficiary can one-tap join,
    // unrelated to computer sessions. Replaces the old
    // openActivitySessions field now that Group Sessions have merged
    // into Projects (ActivitySessions.gs itself is untouched — its
    // getOpenActivitySessionsForBootstrap_ just has no more callers).
    activeProjects: getActiveProjectsForBootstrap_(device.HubID),
    todayStats: buildTodayHubStats_(device.HubID),
    fetchedAt: new Date().toISOString()
  };
}

/**
 * The kiosk landing screen's "Today at [Hub]" banner — a quick pulse a
 * beneficiary can see before they even sign in. Deliberately cheap: no
 * new tables, just filters over what's already loaded for the rest of
 * the bootstrap payload plus one computePeriodKPIs_ call reused from
 * the Admin/Hub Manager dashboards (UsageKPIs.gs) for the weekly
 * computer-hours figure, so that number matches what staff see
 * elsewhere instead of being computed a second, possibly-differing way.
 */
function buildTodayHubStats_(hubId) {
  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  var visitsToday = DB.getAll(BENEFICIARY_VISITS_TABLE).filter(function (v) {
    return v.HubID === hubId && v.Date === today;
  });
  var checkedInToday = uniqueValues_(visitsToday.map(function (v) { return v.BeneficiaryID; })).length;

  var todayVisitIds = {};
  visitsToday.forEach(function (v) { todayVisitIds[v.VisitID] = true; });
  var activitiesToday = uniqueValues_(
    DB.getAll(VISIT_ACTIVITIES_TABLE)
      .filter(function (j) { return j.VisitType === 'Individual' && todayVisitIds[j.VisitID]; })
      .map(function (j) { return j.ActivityID; })
  ).length;

  var computers = provisionAndGetHubComputers_(hubId);
  var computersAvailable = computers.filter(function (c) { return c.Status === 'In Use'; }).length;

  var weekEnd = new Date();
  var weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 6);
  var weekRange = {
    start: Utilities.formatDate(weekStart, tz, 'yyyy-MM-dd'),
    end: Utilities.formatDate(weekEnd, tz, 'yyyy-MM-dd')
  };
  var computerHoursThisWeek = computePeriodKPIs_(hubId, weekRange.start, weekRange.end).totalComputerHours;

  return {
    checkedInToday: checkedInToday,
    computersAvailable: computersAvailable,
    activitiesToday: activitiesToday,
    computerHoursThisWeek: computerHoursThisWeek
  };
}

function logSyncBatch_(deviceId, batchId, total, written, duplicates, errors, detail) {
  try {
    DB.insert(SYNC_LOGS_TABLE, {
      DeviceID: deviceId, BatchID: batchId, ReceivedAt: new Date().toISOString(),
      RecordsTotal: total, RecordsWritten: written, Duplicates: duplicates, Conflicts: 0, Errors: errors, Detail: detail
    });
  } catch (logErr) { /* never let logging break the sync response */ }
}

/** Internal: validates a device_id + api_key pair, throws if invalid/inactive. */
function authenticateSyncDevice_(deviceId, apiKey) {
  if (!deviceId || !apiKey) throw new Error('device_id and api_key are required.');
  var device = DB.getById(SYNC_DEVICES_TABLE, deviceId);
  if (!device || device.Active !== true && device.Active !== 'true') throw new Error('Unknown or inactive device.');
  if (!verifyPassword(apiKey, device.APIKeySalt, device.APIKeyHash)) throw new Error('Invalid device credentials.');
  return device;
}

/** Internal: dispatches one record to its type-specific handler, catching errors per-record. */
function processSyncRecord_(record, device) {
  try {
    if (!record.client_uuid) throw new Error('Every record needs a client_uuid.');
    switch (record.type) {
      case 'beneficiary': return syncBeneficiary_(record, device);
      case 'visit': return syncVisit_(record, device);
      case 'session_login': return syncSessionLogin_(record, device);
      case 'session_logout': return syncSessionLogout_(record, device);
      // Deliberately not "session_join" — 'session_' already means a
      // COMPUTER session (session_login/session_logout above); this is
      // joining a Hub-Manager-opened ActivitySessions row instead.
      case 'activity_session_join': return syncActivitySessionJoin_(record, device);
      case 'project_join': return syncProjectJoin_(record, device);
      case 'feedback': return syncFeedback_(record, device);
      case 'profile_update': return syncProfileUpdate_(record, device);
      default: return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Unknown record type: ' + record.type] };
    }
  } catch (err) {
    return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: [err.message] };
  }
}

function findByClientUuid_(tableName, clientUuid) {
  return DB.getAll(tableName).filter(function (r) { return r.ClientUUID === clientUuid; })[0] || null;
}

function syncBeneficiary_(record, device) {
  var existing = findByClientUuid_('Beneficiaries', record.client_uuid);
  if (existing) return { client_uuid: record.client_uuid, status: 'duplicate', canonical_id: existing.BeneficiaryID, issues: [] };

  var data = record.payload || {};
  var error = validateBeneficiaryInput(data);
  if (error) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: [error] };

  var nowDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var lastName = titleCase_(data.LastName);
  var age = Number(data.Age);
  var created = DB.insert('Beneficiaries', {
    FirstName: titleCase_(data.FirstName), LastName: lastName,
    SurnameInitial: lastName.charAt(0).toUpperCase(), Age: age, AgeGroup: mapAgeToBand_(age),
    Gender: data.Gender, Country: String(data.Country || '').trim(),
    Region: titleCase_(data.Region), Community: titleCase_(data.Community),
    EducationLevel: data.EducationLevel || '', Occupation: titleCase_(data.Occupation),
    UserCategory: data.UserCategory || '', DisabilityInfo: String(data.DisabilityInfo || '').trim(),
    Phone: String(data.Phone || '').trim(), Email: String(data.Email || '').trim(),
    DistanceFromHub: data.DistanceFromHub || '', FirstTimeVisitor: data.FirstTimeVisitor || '', HomeHubID: device.HubID,
    RegistrationDate: nowDate, QRToken: Utilities.getUuid(), CreatedByEmail: 'device:' + device.DeviceID, CreatedByRole: 'Device',
    ClientUUID: record.client_uuid, DeviceID: device.DeviceID, SyncStatus: 'Synced'
  });
  if (created.Email) EmailService.sendBeneficiaryWelcomeEmail(created);
  return { client_uuid: record.client_uuid, status: 'ok', canonical_id: created.BeneficiaryID, issues: [] };
}

function syncVisit_(record, device) {
  var existing = findByClientUuid_(BENEFICIARY_VISITS_TABLE, record.client_uuid);
  if (existing) return { client_uuid: record.client_uuid, status: 'duplicate', canonical_id: existing.VisitID, issues: [] };

  var data = record.payload || {};
  if (!DB.getById('Beneficiaries', data.BeneficiaryID)) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Beneficiary not found — sync the beneficiary first.'] };
  var error = validateVisitInput(data);
  if (error) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: [error] };

  var durationInfo = computeVisitDuration_(data.ArrivalTime, data.DepartureTime);
  if (durationInfo.error) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: [durationInfo.error] };

  var created = DB.insert(BENEFICIARY_VISITS_TABLE, {
    HubID: device.HubID, BeneficiaryID: data.BeneficiaryID, Date: data.Date, ArrivalTime: data.ArrivalTime,
    DepartureTime: data.DepartureTime || '', DurationMinutes: durationInfo.minutes, DepartureEstimated: false,
    VisitorType: data.VisitorType || '', Purpose: String(data.Purpose || '').trim(), ProjectID: '',
    ComputerUsed: !!data.ComputerUsed, NumComputersUsed: data.ComputerUsed ? (Number(data.NumComputersUsed) || 0) : 0,
    EntryMethod: 'AGENT', Notes: String(data.Notes || '').trim(),
    ClientUUID: record.client_uuid, DeviceID: device.DeviceID, SyncStatus: 'Synced',
    CreatedByEmail: 'device:' + device.DeviceID, CreatedByRole: 'Device'
  });
  tagActivities_('Individual', created.VisitID, data.ActivityIDs);
  return { client_uuid: record.client_uuid, status: 'ok', canonical_id: created.VisitID, issues: [] };
}

/**
 * One-tap join of a Hub-Manager-opened ActivitySessions row (see
 * ActivitySessions.gs). Deliberately does NOT call validateVisitInput —
 * that requires VisitorType, which a one-tap join skips on purpose (the
 * Activity itself already says what this visit is for). Idempotent two
 * ways: the usual ClientUUID retry check below, plus a same-session-
 * same-beneficiary-still-open check for an accidental double-tap on the
 * kiosk (each producing a different ClientUUID, so the first check alone
 * wouldn't catch it).
 */
function syncActivitySessionJoin_(record, device) {
  var existing = findByClientUuid_(BENEFICIARY_VISITS_TABLE, record.client_uuid);
  if (existing) return { client_uuid: record.client_uuid, status: 'duplicate', canonical_id: existing.VisitID, issues: [] };

  var data = record.payload || {};
  if (!DB.getById('Beneficiaries', data.BeneficiaryID)) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Beneficiary not found — sync the beneficiary first.'] };

  var gsession = DB.getById(ACTIVITY_SESSIONS_TABLE, data.SessionID);
  if (!gsession || gsession.HubID !== device.HubID) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Session not found for this hub.'] };
  if (gsession.Status !== 'Open') return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['This session has already closed.'] };

  var alreadyJoined = DB.getAll(BENEFICIARY_VISITS_TABLE).filter(function (v) {
    return v.SessionID === data.SessionID && v.BeneficiaryID === data.BeneficiaryID && !v.DepartureTime;
  })[0];
  if (alreadyJoined) return { client_uuid: record.client_uuid, status: 'duplicate', canonical_id: alreadyJoined.VisitID, issues: [] };

  var activity = DB.getById('Activities', gsession.ActivityID);
  var nowTime = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm');
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var created = DB.insert(BENEFICIARY_VISITS_TABLE, {
    HubID: device.HubID, BeneficiaryID: data.BeneficiaryID, Date: today, ArrivalTime: nowTime,
    DepartureTime: '', DurationMinutes: '', DepartureEstimated: false,
    VisitorType: '', Purpose: activity ? activity.Name : '', ProjectID: '',
    ComputerUsed: false, NumComputersUsed: 0,
    EntryMethod: 'AGENT', Notes: '',
    ClientUUID: record.client_uuid, DeviceID: device.DeviceID, SyncStatus: 'Synced',
    CreatedByEmail: 'device:' + device.DeviceID, CreatedByRole: 'Device',
    SessionID: data.SessionID
  });
  tagActivities_('Session', created.VisitID, [gsession.ActivityID]);
  return { client_uuid: record.client_uuid, status: 'ok', canonical_id: created.VisitID, issues: [] };
}

/**
 * One-tap join of a Hub-Manager-activated Project (see setProjectStatus
 * in Projects.gs) — replaces the old ActivitySessions join above for
 * new "join a project" taps; syncActivitySessionJoin_ stays only so any
 * already-queued pre-update PWA outbox items don't strand.
 *
 * Deliberately NOT an open/close pair like a group session: a Project
 * can stay Active for weeks, so ArrivalTime/DepartureTime are both set
 * to "now" in one shot (DurationMinutes: 0) rather than left open for a
 * later bulk-close — see Projects.gs's setProjectStatus doc comment for
 * why. That also makes the duplicate-tap guard below same-CALENDAR-DAY
 * scoped (Date match, not "still open") — otherwise a beneficiary who
 * joins again on a later day would be wrongly treated as a repeat of
 * their first day's now-permanently-"open" visit.
 */
function syncProjectJoin_(record, device) {
  var existing = findByClientUuid_(BENEFICIARY_VISITS_TABLE, record.client_uuid);
  if (existing) return { client_uuid: record.client_uuid, status: 'duplicate', canonical_id: existing.VisitID, issues: [] };

  var data = record.payload || {};
  if (!DB.getById('Beneficiaries', data.BeneficiaryID)) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Beneficiary not found — sync the beneficiary first.'] };

  var project = DB.getById(PROJECTS_TABLE, data.ProjectID);
  if (!project || project.HubID !== device.HubID) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Project not found for this hub.'] };
  if (project.Status !== 'Active') return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['This project is not currently active.'] };

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var alreadyJoinedToday = DB.getAll(BENEFICIARY_VISITS_TABLE).filter(function (v) {
    return v.ProjectID === data.ProjectID && v.BeneficiaryID === data.BeneficiaryID && v.Date === today;
  })[0];
  if (alreadyJoinedToday) return { client_uuid: record.client_uuid, status: 'duplicate', canonical_id: alreadyJoinedToday.VisitID, issues: [] };

  var nowTime = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm');

  var created = DB.insert(BENEFICIARY_VISITS_TABLE, {
    HubID: device.HubID, BeneficiaryID: data.BeneficiaryID, Date: today, ArrivalTime: nowTime,
    DepartureTime: nowTime, DurationMinutes: 0, DepartureEstimated: false,
    VisitorType: '', Purpose: project.ProjectName, ProjectID: data.ProjectID,
    ComputerUsed: false, NumComputersUsed: 0,
    EntryMethod: 'AGENT', Notes: '',
    ClientUUID: record.client_uuid, DeviceID: device.DeviceID, SyncStatus: 'Synced',
    CreatedByEmail: 'device:' + device.DeviceID, CreatedByRole: 'Device'
  });
  return { client_uuid: record.client_uuid, status: 'ok', canonical_id: created.VisitID, issues: [] };
}

function syncSessionLogin_(record, device) {
  var existing = findByClientUuid_(COMPUTER_SESSIONS_TABLE, record.client_uuid);
  if (existing) return { client_uuid: record.client_uuid, status: 'duplicate', canonical_id: existing.SessionID, issues: [] };

  var data = record.payload || {};

  // ComputerName (the beneficiary typing in whatever machine they're at)
  // resolves to an existing or newly-created ad hoc computer — see
  // findOrCreateComputerByName_ in Computers.gs. ComputerID still wins if
  // both are somehow present.
  if (!data.ComputerID && data.ComputerName) {
    var adHoc = findOrCreateComputerByName_(device.HubID, data.ComputerName);
    if (adHoc) data.ComputerID = adHoc.ComputerID;
  }

  var computer = getComputerWithStatus_(data.ComputerID);
  if (!computer || computer.HubID !== device.HubID) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Computer not found for this device\'s Hub.'] };
  if (!DB.getById('Beneficiaries', data.BeneficiaryID)) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Beneficiary not found — sync the beneficiary first.'] };

  var clientCapturedAt = data.clientCapturedAt || new Date().toISOString();
  var serverReceivedAt = new Date().toISOString();
  var identity = { email: 'device:' + device.DeviceID, role: 'Device' };
  var visitId = data.VisitID || findOrCreateOpenVisit_(device.HubID, data.BeneficiaryID, identity);

  var created = DB.insert(COMPUTER_SESSIONS_TABLE, {
    VisitID: visitId, BeneficiaryID: data.BeneficiaryID, HubID: device.HubID, ComputerID: data.ComputerID,
    LoginTime: clientCapturedAt, LogoutTime: '', DurationMinutes: '', DurationEstimated: false,
    ActivityID: data.ActivityID || '', ProjectID: '', Status: 'Open', IdleMinutes: '', EntryMethod: 'AGENT',
    ClientUUID: record.client_uuid, DeviceID: device.DeviceID, ClientCapturedAt: clientCapturedAt,
    ServerReceivedAt: serverReceivedAt, NormalizedTime: clientCapturedAt, SyncStatus: 'Synced',
    CreatedByEmail: identity.email, CreatedByRole: identity.role
  });
  return { client_uuid: record.client_uuid, status: 'ok', canonical_id: created.SessionID, issues: [] };
}

function syncSessionLogout_(record, device) {
  var data = record.payload || {};
  var session = data.SessionID ? DB.getById(COMPUTER_SESSIONS_TABLE, data.SessionID) : findByClientUuid_(COMPUTER_SESSIONS_TABLE, data.loginClientUuid);
  if (!session || session.HubID !== device.HubID) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Matching open session not found.'] };
  if (session.Status !== 'Open') return { client_uuid: record.client_uuid, status: 'duplicate', canonical_id: session.SessionID, issues: [] };

  var logoutTime = data.logoutTime || new Date().toISOString();
  var loginDate = new Date(session.LoginTime);
  var logoutDate = new Date(logoutTime);
  var minutes = Math.round((logoutDate.getTime() - loginDate.getTime()) / 60000);
  if (minutes < 0) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Logout time is before login time.'] };

  DB.update(COMPUTER_SESSIONS_TABLE, session.SessionID, {
    LogoutTime: logoutTime, DurationMinutes: minutes, Status: 'Closed', ServerReceivedAt: new Date().toISOString()
  });
  updateComputerLastActive_(session.ComputerID);
  closeAutoVisitIfSessionsDone_(session.VisitID, logoutTime);
  return { client_uuid: record.client_uuid, status: 'ok', canonical_id: session.SessionID, issues: [] };
}

/**
 * BeneficiaryID is optional here (unlike visit/session) — feedback left
 * anonymously, or right as someone's finishing up and doesn't want to
 * attach their name, is still worth capturing.
 */
function syncFeedback_(record, device) {
  var existing = findByClientUuid_(FEEDBACK_TABLE, record.client_uuid);
  if (existing) return { client_uuid: record.client_uuid, status: 'duplicate', canonical_id: existing.FeedbackID, issues: [] };

  var data = record.payload || {};
  var message = String(data.Message || '').trim();
  if (!message) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Feedback message is required.'] };

  var created = DB.insert(FEEDBACK_TABLE, {
    BeneficiaryID: data.BeneficiaryID || '', HubID: device.HubID, Message: message, Rating: data.Rating || '',
    CreatedByEmail: 'device:' + device.DeviceID, CreatedByRole: 'Device',
    ClientUUID: record.client_uuid, DeviceID: device.DeviceID, SyncStatus: 'Synced'
  });

  var hubName = hubNameLookup_()[device.HubID] || device.HubID;
  var ratingNum = Number(data.Rating) || 0;
  var stars = ratingNum ? ' (' + ratingNum + '★)' : '';
  notify_({
    type: 'FeedbackReceived', severity: 'info',
    message: 'New feedback' + stars + ' left at ' + hubName + '.',
    targetRole: 'HubManager', targetHubId: device.HubID, relatedTable: FEEDBACK_TABLE, relatedRecordId: created.FeedbackID
  });
  // A low rating is worth an Admin's attention too, not just the hub's own manager.
  if (ratingNum > 0 && ratingNum <= 2) {
    notify_({
      type: 'LowFeedbackRating', severity: 'warning',
      message: 'Low feedback rating (' + ratingNum + '★) received at ' + hubName + ' — may need attention.',
      targetRole: 'Admin', targetAccessLevels: ME_ACCESS_LEVELS, relatedTable: FEEDBACK_TABLE, relatedRecordId: created.FeedbackID
    });
  }

  return { client_uuid: record.client_uuid, status: 'ok', canonical_id: created.FeedbackID, issues: [] };
}

/**
 * A beneficiary editing their own profile from the PWA (name, contact
 * info, and optionally a photo). Updates the existing Beneficiaries row
 * in place — there's no separate "profile" table. Not idempotency-
 * checked via ClientUUID like other sync types (that column on
 * Beneficiaries holds the ORIGINAL registration's uuid, not this
 * update's), so a retried/duplicated sync just reapplies the same field
 * values again — harmless except a photo re-upload would create a spare
 * Drive file, an acceptable edge case for a low-frequency, user-editable
 * action.
 */
function syncProfileUpdate_(record, device) {
  var data = record.payload || {};
  var beneficiaryId = data.BeneficiaryID;
  var beneficiary = beneficiaryId ? DB.getById('Beneficiaries', beneficiaryId) : null;
  if (!beneficiary) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Beneficiary not found.'] };
  if (beneficiary.HomeHubID !== device.HubID) return { client_uuid: record.client_uuid, status: 'error', canonical_id: null, issues: ['Beneficiary not found for this Hub.'] };

  var updates = {};
  var f = data.Fields || {};
  ['FirstName', 'LastName', 'Gender', 'Country', 'Region', 'Community', 'EducationLevel', 'Occupation', 'UserCategory', 'Phone', 'Email', 'DisabilityInfo'].forEach(function (key) {
    if (f[key] !== undefined) updates[key] = String(f[key]).trim();
  });
  if (f.Age !== undefined && f.Age !== '') {
    var age = Number(f.Age);
    if (!isNaN(age)) { updates.Age = age; updates.AgeGroup = mapAgeToBand_(age); }
  }
  if (updates.LastName) updates.SurnameInitial = updates.LastName.charAt(0).toUpperCase();

  if (data.PhotoBase64) {
    // Deliberately NOT wrapped in a try/catch that swallows the error —
    // an earlier version did that, and a Drive upload failure (e.g. the
    // Drive OAuth scope not yet granted — see AIAnalytics.gs's UrlFetchApp
    // for the same class of issue) then silently reported this whole sync
    // as 'ok' with nothing actually saved, leaving the beneficiary with no
    // photo and no error anywhere. Letting it throw here means
    // processSyncRecord_'s catch turns it into a real 'error' response
    // with the underlying message, AND the record stays queued for retry
    // on the PWA — so once Drive access is actually authorized, the next
    // sync picks the photo back up with no re-upload needed.
    var bytes = Utilities.base64Decode(data.PhotoBase64);
    var blob = Utilities.newBlob(bytes, data.PhotoMimeType || 'image/jpeg', beneficiaryId + '.jpg');
    var file = DriveApp.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    // Drive's "uc?export=view" link (used previously) frequently fails to
    // render as a raw <img> — Google has gotten stricter about hotlinking
    // it and it can serve an HTML interstitial instead of image bytes.
    // The /thumbnail endpoint is Drive's own purpose-built embed link and
    // reliably returns actual image data for anyone-with-link files.
    updates.PhotoUrl = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w400';
  }

  if (!Object.keys(updates).length) {
    return { client_uuid: record.client_uuid, status: 'ok', canonical_id: beneficiaryId, issues: [] };
  }

  var updated = DB.update('Beneficiaries', beneficiaryId, updates);
  return { client_uuid: record.client_uuid, status: 'ok', canonical_id: updated.BeneficiaryID, issues: [] };
}

/**
 * One-time cleanup: rewrites any Beneficiaries.PhotoUrl still using the
 * old "uc?export=view" link format (broken/unreliable as an <img> src)
 * to the new "/thumbnail" format — same file, just a different URL
 * shape. Run once from the editor after deploying the URL format fix;
 * safe to run more than once (no-ops on rows already migrated).
 */
function migrateOldPhotoUrls() {
  var all = DB.getAll('Beneficiaries');
  var fixed = 0;
  all.forEach(function (b) {
    var match = /drive\.google\.com\/uc\?export=view&id=([^&]+)/.exec(b.PhotoUrl || '');
    if (!match) return;
    DB.update('Beneficiaries', b.BeneficiaryID, { PhotoUrl: 'https://drive.google.com/thumbnail?id=' + match[1] + '&sz=w400' });
    fixed++;
  });
  Logger.log('Migrated ' + fixed + ' photo URL(s).');
}

// ---------- Device provisioning (Admin) ----------

/** Admin: provisions a new sync device, returning its API key ONCE — same pattern as a manager's temp password. */
function provisionSyncDevice(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var error = Validate.run([
      [Validate.required, data && data.DeviceID, 'Device ID'],
      [Validate.required, data && data.HubID, 'Hub'],
      [Validate.required, data && data.DeviceLabel, 'Device label']
    ]);
    if (error) throw new Error(error);
    if (!DB.getById('Hubs', data.HubID)) throw new Error('Hub not found.');

    var apiKey = generateRandomPassword(24);
    var salt = Utilities.getUuid();
    var record = DB.insert(SYNC_DEVICES_TABLE, {
      DeviceID: data.DeviceID, HubID: data.HubID, DeviceLabel: data.DeviceLabel.trim(),
      APIKeyHash: hashPassword(apiKey, salt), APIKeySalt: salt, Active: true, LastSyncAt: ''
    });

    logAudit_(identity, 'Create', SYNC_DEVICES_TABLE, record.DeviceID, '(record)', '', data.DeviceLabel, data.HubID);
    return { device: record, apiKey: apiKey };
  });
}

function getSyncDevices(sessionToken) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    return resolveForeignKey(DB.getAll(SYNC_DEVICES_TABLE), 'HubID', 'Hubs', 'HubName', 'HubName');
  });
}

function setSyncDeviceActive(sessionToken, deviceId, active) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    if (!DB.getById(SYNC_DEVICES_TABLE, deviceId)) throw new Error('Device not found.');
    return DB.update(SYNC_DEVICES_TABLE, deviceId, { Active: !!active });
  });
}

function getSyncLogs(sessionToken, options) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(SYNC_LOGS_TABLE);
    return paginateAndFilter(all, {
      sortBy: 'ReceivedAt', sortDir: 'desc',
      page: (options && options.page) || 1, pageSize: (options && options.pageSize) || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}
