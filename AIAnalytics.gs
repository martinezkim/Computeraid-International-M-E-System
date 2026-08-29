/**
 * ============================================================
 * AIANALYTICS.GS — AI-generated usage narratives (Phase 16)
 * ============================================================
 * Spec §27. Inputs are aggregate KPI numbers only — built from
 * UsageKPIs.gs's computePeriodKPIs_(), never row-level PII. Anomaly
 * detection is deterministic (period-over-period % change), computed
 * before any LLM call — the spec's own stated preference over asking
 * an LLM to spot anomalies. Every narrative is stored with
 * Reviewed=false and the exact numbers it was generated from, so an
 * Admin can verify before treating it as usable externally.
 *
 * Requires a Script Property named ANTHROPIC_API_KEY, set once by an
 * Admin directly in the Apps Script editor's Project Settings ->
 * Script properties — never hardcoded in source.
 * ============================================================
 */

var AI_INSIGHTS_TABLE = 'AIInsights';
var ANOMALY_THRESHOLD_PCT = 30;
var CLAUDE_MODEL = 'claude-sonnet-5';

/** Admin: generates (and stores) a narrative for one Hub's current month vs. last month. */
function generateHubInsight(sessionToken, hubId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var hub = DB.getById('Hubs', hubId);
    if (!hub) throw new Error('Hub not found.');

    var now = new Date();
    var prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var currentRange = periodRange_(now, 'month');
    var previousRange = periodRange_(prevMonthDate, 'month');

    var currentKpis = computePeriodKPIs_(hubId, currentRange.start, currentRange.end);
    var previousKpis = computePeriodKPIs_(hubId, previousRange.start, previousRange.end);
    var anomalies = detectAnomalies_(currentKpis, previousKpis);

    var payload = {
      hubName: hub.HubName,
      periodLabel: currentRange.label,
      previousPeriodLabel: previousRange.label,
      kpis: currentKpis,
      previousKpis: previousKpis,
      anomalies: anomalies
    };

    var narrative = callClaudeForNarrative_(buildHubPrompt_(payload));

    var record = DB.insert(AI_INSIGHTS_TABLE, {
      Level: 'Hub', ScopeID: hubId, PeriodType: 'Monthly',
      PeriodStart: currentRange.start, PeriodEnd: currentRange.end,
      NarrativeText: narrative, InputDataJSON: JSON.stringify(payload), AnomalyFlags: JSON.stringify(anomalies),
      GeneratedAt: new Date().toISOString(), Reviewed: false, ReviewedByEmail: '', ReviewedAt: ''
    });

    logAudit_(identity, 'Create', AI_INSIGHTS_TABLE, record.InsightID, '(record)', '', 'AI insight for ' + hub.HubName + ' — ' + currentRange.label, hubId);
    return record;
  });
}

/** Admin: generates (and stores) a global narrative for the current month vs. last month. */
function generateGlobalInsight(sessionToken) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var now = new Date();
    var prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var currentRange = periodRange_(now, 'month');
    var previousRange = periodRange_(prevMonthDate, 'month');

    var hubs = DB.getAll('Hubs');
    var currentTotals = sumKpisAcrossHubs_(hubs, currentRange);
    var previousTotals = sumKpisAcrossHubs_(hubs, previousRange);
    var anomalies = detectAnomalies_(currentTotals, previousTotals);

    var payload = {
      totalHubs: hubs.length,
      periodLabel: currentRange.label,
      previousPeriodLabel: previousRange.label,
      kpis: currentTotals,
      previousKpis: previousTotals,
      anomalies: anomalies
    };

    var narrative = callClaudeForNarrative_(buildGlobalPrompt_(payload));

    var record = DB.insert(AI_INSIGHTS_TABLE, {
      Level: 'Global', ScopeID: '', PeriodType: 'Monthly',
      PeriodStart: currentRange.start, PeriodEnd: currentRange.end,
      NarrativeText: narrative, InputDataJSON: JSON.stringify(payload), AnomalyFlags: JSON.stringify(anomalies),
      GeneratedAt: new Date().toISOString(), Reviewed: false, ReviewedByEmail: '', ReviewedAt: ''
    });

    logAudit_(identity, 'Create', AI_INSIGHTS_TABLE, record.InsightID, '(record)', '', 'Global AI insight — ' + currentRange.label, '');
    return record;
  });
}

