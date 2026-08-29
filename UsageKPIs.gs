/**
 * ============================================================
 * USAGEKPIS.GS — KPI engine (Phase 15)
 * ============================================================
 * Implements spec §24/§25's core reach, engagement, and computer-
 * utilization KPIs. Dashboards call getHubUsageDashboard() /
 * getGlobalUsageDashboard(), which recompute-and-cache into
 * KPIResults (a delete-and-reinsert "upsert") every call, then return
 * the freshly computed numbers directly.
 *
 * Deliberate MVP choice: this is "recompute on read" rather than the
 * spec's "recompute on write" — at this project's actual data volume
 * (a handful of Hubs, MVP-scale traffic), a synchronous recompute at
 * dashboard-load time is simpler and less error-prone than adding
 * write-hooks to every insert site in Visits.gs/ComputerSessions.gs,
 * while still satisfying the real requirement
 * behind §33 (never scan raw rows *inside a rendering loop*, and
 * leave a queryable KPIResults history/cache behind).
 *
 * "Revisit this once real traffic volume makes on-read recomputation
 * too slow" (this file's own earlier note) — that point arrived:
 * computePeriodKPIsCached_() below wraps computePeriodKPIs_() with a
 * short CacheService TTL, since each dashboard load was independently
 * re-reading every row of BeneficiaryVisits/ComputerSessions/etc. from
 * scratch, TWICE (today range + month range), and the global dashboard
 * does that once per Hub on top. A short TTL (not event-driven
 * invalidation on every write) is the deliberate choice here too — it
 * keeps every write site in Visits.gs/ComputerSessions.gs/
 * ActivitySessions.gs/Sync.gs untouched and unaware caching exists,
 * at the cost of stats being up to KPI_CACHE_TTL_SECONDS stale. Actions
 * that specifically expect to see their own effect immediately (closing
 * a group session, etc.) already re-fetch right after — that first
 * post-action fetch may still show slightly-stale numbers within the
 * TTL window, which was judged an acceptable tradeoff against the
 * alternative (correctly invalidating the right cache key from every
 * one of that many write sites, a much larger and easier-to-get-wrong
 * change).
 *
 * Computer Utilization/Downtime/Availability (KPI 17/18/25) use each
 * computer's *current* Inventory status for the whole period, not a
 * reconstructed day-by-day history — see the Phase 15 plan notes for
 * why (no dated status-change history exists yet).
 * ============================================================
 */

var KPI_RESULTS_TABLE = 'KPIResults';
var KPI_CACHE_TTL_SECONDS = 45;

/**
 * Same signature/return shape as computePeriodKPIs_ — just checks
 * CacheService first. Keyed by hubId + the exact period bounds, so
 * "today" and "this month" get separate entries, and the key alone
 * (never explicitly cleared) naturally stops being reused once the day/
 * month rolls over — nothing to invalidate for that case, it just ages
 * out of relevance and a fresh key gets computed and cached instead.
 */
function computePeriodKPIsCached_(hubId, periodStart, periodEnd) {
  var cache = CacheService.getScriptCache();
  var key = 'kpi_' + hubId + '_' + periodStart + '_' + periodEnd;
  var cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  var result = computePeriodKPIs_(hubId, periodStart, periodEnd);
  cache.put(key, JSON.stringify(result), KPI_CACHE_TTL_SECONDS);
  return result;
}

/** Hub Manager: own-Hub dashboard (today + this month), recomputed fresh. */
function getHubUsageDashboard(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    return buildHubDashboard_(manager.hubId);
  });
}

/** Admin: any Hub's dashboard by ID, or the global roll-up when hubId is omitted. */
function getAdminHubUsageDashboard(sessionToken, hubId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var hub = DB.getById('Hubs', hubId);
    if (!hub) throw new Error('Hub not found.');
    var hubScope = resolveAdminHubScope_(identity);
    if (hubScope && !hubScope[hubId]) throw new Error('Hub not found.');
    return buildHubDashboard_(hubId);
  });
}

