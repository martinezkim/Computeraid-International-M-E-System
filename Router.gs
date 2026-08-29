/**
 * ============================================================
 * ROUTER.GS — Maps page keys to their HTML partial file
 * ============================================================
 * The frontend is a single-page app: sidebar links call
 * loadPage('countries'), which asks the server for that page's
 * HTML fragment and swaps it into #main-content — no reload.
 * Add one line here whenever a new module page is built.
 *
 * getPageContent() now also takes the caller's session token so it
 * can make role-aware decisions: 'dashboard' resolves to a different
 * file depending on whether an Admin or a Hub Manager is asking, and
 * admin-only pages are refused server-side (not just hidden in the
 * sidebar) for anyone who isn't actually an Admin.
 *
 * File naming note: Apps Script won't let a Script file and an HTML
 * file share the same base name (e.g. Dashboard.gs + Dashboard.html
 * both named "Dashboard" is rejected in the editor), even though the
 * extensions differ. Every page-content HTML file that has a same-named
 * .gs module is suffixed "HT" to avoid that collision — e.g. Countries.gs
 * pairs with CountriesHT.html, not Countries.html. Files with no
 * colliding .gs name (Sidebar.html, Login.html, ManagerDashboard.html,
 * ManagerProjects.html, ...) don't need the suffix.
 * ============================================================
 */

var ROUTES = {
  dashboard: 'DashboardHT', // Admin view; HubManagers get ManagerDashboard instead — see below
  countries: 'CountriesHT',
  hubs: 'HubsHT',
  managers: 'ManagersHT',
  quotas: 'QuotasHT',
  projects: 'ProjectsHT',
  myprojects: 'ManagerProjects',
  inventorysummary: 'InventorySummaryHT',
  inventoryhub: 'InventoryHT',
  laptopsale: 'LaptopsHT',
  admininventory: 'AdminInventoryHT',
  auditlog: 'AuditLogHT',
  usageconfig: 'UsageConfigHT',
  beneficiaries: 'BeneficiariesHT',
  mybeneficiaries: 'MyBeneficiariesHT',
  hubusage: 'HubUsageHT',
  myhubusage: 'MyHubUsageHT',
  usageoverview: 'UsageOverviewHT',
  syncdevices: 'SyncDevicesHT',
  financeconfig: 'FinanceConfigHT',
  financedashboard: 'FinanceDashboardHT',
  financeaccounts: 'FinanceAccountsHT',
  myfinance: 'MyFinanceHT',
  expenses: 'FinanceExpensesHT',
  myexpenses: 'MyExpensesHT',
  financereports: 'FinanceReportsHT',
  mydevices: 'MyDevicesHT',
  myprofile: 'MyProfileHT',
  admins: 'AdminsHT'
  // Unlinked (Phase 17 nav consolidation) but NOT deleted, same pattern
  // as the Training module: 'invoices'/'salaries' folded into the
  // 'expenses' page as tabs (see FinanceExpensesHT.html), 'myinvoices'
  // folded into 'myexpenses', and 'budgets' hidden for now. Their
  // standalone files (InvoicesHT/JS, MyInvoicesHT/JS, SalariesHT/JS,
  // BudgetsHT/JS) remain on disk, unreferenced.
};

/** Pages only an Admin should ever see the content of. */
var ADMIN_ONLY_PAGES = ['countries', 'hubs', 'managers', 'quotas', 'projects', 'admininventory', 'auditlog', 'usageconfig', 'beneficiaries', 'hubusage', 'usageoverview', 'syncdevices', 'financeconfig', 'financedashboard', 'financeaccounts', 'expenses', 'financereports', 'admins'];

/**
 * Further restricts a subset of the Admin-only pages above by
 * AccessLevel (Module 3: roles) — an admin page NOT listed here is open
 * to every AccessLevel once the ADMIN_ONLY_PAGES role check above has
 * passed. SuperAdmin and CountryDirector implicitly pass every one of
 * these regardless of what's listed (CountryDirector is today's
 * original, unrestricted Admin) — only worth listing the AccessLevels
 * that are ADDITIONALLY let in.
 *
 * This mirrors the Sidebar's data-access attribute (CommonJS.html's
 * applyRoleVisibility) — that's the UX nicety of greying out a locked
 * link; THIS check is the real gate, exactly like every other check in
 * this function.
 *
 * Known limitation, deliberately not solved here: this only restricts
 * which PAGES an AccessLevel can load — it does not (and, short of
 * retrofitting every one of this app's ~200 requireAdminSession_-gated
 * functions individually, cannot cheaply) stop an MELead/Accountant
 * session from calling a Finance/Inventory function directly. Those
 * functions only check "is this any kind of Admin," not which
 * AccessLevel. Acceptable for now (these are two trusted internal
 * roles, not adversarial users) but worth knowing if that ever changes.
 */
