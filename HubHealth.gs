/**
 * ============================================================
 * HUBHEALTH.GS — Per-hub status metrics (reports + inventory)
 * ============================================================
 * getHubHealthMetrics_(hubId) is the one function that answers
 * "how is this hub doing" by pulling together three things that
 * previously lived in separate modules: submitted reports vs. this
 * year's reporting quotas, the hub's own equipment (Inventory.gs),
 * and its laptop resale stock (Laptops.gs). It's deliberately a
 * plain internal function (not exposed to the client directly) so
 * it can be reused anywhere a hub's status is needed — the Hubs
 * admin page, the hub detail modal, and later a Hub report or
 * AI-generated M&E summary once that feature exists — without
 * duplicating the calculation.
 *
 * "Computers" for these metrics means Hub Inventory items in the
 * Desktop Computers or Laptops categories — i.e. machines actually
 * deployed for beneficiary use at the hub. Laptops for Sale are a
 * separate resale catalog, not counted here, since they aren't
 * equipment beneficiaries are using.
 * ============================================================
 */

var COMPUTER_CATEGORIES = ['Desktop Computers', 'Laptops'];

function getHubHealthMetrics_(hubId) {
  var quotas = DB.getAll('ReportingQuotas');
  var currentYearLabel = getCurrentReportingYearLabel_(quotas);
  var yearQuotas = quotas.filter(function (q) { return q.YearLabel === currentYearLabel; });
  var yearQuotaIds = yearQuotas.map(function (q) { return q.QuotaID; });

  var hubProjects = DB.getAll('Projects').filter(function (p) { return p.HubID === hubId; });
  var hubProjectsThisYear = hubProjects.filter(function (p) { return yearQuotaIds.indexOf(p.QuotaID) !== -1; });
  var quotasFulfilled = {};
  hubProjectsThisYear.forEach(function (p) { quotasFulfilled[p.QuotaID] = true; });
  var reportingCompliancePct = yearQuotaIds.length
    ? Math.round((Object.keys(quotasFulfilled).length / yearQuotaIds.length) * 100)
    : null;
  var beneficiariesThisYear = attachProjectStats_(hubProjectsThisYear).reduce(function (sum, p) {
    return sum + (Number(p.TotalNewBeneficiaries) || 0);
  }, 0);

  var hubInventory = DB.getAll('Inventory').filter(function (i) { return i.HubID === hubId; });
  var computerItems = hubInventory.filter(function (i) { return COMPUTER_CATEGORIES.indexOf(i.Category) !== -1; });
  var computers = { total: 0, inUse: 0, inStorage: 0, underRepair: 0, faulty: 0, decommissioned: 0 };
  computerItems.forEach(function (i) {
    var qty = Number(i.Quantity) || 0;
    computers.total += qty;
    if (i.Status === 'In Use') computers.inUse += qty;
    else if (i.Status === 'In Storage') computers.inStorage += qty;
    else if (i.Status === 'Under Repair') computers.underRepair += qty;
    else if (i.Status === 'Faulty') computers.faulty += qty;
    else if (i.Status === 'Decommissioned') computers.decommissioned += qty;
  });
  var computersOperational = computers.inUse + computers.inStorage;
  var equipmentAvailabilityPct = computers.total ? Math.round((computersOperational / computers.total) * 100) : null;
  var equipmentUtilizationPct = computers.total ? Math.round((computers.inUse / computers.total) * 100) : null;
  var computerToBeneficiaryRatio = (beneficiariesThisYear && computers.total)
    ? Math.round((beneficiariesThisYear / computers.total) * 10) / 10
    : null;

  var inventoryTotalAssets = hubInventory.reduce(function (sum, i) { return sum + (Number(i.Quantity) || 0); }, 0);

  var laptops = DB.getAll('Laptops').filter(function (l) { return l.HubID === hubId; });
  var laptopSales = { currentStock: 0, sold: 0, faulty: 0 };
  laptops.forEach(function (l) {
    if (l.Status === 'Current Stock') laptopSales.currentStock++;
    else if (l.Status === 'Sold') laptopSales.sold++;
    else if (l.Status === 'Faulty') laptopSales.faulty++;
  });

  // Phase 15 usage metrics — reuses UsageKPIs.gs's computePeriodKPIs_()
  // rather than re-deriving these numbers here, per this file's own
  // "one place to compute hub status" intent (see file header).
  var fiscalYearDates = yearOverallDateRange_(yearQuotas);
  var usage = fiscalYearDates ? computePeriodKPIs_(hubId, fiscalYearDates.start, fiscalYearDates.end) : null;

  // Simple, transparent composite: average of reporting compliance and
  // equipment availability, whichever of the two actually have data.
  // Meant as a rough at-a-glance signal, not a rigid formula — easy to
  // adjust the weighting later once there's a real basis for one.
  var scoreInputs = [];
  if (reportingCompliancePct !== null) scoreInputs.push(reportingCompliancePct);
  if (equipmentAvailabilityPct !== null) scoreInputs.push(equipmentAvailabilityPct);
  var healthScore = scoreInputs.length
    ? Math.round(scoreInputs.reduce(function (a, b) { return a + b; }, 0) / scoreInputs.length)
    : null;

  return {
    currentYearLabel: currentYearLabel,
    reportsSubmittedThisYear: hubProjectsThisYear.length,
    reportsSubmittedAllTime: hubProjects.length,
    quotasThisYear: yearQuotaIds.length,
    quotasFulfilledThisYear: Object.keys(quotasFulfilled).length,
    reportingCompliancePct: reportingCompliancePct,
    beneficiariesThisYear: beneficiariesThisYear,
    computers: computers,
    computersOperational: computersOperational,
    equipmentAvailabilityPct: equipmentAvailabilityPct,
    equipmentUtilizationPct: equipmentUtilizationPct,
    computerToBeneficiaryRatio: computerToBeneficiaryRatio,
    inventoryTotalAssets: inventoryTotalAssets,
    laptopSales: laptopSales,
    healthScore: healthScore,
    uniqueBeneficiariesThisYear: usage ? usage.uniqueHubUsers : null,
    visitsThisYear: usage ? usage.totalHubVisits : null,
    computerSessionsThisYear: usage ? usage.totalComputerSessions : null,
    computerUtilizationPctThisYear: usage ? usage.computerUtilizationPct : null
  };
}

