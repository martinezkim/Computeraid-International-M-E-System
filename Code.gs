/**
 * ============================================================
 * M&E MANAGEMENT SYSTEM — MAIN ENTRY POINT
 * ============================================================
 * Code.gs
 * Handles the web app entry point (doGet) and global includes.
 * ============================================================
 */

/**
 * Serves the web app HTML shell — or a standalone auth page (login,
 * password reset) for visitors who aren't inside the authenticated
 * SPA yet.
 *
 * The bare exec URL (no ?page at all) defaults to the login page, not
 * the dashboard — an unauthenticated visitor should never see the SPA
 * shell render at all, not even briefly. The SPA shell still has its
 * own client-side gate too (Index.html checks for a valid locally-
 * stored session token and redirects to ?page=login if there isn't
 * one), as a second line of defense for anyone who bookmarks or is
 * linked directly to ?page=dashboard without a session.
 * @param {Object} e - Event parameter from the HTTP request.
 * @return {HtmlOutput}
 */
function doGet(e) {
  // Device-authenticated JSON API for the offline PWA's bootstrap cache
  // pull (Phase 16 Milestone C) — separate from the ?page= SPA routing
  // below, and checked first since it has nothing to do with pages.
  // deviceRequestStatus/hubList are unauthenticated on purpose (a kiosk
  // requesting its first API key has no credentials yet) — see
  // DeviceRequests.gs.
  if (e && e.parameter && e.parameter.api) {
    if (e.parameter.api === 'deviceRequestStatus') return handleDeviceRequestStatusCheck_(e);
    if (e.parameter.api === 'hubList') return jsonResponse_(getHubOptionsPublic_());
    return handleApiGetRequest_(e);
  }

  var page = (e && e.parameter && e.parameter.page) ? e.parameter.page : 'login';
  var webAppUrl = ScriptApp.getService().getUrl();

  // Reverted from the Phase 3 redirect-to-Firebase behavior: the Firebase
  // frontend's exec-URL calls (RpcBridge.gs, via the SAME doPost this
  // page's JS also hits) turned out to intermittently fail to deliver
  // their redirect response back to the browser (a real, observed Apps
  // Script platform quirk — Executions log shows 100% success server-side,
  // so the request/response IS completing, it's just not reliably
  // reaching the client). That's fine for internal testing, not
  // acceptable for a live Hub Manager presentation — this GAS-hosted
  // iframe SPA is the known-reliable fallback while that gets sorted out.
  // getFrontendUrl_ (Config.gs) and mne-admin.web.app stay available —
  // this only changes which one doGet serves by default.

  // 'login', 'adminlogin', and 'managerlogin' all serve the same Login.html —
  // just with a different tab preselected. 'managerlogin' is kept as its own
  // route because that's the URL baked into every welcome email already sent.
  if (page === 'login' || page === 'adminlogin' || page === 'managerlogin') {
    var loginTemplate = HtmlService.createTemplateFromFile('Login');
    loginTemplate.webAppUrl = webAppUrl;
    loginTemplate.defaultRole = (page === 'managerlogin') ? 'HubManager' : 'Admin';
    return loginTemplate.evaluate()
      .setTitle(APP_CONFIG.APP_NAME + ' — Sign In')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  if (page === 'resetpassword') {
    var resetTemplate = HtmlService.createTemplateFromFile('ResetPassword');
    resetTemplate.webAppUrl = webAppUrl;
    resetTemplate.presetEmail = (e && e.parameter && e.parameter.email) || '';
    resetTemplate.presetToken = (e && e.parameter && e.parameter.token) || '';
    return resetTemplate.evaluate()
      .setTitle(APP_CONFIG.APP_NAME + ' — Set Your Password')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  var template = HtmlService.createTemplateFromFile('Index');
  template.initialPage = page;
  template.webAppUrl = webAppUrl;

  return template.evaluate()
    .setTitle(APP_CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Offline sync entry point (Phase 16 Milestone C) — the future PWA/
 * desktop agent POST batches of captured records here. Kept thin on
 * purpose: all the actual logic (device auth, idempotency, per-type
 * handlers) lives in Sync.gs's handleSyncRequest_(), same "Code.gs
 * just routes" pattern doGet() already follows via Router.gs.
 * @param {Object} e - Event parameter from the HTTP POST request.
 * @return {ContentService.TextOutput}
 */
function doPost(e) {
  // Self-service device provisioning (DeviceRequests.gs) and the
  // Firebase-frontend RPC bridge (RpcBridge.gs) are both unauthenticated
  // at this layer too (RPC calls carry their own sessionToken as a
  // regular argument, checked inside whichever allowlisted function
  // handles it) — peek at the action before falling through to the
  // device-authenticated sync batch contract.
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    if (body.action === 'requestDevice') return handleDeviceRequestSubmit_(body);
    if (body.action === 'rpc') return handleRpcRequest_(body);
  } catch (peekErr) { /* not JSON, or no action — fall through, handleSyncRequest_ will report the real error */ }
  return handleSyncRequest_(e);
}

/**
 * Includes an HTML partial file into a template.
 * Used inside templated HTML via <?!= include('FileName'); ?>
 * @param {string} filename
 * @return {string}
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Run ONCE from the Apps Script editor (select this function,
 * click Run) to create all sheets/tables defined in SCHEMA.
 * Safe to re-run — it skips tables that already exist.
 */
function initializeDatabase() {
  DB.initializeAllTables();
  return 'Database initialized successfully.';
}