var ACCESS_LEVEL_RESTRICTED_PAGES = {
  countries: [], hubs: [], managers: [], admininventory: [], auditlog: [], usageconfig: [], syncdevices: [], financeconfig: [],
  quotas: ['MELead'], projects: ['MELead'], usageoverview: ['MELead'], beneficiaries: ['MELead'], hubusage: ['MELead'],
  financedashboard: ['Accountant'], financeaccounts: ['Accountant'], expenses: ['Accountant'], financereports: ['Accountant'],
  admins: []
};

/** Pages only a Hub Manager should ever see the content of. */
var MANAGER_ONLY_PAGES = ['myprojects', 'inventorysummary', 'inventoryhub', 'laptopsale', 'mybeneficiaries', 'myhubusage', 'myfinance', 'myexpenses', 'mydevices', 'myprofile'];

/**
 * Of the Hub-Manager pages above, these are OFF by default — a hub only
 * sees one once an Admin ticks it for that hub (Hubs.gs's
 * getHubEnabledTabs_, set from the Hubs admin screen's checklist). The
 * rest (myprojects/mybeneficiaries/myhubusage/mydevices, plus the shared
 * 'dashboard') are compulsory and never gated this way; 'myprofile' is
 * reached via the account chip, not a sidebar link, so it's exempt too.
 */
var MANAGER_OPTIONAL_PAGES = ['inventorysummary', 'inventoryhub', 'laptopsale', 'myfinance', 'myexpenses'];

/**
 * Returns the raw HTML for a given page key, to be injected into
 * the SPA shell client-side by loadPage() in CommonJS.html.
 * @param {string} pageKey
 * @param {string} sessionToken - the caller's locally-stored session token
 */
function getPageContent(pageKey, sessionToken) {
  var identity = resolveIdentityForRouting_(sessionToken);

  if (pageKey === 'dashboard') {
    // ManagerDashboard.html has no colliding .gs name, so it doesn't need
    // the "HT" suffix — only DashboardHT.html (paired with Dashboard.gs) does.
    // Note this is now the Hub Manager's 3-card summary, not their project
    // list — that moved to ManagerProjects.html under the 'myprojects' key.
    var dashboardFile = (identity && identity.role === 'HubManager') ? 'ManagerDashboard' : 'DashboardHT';
    return HtmlService.createHtmlOutputFromFile(dashboardFile).getContent();
  }

  if (ADMIN_ONLY_PAGES.indexOf(pageKey) !== -1 && (!identity || identity.role !== 'Admin')) {
    return '<div class="alert alert-danger m-4">You don\'t have access to this page.</div>';
  }

  if (identity && identity.role === 'Admin' && ACCESS_LEVEL_RESTRICTED_PAGES[pageKey] &&
    identity.accessLevel !== 'SuperAdmin' && identity.accessLevel !== 'CountryDirector' &&
    ACCESS_LEVEL_RESTRICTED_PAGES[pageKey].indexOf(identity.accessLevel) === -1) {
    return '<div class="alert alert-danger m-4">You don\'t have access to this page.</div>';
  }

  if (MANAGER_ONLY_PAGES.indexOf(pageKey) !== -1 && (!identity || identity.role !== 'HubManager')) {
    return '<div class="alert alert-danger m-4">You don\'t have access to this page.</div>';
  }

  // Same enforcement point as the two checks above, for the subset of
  // Hub-Manager pages an Admin can lock/unlock per hub — see
  // MANAGER_OPTIONAL_PAGES's comment. The sidebar already greys these
  // out client-side (CommonJS.html), but that's UX only; this is the
  // real gate, matching the file header's stated convention.
  if (MANAGER_OPTIONAL_PAGES.indexOf(pageKey) !== -1 && identity && identity.role === 'HubManager') {
    var enabled = getHubEnabledTabs_(identity.hubId);
    if (enabled.indexOf(pageKey) === -1) {
      return '<div class="alert alert-warning m-4">This page isn\'t enabled for your hub yet — ask your Admin to turn it on.</div>';
    }
  }

  var fileName = ROUTES[pageKey];
  if (!fileName) {
    return '<div class="alert alert-danger m-4">Page not found.</div>';
  }
  return HtmlService.createHtmlOutputFromFile(fileName).getContent();
}

/** Best-effort identity lookup for routing decisions — never throws. */
function resolveIdentityForRouting_(sessionToken) {
  var result = getIdentity(sessionToken);
  return result.success ? result.data : null;
}
