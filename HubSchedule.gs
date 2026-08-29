/**
 * ============================================================
 * HUBSCHEDULE.GS — Hub open-hours config + holidays (Phase 15)
 * ============================================================
 * Admin-managed, one schedule row per Hub (MVP simplification —
 * see the Phase 15 plan notes: a per-weekday schedule was judged
 * unnecessary admin overhead for a first pass). Feeds the
 * Computer Utilization Rate denominator (spec §25 KPI 17) via
 * getHubOpenHours_(), the only function other modules should call
 * — nothing else should re-derive open hours independently.
 * ============================================================
 */

var HUB_SCHEDULE_TABLE = 'HubSchedule';
var HUB_HOLIDAYS_TABLE = 'HubHolidays';

/**
 * Force-writes known-correct "HH:mm" values into a row's cells as Plain
 * Text, bypassing Sheets' auto-detection entirely.
 *
 * Takes the values as a plain object (the ORIGINAL, still-trusted values
 * from before any write happened) rather than reading them off the
 * just-inserted record — that distinction is the actual fix here. Sheets
 * auto-detects a plain "09:00" string as a time-of-day value the moment
 * DB.insert's appendRow writes it, silently converting the cell to a
 * date serial (stamped with Sheets' 1899-12-30 epoch). DB.insert's own
 * getById() then reads that cell straight back — and that round-trip
 * (Sheets' serial encoding + Database.gs's UTC-based decode) does not
 * always come back as the original "09:00"; it was observed coming back
 * as "06:32", a full save-load cycle before this function even runs. The
 * previous version of this function trusted that already-corrupted
 * re-read (`record[field]`) and wrote it back as "permanent" plain text
 * — reliably preventing any FUTURE corruption while baking in the
 * corruption that had already happened on THIS save. Always pass the
 * original form values here, not a post-insert re-read of them.
 */
function forceTimeCellsAsPlainText_(rowIndex, values) {
  var schema = SCHEMA[HUB_SCHEDULE_TABLE];
  var sheet = DB.getSheet(HUB_SCHEDULE_TABLE);
  Object.keys(values).forEach(function (field) {
    var colIndex = schema.columns.indexOf(field) + 1;
    if (colIndex < 1) return;
    var range = sheet.getRange(rowIndex, colIndex);
    range.setNumberFormat('@').setValue(String(values[field]));
  });
}

/** Admin: every Hub's schedule, with HubName resolved for display. */
function getHubSchedules(sessionToken) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(HUB_SCHEDULE_TABLE);
    return resolveForeignKey(all, 'HubID', 'Hubs', 'HubName', 'HubName');
  });
}

/** Internal: the raw schedule row for one Hub, or null if never configured. Picks the LAST match (most recently saved) in case a stale duplicate row is still lingering for this Hub. */
function getHubScheduleForHub_(hubId) {
  var all = DB.getAll(HUB_SCHEDULE_TABLE);
  var match = all.filter(function (s) { return s.HubID === hubId; });
  return match.length ? match[match.length - 1] : null;
}

/** Admin: create or replace the one schedule row for a Hub (upsert — no history kept in MVP). */
function setHubSchedule(sessionToken, hubId, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);

    data = data || {};
    data.HubID = hubId;
    var error = validateHubScheduleInput(data);
    if (error) throw new Error(error);
    if (!DB.getById('Hubs', hubId)) throw new Error('Hub not found.');

    var record = {
      HubID: hubId,
      OpenDays: normalizeOpenDays_(data.OpenDays),
      OpenTime: String(data.OpenTime).trim(),
      CloseTime: String(data.CloseTime).trim(),
      Effective: true
    };

    // Delete-then-insert rather than find-and-update: some hubs had
    // accumulated more than one HubSchedule row (root cause unclear, but
    // once it happens the two read paths disagree on which row is "the"
    // schedule — getHubScheduleForHub_ used to update the FIRST match
    // while the table display uses the LAST — so a save would silently
    // write to a row nobody was looking at, showing a success toast while
    // the visible hours never changed). Clearing every row for this Hub
    // before inserting one fresh row makes each save self-healing instead
    // of needing a one-off cleanup pass, and keeps the single-row-per-Hub
    // invariant this function's return value already assumed.
    DB.getAll(HUB_SCHEDULE_TABLE)
      .filter(function (s) { return s.HubID === hubId; })
      .forEach(function (s) { DB.remove(HUB_SCHEDULE_TABLE, s.ScheduleID); });

    var saved = DB.insert(HUB_SCHEDULE_TABLE, record);

    // Overwrite the cells with the ORIGINAL, still-trusted OpenTime/
    // CloseTime (not saved.OpenTime/saved.CloseTime — DB.insert's own
    // read-back of what it just wrote may already be corrupted by
    // Sheets' auto-detection, see forceTimeCellsAsPlainText_'s comment).
    // Plain Text format also stops that auto-conversion from happening
    // again on any future edit of this row.
    forceTimeCellsAsPlainText_(saved._rowIndex, { OpenTime: record.OpenTime, CloseTime: record.CloseTime });
    saved.OpenTime = record.OpenTime;
    saved.CloseTime = record.CloseTime;
    return saved;
  });
}

