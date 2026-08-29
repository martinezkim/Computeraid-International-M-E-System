/**
 * ============================================================
 * TRAINING.GS — Training courses, sessions & attendance (Phase 16)
 * ============================================================
 * Courses are a small Admin-managed config list (same shape as
 * Activities.gs). Sessions are dated deliveries of a course at a
 * Hub; Attendance marks which Beneficiaries showed up and/or
 * completed it. Training Hours (participant vs delivered) are
 * computed in UsageKPIs.gs per spec Decision D-2, not here.
 * ============================================================
 */

var TRAINING_COURSES_TABLE = 'TrainingCourses';
var TRAINING_SESSIONS_TABLE = 'TrainingSessions';
var ATTENDANCE_TABLE = 'Attendance';

// ---------- Courses (config list, Admin-managed) ----------

function getTrainingCourses(sessionToken, options) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(TRAINING_COURSES_TABLE);
    var schema = SCHEMA[TRAINING_COURSES_TABLE];
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

/** Every active course as {id, name} pairs, for the session-recording dropdown. */
function getTrainingCourseOptions() {
  return safeExecute(function () {
    var all = DB.getAll(TRAINING_COURSES_TABLE);
    return all
      .filter(function (c) { return c.Active === true || c.Active === 'true'; })
      .sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
      .map(function (c) { return { id: c.CourseID, name: c.Name }; });
  });
}

function addTrainingCourse(sessionToken, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateTrainingCourseInput(data);
    if (error) throw new Error(error);
    return DB.insert(TRAINING_COURSES_TABLE, {
      Name: data.Name.trim(),
      Category: (data.Category || '').trim(),
      Active: data.Active !== false,
      SortOrder: Number(data.SortOrder) || 0
    });
  });
}

function updateTrainingCourse(sessionToken, id, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateTrainingCourseInput(data);
    if (error) throw new Error(error);
    return DB.update(TRAINING_COURSES_TABLE, id, {
      Name: data.Name.trim(),
      Category: (data.Category || '').trim(),
      Active: !!data.Active,
      SortOrder: Number(data.SortOrder) || 0
    });
  });
}

function deleteTrainingCourse(sessionToken, id) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    if (DB.hasDependents(TRAINING_COURSES_TABLE, id, TRAINING_SESSIONS_TABLE, 'CourseID')) {
      throw new Error('Cannot delete this course: it already has training sessions recorded against it. Mark it Inactive instead.');
    }
    DB.remove(TRAINING_COURSES_TABLE, id);
    return true;
  });
}

function validateTrainingCourseInput(data) {
  return Validate.run([
    [Validate.required, data && data.Name, 'Name'],
    [Validate.maxLength, data && data.Name, 100, 'Name'],
    [Validate.maxLength, data && data.Category, 50, 'Category']
  ]);
}

// ---------- Sessions ----------

/** Records a training session. HubID always resolved server-side for a Hub Manager. */
function recordTrainingSession(sessionToken, data) {
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
      throw new Error('You do not have permission to record a training session.');
    }

    var error = validateTrainingSessionInput(data);
    if (error) throw new Error(error);
    if (!DB.getById(TRAINING_COURSES_TABLE, data.CourseID)) throw new Error('Training course not found.');

    var record = DB.insert(TRAINING_SESSIONS_TABLE, {
      CourseID: data.CourseID,
      HubID: hubId,
      Date: data.Date,
      StartTime: data.StartTime,
      EndTime: data.EndTime,
      TrainerName: String(data.TrainerName || '').trim(),
      PlannedParticipants: Number(data.PlannedParticipants) || 0,
      Notes: String(data.Notes || '').trim(),
      CreatedByEmail: identity.email,
      CreatedByRole: identity.role
    });

    logAudit_(identity, 'Create', TRAINING_SESSIONS_TABLE, record.TrainingSessionID, '(record)', '',
      'Training session for ' + data.CourseID + ' on ' + record.Date, hubId);

    return record;
  });
}

function validateTrainingSessionInput(data) {
  var error = Validate.run([
    [Validate.required, data && data.CourseID, 'Course'],
    [Validate.required, data && data.Date, 'Date'],
    [Validate.required, data && data.StartTime, 'Start time'],
    [Validate.required, data && data.EndTime, 'End time'],
    [Validate.maxLength, data && data.TrainerName, 100, 'Trainer name'],
    [Validate.maxLength, data && data.Notes, 500, 'Notes']
  ]);
  if (error) return error;

  var startMin = timeToMinutes_(data.StartTime);
  var endMin = timeToMinutes_(data.EndTime);
  if (startMin === null || endMin === null) return 'Start/end time must be in HH:MM format.';
  if (endMin <= startMin) return 'End time must be after start time.';
  return null;
}