/**
 * Internal: the combined [start, end] date-string range spanning every
 * quota tagged with a given year, via the shared quota date-range
 * lookup (getQuotaDateRange_ in Quotas.gs) — one quota's start might not
 * be the earliest and another's end might not be the latest, so this
 * takes the min/max across all of them. Replaces the old fixed Aug-Jul
 * fiscal-year guess, which only ever matched the legacy "YYYY-YYYY"
 * YearLabel format and silently returned null (breaking this file's
 * usage-KPI fields) for today's plain "YYYY" quotas.
 */
function yearOverallDateRange_(yearQuotas) {
  if (!yearQuotas || !yearQuotas.length) return null;
  var start = null, end = null;
  yearQuotas.forEach(function (q) {
    try {
      var range = getQuotaDateRange_(q);
      if (!start || range.start < start) start = range.start;
      if (!end || range.end > end) end = range.end;
    } catch (err) { /* skip a malformed quota rather than breaking the whole lookup */ }
  });
  if (!start || !end) return null;
  return {
    start: Utilities.formatDate(start, 'UTC', 'yyyy-MM-dd'),
    end: Utilities.formatDate(end, 'UTC', 'yyyy-MM-dd')
  };
}

/** Admin-facing: health metrics for one hub, plus its basic profile fields. */
function getHubDetailOverview(sessionToken, hubId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var hub = DB.getById('Hubs', hubId);
    if (!hub) throw new Error('Hub not found.');
    var hubScope = resolveAdminHubScope_(identity);
    if (hubScope && !hubScope[hubId]) throw new Error('Hub not found.');
    return { hub: hub, health: getHubHealthMetrics_(hubId) };
  });
}

/** Admin-facing: a compact health summary for every hub, for the Hubs table's inline status badges. */
function getAllHubsHealthSummary(sessionToken) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var hubs = applyHubScope_(DB.getAll('Hubs'), resolveAdminHubScope_(identity), 'HubID');
    var summary = {};
    hubs.forEach(function (hub) {
      var m = getHubHealthMetrics_(hub.HubID);
      summary[hub.HubID] = {
        reportsSubmittedThisYear: m.reportsSubmittedThisYear,
        reportingCompliancePct: m.reportingCompliancePct,
        inventoryTotalAssets: m.inventoryTotalAssets,
        computersTotal: m.computers.total,
        equipmentAvailabilityPct: m.equipmentAvailabilityPct,
        laptopCurrentStock: m.laptopSales.currentStock,
        healthScore: m.healthScore,
        uniqueBeneficiariesThisYear: m.uniqueBeneficiariesThisYear,
        computerUtilizationPctThisYear: m.computerUtilizationPctThisYear
      };
    });
    return summary;
  });
}