/** Admin: roll-up across every Hub visible to the caller (every Hub, or just a scoped CountryDirector's own country). */
function getGlobalUsageDashboard(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};
    var hubScope = resolveAdminHubScope_(identity);
    var hubs = applyHubScope_(DB.getAll('Hubs'), hubScope, 'HubID');
    hubs = applyHubScope_(hubs, resolveCountryFilterScope_(options.countryId), 'HubID');
    var today = new Date();
    var monthRange = periodRange_(today, 'month');

    var perHub = hubs.map(function (h) {
      var kpis = computePeriodKPIsCached_(h.HubID, monthRange.start, monthRange.end);
      return {
        hubId: h.HubID,
        hubName: h.HubName,
        uniqueUsers: kpis.uniqueHubUsers,
        totalVisits: kpis.totalHubVisits,
        computerHours: kpis.totalComputerHours,
        utilizationPct: kpis.computerUtilizationPct
      };
    });

    var totals = perHub.reduce(function (acc, h) {
      acc.uniqueUsers += h.uniqueUsers;
      acc.totalVisits += h.totalVisits;
      acc.computerHours += h.computerHours;
      return acc;
    }, { uniqueUsers: 0, totalVisits: 0, computerHours: 0 });

    var sortedByActivity = perHub.slice().sort(function (a, b) { return b.totalVisits - a.totalVisits; });
    var sortedByUtilization = perHub.slice().filter(function (h) { return h.utilizationPct !== null; }).sort(function (a, b) { return b.utilizationPct - a.utilizationPct; });

    // Distinct CountryIDs among the (possibly scoped) hubs above — not
    // uniqueCount_(DB.getAll('Countries')), which is just every
    // Country's row count org-wide and would be wrong once a scoped
    // CountryDirector's hub list has shrunk to one country's worth.
    var distinctCountryIds = {};
    hubs.forEach(function (h) { if (h.CountryID) distinctCountryIds[h.CountryID] = true; });

    return {
      periodLabel: monthRange.label,
      totalHubs: hubs.length,
      totalCountries: Object.keys(distinctCountryIds).length,
      totals: totals,
      perHub: perHub,
      mostActiveHub: sortedByActivity[0] || null,
      leastActiveHub: sortedByActivity[sortedByActivity.length - 1] || null,
      highestUtilizationHub: sortedByUtilization[0] || null,
      lowestUtilizationHub: sortedByUtilization[sortedByUtilization.length - 1] || null
    };
  });
}

function uniqueCount_(records) { return records.length; }

/** Internal: builds the full "today + this month" dashboard payload for one Hub. */
function buildHubDashboard_(hubId) {
  var today = new Date();
  var todayRange = periodRange_(today, 'day');
  var monthRange = periodRange_(today, 'month');

  var todayKpis = computePeriodKPIsCached_(hubId, todayRange.start, todayRange.end);
  var monthKpis = computePeriodKPIsCached_(hubId, monthRange.start, monthRange.end);

  cacheKpiResults_(hubId, 'Daily', todayRange, todayKpis);
  cacheKpiResults_(hubId, 'Monthly', monthRange, monthKpis);

  return { today: todayKpis, thisMonth: monthKpis, todayLabel: todayRange.label, monthLabel: monthRange.label };
}

/** Internal: {start, end, label} for 'day' | 'month' containing the given date. */
function periodRange_(date, granularity) {
  var tz = Session.getScriptTimeZone();
  if (granularity === 'day') {
    var d = Utilities.formatDate(date, tz, 'yyyy-MM-dd');
    return { start: d, end: d, label: d };
  }
  var start = new Date(date.getFullYear(), date.getMonth(), 1);
  var end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return {
    start: Utilities.formatDate(start, tz, 'yyyy-MM-dd'),
    end: Utilities.formatDate(end, tz, 'yyyy-MM-dd'),
    label: Utilities.formatDate(date, tz, 'MMMM yyyy')
  };
}