/** Session duration in minutes — used by both attendance-marking and the KPI engine. */
function trainingSessionDurationMinutes_(session) {
  var startMin = timeToMinutes_(session.StartTime);
  var endMin = timeToMinutes_(session.EndTime);
  if (startMin === null || endMin === null) return 0;
  return Math.max(0, endMin - startMin);
}

/** Hub Manager: their own Hub's training sessions, with course name resolved. */
function getMyHubTrainingSessions(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};
    var all = DB.getAll(TRAINING_SESSIONS_TABLE).filter(function (s) { return s.HubID === manager.hubId; });
    all = resolveForeignKey(all, 'CourseID', TRAINING_COURSES_TABLE, 'Name', 'CourseName');
    all = attachAttendanceCounts_(all);

    var schema = SCHEMA[TRAINING_SESSIONS_TABLE];
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

/** Admin: every Hub's training sessions, optionally filtered to one Hub. */
function getAllTrainingSessions(sessionToken, options) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    options = options || {};
    var all = DB.getAll(TRAINING_SESSIONS_TABLE);
    if (options.hubId) all = all.filter(function (s) { return s.HubID === options.hubId; });
    all = resolveForeignKey(all, 'HubID', 'Hubs', 'HubName', 'HubName');
    all = resolveForeignKey(all, 'CourseID', TRAINING_COURSES_TABLE, 'Name', 'CourseName');
    all = attachAttendanceCounts_(all);

    var schema = SCHEMA[TRAINING_SESSIONS_TABLE];
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

function attachAttendanceCounts_(sessions) {
  var attendance = DB.getAll(ATTENDANCE_TABLE);
  var countsBySession = {};
  attendance.forEach(function (a) {
    if (!countsBySession[a.TrainingSessionID]) countsBySession[a.TrainingSessionID] = { present: 0, completed: 0 };
    if (a.Present === true || a.Present === 'true') countsBySession[a.TrainingSessionID].present++;
    if (a.Completed === true || a.Completed === 'true') countsBySession[a.TrainingSessionID].completed++;
  });
  sessions.forEach(function (s) {
    var counts = countsBySession[s.TrainingSessionID] || { present: 0, completed: 0 };
    s.PresentCount = counts.present;
    s.CompletedCount = counts.completed;
  });
  return sessions;
}

// ---------- Attendance ----------

/**
 * Marks attendance for a session in one call: attendees = array of
 * {BeneficiaryID, Present, Completed}. Replaces any existing
 * Attendance rows for this session (simplest correct behavior for a
 * "check off who showed up" UI — re-marking is just re-submitting).
 */
function markAttendance(sessionToken, trainingSessionId, attendees) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var session = DB.getById(TRAINING_SESSIONS_TABLE, trainingSessionId);
    if (!session) throw new Error('Training session not found.');
    if (identity.role === 'HubManager' && session.HubID !== identity.hubId) throw new Error('Training session not found.');

    var existing = DB.getAll(ATTENDANCE_TABLE).filter(function (a) { return a.TrainingSessionID === trainingSessionId; });
    existing.forEach(function (a) { DB.remove(ATTENDANCE_TABLE, a.AttendanceID); });

    var created = (attendees || []).map(function (att) {
      if (!DB.getById('Beneficiaries', att.BeneficiaryID)) throw new Error('Beneficiary not found: ' + att.BeneficiaryID);
      return DB.insert(ATTENDANCE_TABLE, {
        TrainingSessionID: trainingSessionId,
        BeneficiaryID: att.BeneficiaryID,
        VisitID: '',
        Present: !!att.Present,
        Completed: !!att.Completed
      });
    });

    logAudit_(identity, 'Update', TRAINING_SESSIONS_TABLE, trainingSessionId, 'Attendance', existing.length + ' prior', created.length + ' marked', session.HubID);
    return created;
  });
}

/** The current attendance list for a session, with beneficiary names resolved. */
function getSessionAttendance(sessionToken, trainingSessionId) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var session = DB.getById(TRAINING_SESSIONS_TABLE, trainingSessionId);
    if (!session) throw new Error('Training session not found.');
    if (identity.role === 'HubManager' && session.HubID !== identity.hubId) throw new Error('Training session not found.');

    var all = DB.getAll(ATTENDANCE_TABLE).filter(function (a) { return a.TrainingSessionID === trainingSessionId; });
    return resolveForeignKey(all, 'BeneficiaryID', 'Beneficiaries', 'FirstName', 'BeneficiaryFirstName');
  });
}
