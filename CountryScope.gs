/**
 * ============================================================
 * COUNTRYSCOPE.GS — Per-country data isolation for scoped Country Directors
 * ============================================================
 * A CountryDirector explicitly assigned a Country (Admins.CountryID set)
 * sees only that country's hubs and everything hub-scoped beneath them —
 * beneficiaries, projects, finance records, inventory, audit log, etc.
 * A CountryDirector with NO country assigned (blank — the state every
 * pre-existing admin account is in, and a legitimate PERMANENT choice
 * for a director overseeing multiple countries or the whole org, not
 * just a migration default) is UNSCOPED: sees everything, exactly like
 * before this feature existed. SuperAdmin/MELead/Accountant are never
 * restricted by any of this regardless of any CountryID value.
 *
 * Every "list" function this touches follows the same three-line
 * pattern: capture `identity` from requireAdminSession_, resolve its
 * hub scope once, filter before paginateAndFilter. A single-record
 * "detail" function instead does an ownership check: if hubScope is set
 * and the record's hub isn't in it, refuse with the same generic
 * "not found" wording used elsewhere in this app (never leak that the
 * record exists in another country).
 *
 * Deliberately does NOT re-gate mutation actions (approve/reject/pay/
 * delete, editing a Hub/Manager/Project) or picker/dropdown endpoints
 * (getHubOptions, getProjectOptions, getFinancialAccountOptions,
 * getFinanceStaffOptions) — those still enumerate every hub/project/
 * account org-wide. Same accepted residual gap as MELead/Accountant's
 * page-vs-function-level access (see Router.gs's own header comment).
 * ============================================================
 */

/**
 * Returns null (no restriction — SuperAdmin, MELead, Accountant, or an
 * unscoped CountryDirector) or a {hubId: true} lookup of every hub in
 * the caller's assigned country. Call once per request and reuse.
 */
function resolveAdminHubScope_(identity) {
  if (!identity || identity.role !== 'Admin') return null;
  if (identity.accessLevel !== 'CountryDirector') return null;
  if (!identity.countryId) return null; // unscoped — sees everything

  var lookup = {};
  DB.getAll('Hubs').forEach(function (h) { if (h.CountryID === identity.countryId) lookup[h.HubID] = true; });
  return lookup;
}

/**
 * Filters `records` to only those whose `hubField` value is in
 * `hubScope` — a no-op if hubScope is null (unrestricted) or the
 * record's own hub value is blank (a genuinely org-wide/shared record,
 * e.g. a Financial Account or Budget not tied to any one hub — those
 * stay visible to every CountryDirector regardless of country).
 */
function applyHubScope_(records, hubScope, hubField) {
  if (!hubScope) return records;
  return records.filter(function (r) {
    var hubId = r[hubField || 'HubID'];
    if (!hubId) return true;
    return !!hubScope[hubId];
  });
}

/**
 * Voluntary counterpart to resolveAdminHubScope_ — resolves a {hubId:
 * true} lookup for a caller-CHOSEN country (an optional filter dropdown
 * on an otherwise-unscoped page), not the caller's own identity. Returns
 * null (no filter selected) or the lookup. Callers apply this as a
 * SECOND, independent applyHubScope_ pass, right after the existing
 * mandatory identity-based one — the two compose correctly since
 * applyHubScope_ is a no-op on a null scope and simply ANDs when both
 * are non-null. Never a security boundary by itself; SuperAdmin/MELead/
 * Accountant get this as a free, switch-anytime filter, not a
 * restriction — see AdminsHT.html/AdminTeam.gs for the (separate,
 * mandatory) CountryDirector assignment mechanism.
 */
function resolveCountryFilterScope_(countryId) {
  if (!countryId) return null;
  var lookup = {};
  DB.getAll('Hubs').forEach(function (h) { if (h.CountryID === countryId) lookup[h.HubID] = true; });
  return lookup;
}

/**
 * Thin wrapper for the Finance tables that reference a FinancialAccount
 * (BalanceAdjustments, BankStatements, BankTransactions, Reconciliations
 * — all carry AccountID directly, one hop, not two) rather than a Hub.
 * Returns null (unrestricted) or a {accountId: true} lookup of every
 * account visible to the caller: one in a scoped hub, or a genuinely
 * org-wide account (blank HubID on FinancialAccounts itself).
 */
function resolveAdminAccountScope_(hubScope) {
  if (!hubScope) return null;
  var lookup = {};
  DB.getAll('FinancialAccounts').forEach(function (a) {
    if (!a.HubID || hubScope[a.HubID]) lookup[a.AccountID] = true;
  });
  return lookup;
}
