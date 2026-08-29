/**
 * ============================================================
 * ACTIVITYSESSIONS.GS — Hub-Manager-opened group activity sessions
 * ============================================================
 * A Hub Manager opens a session against one of the existing Activities
 * (Activities.gs) so beneficiaries can one-tap "join" it from the PWA
 * (see Sync.gs's syncSessionJoin_) instead of each individually ticking
 * it on their own visit form. Every join is still its own
 * BeneficiaryVisits row (SessionID set, VisitActivities.VisitType =
 * 'Session') — this tracks attendance at a scheduled Activity instance,
 * not a "group" as an entity; see Config.gs's ActivitySessions/
 * VisitActivities comments for why that distinction matters here.
 *
 * Closing a session bulk-sets DepartureTime (DepartureEstimated: true)
 * on every still-open linked visit, and the PWA stops offering it as a
 * join option on its next bootstrap refresh.
 * ============================================================
 */

var ACTIVITY_SESSIONS_TABLE = 'ActivitySessions';

/** Hub Manager: today's sessions for their own hub (open + closed), each with a live attendee count. */
function getMyHubActivitySessions(sessionToken) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    return activitySessionsForHub_(identity.hubId);
  });
}

/** Admin: any hub's sessions (or every hub's, if hubId is omitted), for the read-only oversight view. */
function getActivitySessionsForAdmin(sessionToken, hubId) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    return activitySessionsForHub_(hubId || null);
  });
}

/**
 * Everyone who has ever joined a session (still in, or already checked
 * out) — Admin can view any session, a Hub Manager only their own hub's.
 * Name is "FirstName Initial." to match the app's privacy convention
 * everywhere else, not the beneficiary's full last name.
 */
function getActivitySessionAttendees(sessionToken, sessionId) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var session = DB.getById(ACTIVITY_SESSIONS_TABLE, sessionId);
    if (!session) throw new Error('Session not found.');
    if (identity.role === 'HubManager' && session.HubID !== identity.hubId) throw new Error('Session not found.');

    var beneficiaries = {};
    DB.getAll('Beneficiaries').forEach(function (b) { beneficiaries[b.BeneficiaryID] = b; });

    return DB.getAll(BENEFICIARY_VISITS_TABLE)
      .filter(function (v) { return v.SessionID === sessionId; })
      .map(function (v) {
        var b = beneficiaries[v.BeneficiaryID];
        return {
          beneficiaryId: v.BeneficiaryID,
          name: b ? (b.FirstName + ' ' + (b.SurnameInitial ? b.SurnameInitial + '.' : '')).trim() : '(unknown)',
          arrivalTime: v.ArrivalTime,
          stillIn: !v.DepartureTime
        };
      })
      .sort(function (a, b) { return a.arrivalTime < b.arrivalTime ? -1 : 1; });
  });
}

/** hubId null/omitted returns sessions across every hub (Admin's global view). */
function activitySessionsForHub_(hubId) {
  var sessions = DB.getAll(ACTIVITY_SESSIONS_TABLE).filter(function (s) { return !hubId || s.HubID === hubId; });
  resolveForeignKey(sessions, 'ActivityID', 'Activities', 'Name', 'ActivityName');
  resolveForeignKey(sessions, 'HubID', 'Hubs', 'HubName', 'HubName');

  var visits = DB.getAll(BENEFICIARY_VISITS_TABLE);
  return sessions
    .map(function (s) {
      var linked = visits.filter(function (v) { return v.SessionID === s.SessionID; });
      return withField_(s, {
        totalAttendance: linked.length,
        currentlyIn: linked.filter(function (v) { return !v.DepartureTime; }).length
      });
    })
    .sort(function (a, b) { return String(b.OpenedAt).localeCompare(String(a.OpenedAt)); });
}

function openActivitySession(sessionToken, activityId) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    var activity = DB.getById('Activities', activityId);
    if (!activity || (activity.Active !== true && activity.Active !== 'true')) {
      throw new Error('Activity not found or inactive.');
    }

    var record = DB.insert(ACTIVITY_SESSIONS_TABLE, {
      HubID: identity.hubId, ActivityID: activityId, Status: 'Open',
      OpenedAt: new Date().toISOString(), ClosedAt: '',
      OpenedByEmail: identity.email, ClosedByEmail: ''
    });
    return withField_(record, { ActivityName: activity.Name });
  });
}

/**
 * Closes a session and bulk-closes every still-open linked visit.
 * DepartureEstimated: true throughout — a bulk close approximates each
 * person's departure at the moment the session ended, it isn't
 * individually reported the way a normal visit's departure is.
 */
function closeActivitySession(sessionToken, sessionId) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    var session = DB.getById(ACTIVITY_SESSIONS_TABLE, sessionId);
    if (!session) throw new Error('Session not found.');
    if (session.HubID !== identity.hubId) throw new Error('Session not found.');
    if (session.Status !== 'Open') throw new Error('This session is already closed.');

    var now = new Date();
    var closeTimeHHmm = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm');

    var openVisits = DB.getAll(BENEFICIARY_VISITS_TABLE).filter(function (v) {
      return v.SessionID === sessionId && !v.DepartureTime;
    });
    openVisits.forEach(function (v) {
      var duration = computeVisitDuration_(v.ArrivalTime, closeTimeHHmm);
      DB.update(BENEFICIARY_VISITS_TABLE, v.VisitID, {
        DepartureTime: closeTimeHHmm,
        DurationMinutes: duration.error ? '' : duration.minutes,
        DepartureEstimated: true
      });
    });

    var updated = DB.update(ACTIVITY_SESSIONS_TABLE, sessionId, {
      Status: 'Closed', ClosedAt: now.toISOString(), ClosedByEmail: identity.email
    });
    return withField_(updated, { closedVisitCount: openVisits.length });
  });
}

/** Admin-only safety valve for a session a Hub Manager forgot to close. */
function forceCloseActivitySession(sessionToken, sessionId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var session = DB.getById(ACTIVITY_SESSIONS_TABLE, sessionId);
    if (!session) throw new Error('Session not found.');
    if (session.Status !== 'Open') throw new Error('This session is already closed.');

    var now = new Date();
    var closeTimeHHmm = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm');
    var openVisits = DB.getAll(BENEFICIARY_VISITS_TABLE).filter(function (v) {
      return v.SessionID === sessionId && !v.DepartureTime;
    });
    openVisits.forEach(function (v) {
      var duration = computeVisitDuration_(v.ArrivalTime, closeTimeHHmm);
      DB.update(BENEFICIARY_VISITS_TABLE, v.VisitID, {
        DepartureTime: closeTimeHHmm,
        DurationMinutes: duration.error ? '' : duration.minutes,
        DepartureEstimated: true
      });
    });

    return DB.update(ACTIVITY_SESSIONS_TABLE, sessionId, {
      Status: 'Closed', ClosedAt: now.toISOString(), ClosedByEmail: identity.email
    });
  });
}

/** Internal: {sessionId, activityId, activityName} for every currently-open session at a Hub — feeds the PWA bootstrap payload. */
function getOpenActivitySessionsForBootstrap_(hubId) {
  var activityNames = {};
  DB.getAll('Activities').forEach(function (a) { activityNames[a.ActivityID] = a.Name; });

  return DB.getAll(ACTIVITY_SESSIONS_TABLE)
    .filter(function (s) { return s.HubID === hubId && s.Status === 'Open'; })
    .map(function (s) {
      return { sessionId: s.SessionID, activityId: s.ActivityID, activityName: activityNames[s.ActivityID] || '' };
    });
}