/** Internal: computes every dashboard KPI for one Hub over [periodStart, periodEnd] (inclusive date strings). */
function computePeriodKPIs_(hubId, periodStart, periodEnd) {
  var visits = DB.getAll(BENEFICIARY_VISITS_TABLE).filter(function (v) { return v.HubID === hubId; });
  var visitsInPeriod = visits.filter(function (v) { return v.Date >= periodStart && v.Date <= periodEnd; });

  var beneficiaries = DB.getAll('Beneficiaries');
  var beneficiaryById = {};
  beneficiaries.forEach(function (b) { beneficiaryById[b.BeneficiaryID] = b; });

  var ageBandsResult = getAgeBandOptions();
  var youthAgeGroups = {};
  if (ageBandsResult.success) {
    ageBandsResult.data.forEach(function (a) { if (a.isYouth) youthAgeGroups[a.name] = true; });
  }

  // --- Reach & engagement ---
  var uniqueBeneficiaryIds = uniqueValues_(visitsInPeriod.map(function (v) { return v.BeneficiaryID; }));
  var uniqueHubUsers = uniqueBeneficiaryIds.length;

  var firstVisitDateByBeneficiary = {};
  visits.forEach(function (v) {
    if (!firstVisitDateByBeneficiary[v.BeneficiaryID] || v.Date < firstVisitDateByBeneficiary[v.BeneficiaryID]) {
      firstVisitDateByBeneficiary[v.BeneficiaryID] = v.Date;
    }
  });
  var newUsers = uniqueBeneficiaryIds.filter(function (id) {
    var firstDate = firstVisitDateByBeneficiary[id];
    return firstDate >= periodStart && firstDate <= periodEnd;
  }).length;
  var returningUsers = uniqueHubUsers - newUsers;

  var femaleCount = 0, youthCount = 0;
  uniqueBeneficiaryIds.forEach(function (id) {
    var b = beneficiaryById[id];
    if (!b) return;
    if (b.Gender === 'Female') femaleCount++;
    if (youthAgeGroups[b.AgeGroup]) youthCount++;
  });

  var totalHubVisits = visitsInPeriod.length;

  // --- Computer usage ---
  var sessions = DB.getAll(COMPUTER_SESSIONS_TABLE).filter(function (s) { return s.HubID === hubId; });
  var sessionsInPeriod = sessions.filter(function (s) {
    var loginDate = String(s.LoginTime).slice(0, 10);
    return loginDate >= periodStart && loginDate <= periodEnd && s.Status !== 'Invalid';
  });
  var closedSessionsInPeriod = sessionsInPeriod.filter(function (s) { return s.Status === 'Closed'; });

  var computerUsers = uniqueValues_(sessionsInPeriod.map(function (s) { return s.BeneficiaryID; })).length;
  var totalSessions = sessionsInPeriod.length;
  var totalMinutes = closedSessionsInPeriod.reduce(function (sum, s) { return sum + (Number(s.DurationMinutes) || 0); }, 0);
  var totalComputerHours = Math.round((totalMinutes / 60) * 10) / 10;
  var avgSessionMinutes = closedSessionsInPeriod.length ? Math.round(totalMinutes / closedSessionsInPeriod.length) : 0;

  var computers = provisionAndGetHubComputers_(hubId);
  var availableComputers = computers.filter(function (c) { return c.Status === 'In Use'; }).length;
  var totalComputers = computers.length;
  var openHours = getHubOpenHours_(hubId, periodStart, periodEnd);

  var availableComputerHours = openHours.hasSchedule ? availableComputers * openHours.totalHours : null;
  var totalPossibleComputerHours = openHours.hasSchedule ? totalComputers * openHours.totalHours : null;

  var computerUtilizationPct = (availableComputerHours && availableComputerHours > 0)
    ? Math.round((totalComputerHours / availableComputerHours) * 1000) / 10 : null;
  var computerAvailabilityPct = (totalPossibleComputerHours && totalPossibleComputerHours > 0)
    ? Math.round((availableComputerHours / totalPossibleComputerHours) * 1000) / 10 : null;

  // --- Training (Phase 16, spec Decision D-2: report both, participant-hours is primary) ---
  var trainingSessions = DB.getAll(TRAINING_SESSIONS_TABLE).filter(function (s) {
    return s.HubID === hubId && s.Date >= periodStart && s.Date <= periodEnd;
  });
  var attendance = DB.getAll(ATTENDANCE_TABLE);
  var trainingParticipantIds = {};
  var trainingHoursParticipant = 0;
  var trainingHoursDelivered = 0;
  trainingSessions.forEach(function (session) {
    var durationHours = trainingSessionDurationMinutes_(session) / 60;
    trainingHoursDelivered += durationHours;
    var presentAttendees = attendance.filter(function (a) {
      return a.TrainingSessionID === session.TrainingSessionID && (a.Present === true || a.Present === 'true');
    });
    presentAttendees.forEach(function (a) { trainingParticipantIds[a.BeneficiaryID] = true; });
    trainingHoursParticipant += durationHours * presentAttendees.length;
  });

  return {
    uniqueHubUsers: uniqueHubUsers,
    newUsers: newUsers,
    returningUsers: returningUsers,
    returningUserRatePct: uniqueHubUsers ? Math.round((returningUsers / uniqueHubUsers) * 100) : null,
    femalePct: uniqueHubUsers ? Math.round((femaleCount / uniqueHubUsers) * 100) : null,
    youthPct: uniqueHubUsers ? Math.round((youthCount / uniqueHubUsers) * 100) : null,
    totalHubVisits: totalHubVisits,
    avgVisitsPerBeneficiary: uniqueHubUsers ? Math.round((visitsInPeriod.length / uniqueHubUsers) * 10) / 10 : null,
    computerUsers: computerUsers,
    totalComputerSessions: totalSessions,
    totalComputerHours: totalComputerHours,
    avgSessionMinutes: avgSessionMinutes,
    totalComputers: totalComputers,
    availableComputers: availableComputers,
    computerUtilizationPct: computerUtilizationPct,
    computerAvailabilityPct: computerAvailabilityPct,
    utilizationInputs: {
      hasSchedule: openHours.hasSchedule,
      hoursPerOpenDay: openHours.hoursPerOpenDay,
      openDaysCount: openHours.openDaysCount,
      holidayDaysExcluded: openHours.holidayDaysExcluded
    },
    trainingParticipants: Object.keys(trainingParticipantIds).length,
    trainingHoursParticipant: Math.round(trainingHoursParticipant * 10) / 10,
    trainingHoursDelivered: Math.round(trainingHoursDelivered * 10) / 10
  };
}

