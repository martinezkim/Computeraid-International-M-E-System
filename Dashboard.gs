/**
 * ============================================================
 * DASHBOARD.GS — Dashboard summary data
 * ============================================================
 * Powers the admin's 5 mini stat cards: Countries, Hubs, Hub
 * Managers, Projects (scoped to the current reporting year), and
 * Total Beneficiaries (same scope).
 * ============================================================
 */

function getDashboardStats(sessionToken) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var hubScope = resolveAdminHubScope_(identity);

    var hubs = applyHubScope_(DB.getAll('Hubs'), hubScope, 'HubID');
    var managers = applyHubScope_(DB.getAll('HubManagers'), hubScope, 'HubID');
    var quotas = DB.getAll('ReportingQuotas'); // shared org-wide config, never country-scoped

    // A scoped CountryDirector's "Countries" figure is just their own
    // one country, not the org total — keeps the whole stat card
    // internally consistent with everything else on it.
    var countries = hubScope
      ? DB.getAll('Countries').filter(function (c) { return c.CountryID === identity.countryId; })
      : DB.getAll('Countries');

    var currentYearLabel = getCurrentReportingYearLabel_(quotas);
    var yearQuotaIds = quotas
      .filter(function (q) { return q.YearLabel === currentYearLabel; })
      .map(function (q) { return q.QuotaID; });

    var yearProjects = applyHubScope_(DB.getAll('Projects'), hubScope, 'HubID')
      .filter(function (p) { return yearQuotaIds.indexOf(p.QuotaID) !== -1; });

    // Active Users — a lifetime, deduped count of anyone who has ever
    // actually visited a (visible) hub, not merely registered — see
    // computeActiveBeneficiariesCount_ below. Passing hubScope (not just
    // a single hubId) is what lets this stay correct for a country with
    // more than one hub.
    var totalBeneficiariesThisYear = computeActiveBeneficiariesCount_(hubScope);

    // Total Assets — every Inventory item's quantity, across every visible Hub
    // (same figure AdminInventory.gs's overview card shows).
    var totalAssets = applyHubScope_(DB.getAll('Inventory'), hubScope, 'HubID').reduce(function (sum, item) {
      return sum + (Number(item.Quantity) || 0);
    }, 0);

    // Computer Usage — average of each visible Hub's this-month utilization %
    // (computePeriodKPIs_ in UsageKPIs.gs), skipping Hubs with no
    // configured open-hours schedule yet (null, not 0 — see HubSchedule.gs).
    var today = new Date();
    var monthRange = periodRange_(today, 'month');
    var utilizationValues = hubs.map(function (h) {
      return computePeriodKPIs_(h.HubID, monthRange.start, monthRange.end).computerUtilizationPct;
    }).filter(function (pct) { return pct !== null; });
    var avgComputerUtilizationPct = utilizationValues.length
      ? Math.round(utilizationValues.reduce(function (a, b) { return a + b; }, 0) / utilizationValues.length)
      : null;

    return {
      totalCountries: countries.length,
      activeCountries: countries.filter(function (c) { return c.Status === 'Active'; }).length,
      totalHubs: hubs.length,
      activeHubs: hubs.filter(function (h) { return h.Status === 'Active'; }).length,
      totalManagers: managers.length,
      activeManagers: managers.filter(function (m) { return m.Status === 'Active'; }).length,
      currentYearLabel: currentYearLabel,
      totalProjectsThisYear: yearProjects.length,
      totalBeneficiariesThisYear: totalBeneficiariesThisYear,
      totalAssets: totalAssets,
      avgComputerUtilizationPct: avgComputerUtilizationPct
    };
  });
}

/**
 * Picks the reporting year the dashboard's Projects/Beneficiaries cards
 * should be scoped to. Deliberately driven by what data actually
 * exists — the most recent YearLabel among your ReportingQuotas — not
 * blindly by today's calendar date. Whatever year you're actively
 * creating quotas and filing projects against is what shows up, with no
 * risk of the dashboard silently scoping to a year that has zero data
 * in it just because it happens to match today's date. Only falls back
 * to a date-based guess (Aug-Jul fiscal cycle) when there are no
 * quotas at all yet.
 */
function getCurrentReportingYearLabel_(quotas) {
  if (quotas && quotas.length > 0) {
    var years = quotas.map(function (q) { return q.YearLabel; });
    years.sort(function (a, b) {
      var startYearA = parseInt(String(a).split('-')[0], 10);
      var startYearB = parseInt(String(b).split('-')[0], 10);
      return startYearB - startYearA; // descending — most recent first
    });
    return years[0];
  }

  var now = new Date();
  var month = now.getMonth(); // 0-indexed; Aug = 7
  var year = now.getFullYear();
  return month >= 7 ? (year + '-' + (year + 1)) : ((year - 1) + '-' + year);
}

/**
 * "Active Users" — a lifetime, deduped count of beneficiaries who have
 * ever had at least one recorded Visit — not merely registered.
 * Registering at the kiosk creates a Beneficiaries row; it takes a
 * separate logged Visit at a hub to count here, so this captures anyone
 * who has actually walked in and used a hub, ever, regardless of which
 * Project Year (or no Project Year at all) that visit falls under.
 *
 * `hubFilter` is deliberately polymorphic — see matchesHubFilter_:
 *   - falsy (null/undefined) = every hub (Admin's global card, or an
 *     unscoped CountryDirector)
 *   - a single hubId string = just that hub (Hub Manager's own card,
 *     see Projects.gs's getMyDashboardStats)
 *   - a {hubId: true} lookup object = every hub in that set (a scoped
 *     CountryDirector's card — a country can have more than one hub, so
 *     this can't be a single hubId)
 */
function computeActiveBeneficiariesCount_(hubFilter) {
  var activeIds = {};
  DB.getAll(BENEFICIARY_VISITS_TABLE).forEach(function (v) {
    if (matchesHubFilter_(v.HubID, hubFilter)) activeIds[v.BeneficiaryID] = true;
  });
  return Object.keys(activeIds).length;
}

/** true if `recordHubId` passes `hubFilter` — see computeActiveBeneficiariesCount_'s doc comment for the three shapes hubFilter can take. */
function matchesHubFilter_(recordHubId, hubFilter) {
  if (!hubFilter) return true;
  if (typeof hubFilter === 'string') return recordHubId === hubFilter;
  return !!hubFilter[recordHubId];
}