function normalizeOpenDays_(openDays) {
  var list = Array.isArray(openDays) ? openDays : String(openDays || '').split(',');
  return list
    .map(function (d) { return Number(String(d).trim()); })
    .filter(function (d) { return !isNaN(d) && d >= 0 && d <= 6; })
    .sort(function (a, b) { return a - b; })
    .join(',');
}

function validateHubScheduleInput(data) {
  var error = Validate.run([
    [Validate.required, data && data.HubID, 'Hub'],
    [Validate.required, data && data.OpenTime, 'Opening time'],
    [Validate.required, data && data.CloseTime, 'Closing time']
  ]);
  if (error) return error;

  var days = normalizeOpenDays_(data.OpenDays);
  if (!days) return 'Select at least one open day.';

  var openMinutes = timeToMinutes_(data.OpenTime);
  var closeMinutes = timeToMinutes_(data.CloseTime);
  if (openMinutes === null || closeMinutes === null) return 'Opening/closing time must be in HH:MM format.';
  if (closeMinutes <= openMinutes) return 'Closing time must be after opening time.';

  return null;
}

function timeToMinutes_(hhmm) {
  var match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!match) return null;
  var hours = Number(match[1]);
  var minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Admin: holidays, optionally filtered to one Hub (blank HubID rows apply to every Hub). */
function getHubHolidays(sessionToken, hubId) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(HUB_HOLIDAYS_TABLE);
    if (!hubId) return all;
    return all.filter(function (h) { return !h.HubID || h.HubID === hubId; });
  });
}

function addHubHoliday(sessionToken, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = Validate.run([
      [Validate.required, data && data.Date, 'Date'],
      [Validate.required, data && data.Reason, 'Reason'],
      [Validate.maxLength, data && data.Reason, 200, 'Reason']
    ]);
    if (error) throw new Error(error);

    return DB.insert(HUB_HOLIDAYS_TABLE, {
      HubID: data.HubID || '',
      Date: data.Date,
      Reason: data.Reason.trim()
    });
  });
}

function deleteHubHoliday(sessionToken, id) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    DB.remove(HUB_HOLIDAYS_TABLE, id);
    return true;
  });
}

/**
 * Internal: total open computer-hours for one Hub between two dates
 * (inclusive), used as the Computer Utilization Rate denominator
 * (before subtracting Faulty/Offline/Maintenance time — see
 * UsageKPIs.gs). Returns null hoursPerOpenDay/totalHours when the
 * Hub has no configured schedule yet, so callers can show "not
 * configured" instead of a silently wrong 0%.
 */
function getHubOpenHours_(hubId, periodStart, periodEnd) {
  var schedule = getHubScheduleForHub_(hubId);
  if (!schedule) {
    return { hasSchedule: false, hoursPerOpenDay: null, openDaysCount: 0, holidayDaysExcluded: 0, totalHours: null };
  }

  var openWeekdays = schedule.OpenDays.split(',').map(Number);
  var openMinutes = timeToMinutes_(schedule.OpenTime);
  var closeMinutes = timeToMinutes_(schedule.CloseTime);
  var hoursPerOpenDay = (closeMinutes - openMinutes) / 60;

  var holidays = DB.getAll(HUB_HOLIDAYS_TABLE)
    .filter(function (h) { return !h.HubID || h.HubID === hubId; })
    .map(function (h) { return h.Date; });

  var openDaysCount = 0;
  var holidayDaysExcluded = 0;
  var cursor = new Date(periodStart);
  var end = new Date(periodEnd);
  while (cursor <= end) {
    var isOpenWeekday = openWeekdays.indexOf(cursor.getDay()) !== -1;
    var dateStr = Utilities.formatDate(cursor, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var isHoliday = holidays.indexOf(dateStr) !== -1;
    if (isOpenWeekday && !isHoliday) {
      openDaysCount++;
    } else if (isOpenWeekday && isHoliday) {
      holidayDaysExcluded++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    hasSchedule: true,
    hoursPerOpenDay: hoursPerOpenDay,
    openDaysCount: openDaysCount,
    holidayDaysExcluded: holidayDaysExcluded,
    totalHours: openDaysCount * hoursPerOpenDay
  };
}