function uniqueValues_(arr) {
  var seen = {};
  var out = [];
  arr.forEach(function (v) {
    if (!v || seen[v]) return;
    seen[v] = true;
    out.push(v);
  });
  return out;
}

/** Internal: replaces any cached rows for this Hub/period with fresh values. */
function cacheKpiResults_(hubId, periodType, range, kpis) {
  var existing = DB.getAll(KPI_RESULTS_TABLE).filter(function (r) {
    return r.Level === 'Hub' && r.ScopeID === hubId && r.PeriodType === periodType && r.PeriodStart === range.start;
  });
  existing.forEach(function (r) { DB.remove(KPI_RESULTS_TABLE, r.KPIResultID); });

  var now = new Date().toISOString();
  var codesToStore = ['uniqueHubUsers', 'totalHubVisits', 'newUsers', 'returningUsers', 'totalComputerSessions', 'totalComputerHours', 'computerUtilizationPct', 'trainingParticipants', 'trainingHoursParticipant'];
  codesToStore.forEach(function (code) {
    if (kpis[code] === null || kpis[code] === undefined) return;
    DB.insert(KPI_RESULTS_TABLE, {
      KPICode: code, Level: 'Hub', ScopeID: hubId, PeriodType: periodType,
      PeriodStart: range.start, PeriodEnd: range.end, Value: kpis[code], Numerator: '', Denominator: '', ComputedAt: now
    });
  });
}