function sumKpisAcrossHubs_(hubs, range) {
  var sums = { uniqueHubUsers: 0, totalHubVisits: 0, totalComputerHours: 0, totalComputerSessions: 0, trainingParticipants: 0 };
  hubs.forEach(function (h) {
    var k = computePeriodKPIs_(h.HubID, range.start, range.end);
    sums.uniqueHubUsers += k.uniqueHubUsers;
    sums.totalHubVisits += k.totalHubVisits;
    sums.totalComputerHours += k.totalComputerHours;
    sums.totalComputerSessions += k.totalComputerSessions;
    sums.trainingParticipants += k.trainingParticipants;
  });
  return sums;
}

/** Internal: deterministic period-over-period anomaly flags — no LLM involved. */
function detectAnomalies_(current, previous) {
  var anomalies = [];
  ['uniqueHubUsers', 'totalHubVisits', 'totalComputerHours', 'computerUtilizationPct', 'trainingParticipants'].forEach(function (field) {
    var curr = current[field], prev = previous[field];
    if (curr === null || curr === undefined || prev === null || prev === undefined || prev === 0) return;
    var pctChange = Math.round(((curr - prev) / prev) * 100);
    if (Math.abs(pctChange) >= ANOMALY_THRESHOLD_PCT) {
      anomalies.push({ field: field, current: curr, previous: prev, pctChange: pctChange, direction: pctChange > 0 ? 'increase' : 'decrease' });
    }
  });
  return anomalies;
}

function buildHubPrompt_(payload) {
  return 'You are drafting a short M&E usage summary for one Solar Community Hub, for internal review before any external use. ' +
    'Use ONLY the aggregate numbers given below — do not invent any figures, names, or details not present here. ' +
    'Write 3-4 short paragraphs: (1) reach/engagement this period, (2) computer utilization, (3) notable changes vs. last period (reference the anomalies list if non-empty), (4) one or two grounded, practical suggestions. ' +
    'Plain, factual tone — no hype. Data:\n\n' + JSON.stringify(payload, null, 2);
}

function buildGlobalPrompt_(payload) {
  return 'You are drafting a short global M&E usage summary across all Solar Community Hubs, for internal review before any external use. ' +
    'Use ONLY the aggregate numbers given below — do not invent any figures, names, or details not present here. ' +
    'Write 3-4 short paragraphs: (1) overall reach this period, (2) computer utilization, (3) notable changes vs. last period (reference the anomalies list if non-empty), (4) one or two grounded, practical observations for leadership. ' +
    'Plain, factual tone — no hype. Data:\n\n' + JSON.stringify(payload, null, 2);
}

/** Internal: calls the Anthropic Messages API and returns the narrative text. */
function callClaudeForNarrative_(prompt) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. An Admin needs to add it once in the Apps Script editor: Project Settings -> Script properties.');
  }

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  var status = response.getResponseCode();
  var body = JSON.parse(response.getContentText());
  if (status !== 200) {
    throw new Error('AI generation failed (' + status + '): ' + (body.error && body.error.message ? body.error.message : response.getContentText()));
  }
  return body.content && body.content[0] && body.content[0].text ? body.content[0].text : '(no narrative returned)';
}

/** Admin: recent insights, optionally filtered to one Hub (blank ScopeID = global insights). */
function getAIInsights(sessionToken, hubId) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var all = DB.getAll(AI_INSIGHTS_TABLE).sort(function (a, b) { return b.GeneratedAt < a.GeneratedAt ? -1 : 1; });
    if (hubId) return all.filter(function (i) { return i.Level === 'Hub' && i.ScopeID === hubId; });
    return all;
  });
}

function markInsightReviewed(sessionToken, insightId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    if (!DB.getById(AI_INSIGHTS_TABLE, insightId)) throw new Error('Insight not found.');
    return DB.update(AI_INSIGHTS_TABLE, insightId, {
      Reviewed: true, ReviewedByEmail: identity.email, ReviewedAt: new Date().toISOString()
    });
  });
}
