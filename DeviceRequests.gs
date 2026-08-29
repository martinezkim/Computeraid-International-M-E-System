/**
 * ============================================================
 * DEVICEREQUESTS.GS — Self-service device provisioning
 * ============================================================
 * A kiosk that doesn't have credentials yet can request them instead
 * of an Admin manually provisioning a SyncDevices row and handing
 * over an API key by hand. Flow:
 *
 *   1. Kiosk POSTs {action:'requestDevice', hubId, deviceLabel}
 *      (unauthenticated — it has no credentials yet). We create a
 *      Pending DeviceRequests row with a server-generated confirmation
 *      code and broadcast a bell notification to that Hub's Manager(s)
 *      (notify_(), same TargetHubID-scoped addressing Feedback already
 *      uses).
 *   2. The kiosk shows the confirmation code and polls
 *      ?api=deviceRequestStatus&requestId=... every few seconds.
 *   3. A Hub Manager approves from the notification — after visually
 *      matching the code shown there to the code on the physical
 *      kiosk screen in front of them. That's the actual security
 *      property here: the code doesn't need to be secret, it forces
 *      whoever clicks Approve to be standing at the machine, not
 *      rubber-stamping a spoofed request from anywhere on the internet.
 *   4. Approving mints a real API key (same generateRandomPassword() /
 *      hashPassword() calls provisionSyncDevice already uses) and
 *      stashes it in the request row ONCE. The kiosk's next poll picks
 *      it up and the row is immediately cleared + flipped to Claimed —
 *      that's the only place a plaintext key is ever stored, and only
 *      until the first successful read.
 *
 * DeviceID collisions across hubs (two hubs both auto-detecting a
 * Windows desktop logged in as "User 1") are avoided by composing the
 * SyncDevices primary key as `${HubID}-${DeviceLabel}` — same fix
 * already applied to Install-SchKiosk.ps1's -HubPrefix. A repeat
 * request for the same Hub+label (a reinstall) reissues that row's
 * key instead of failing on DB.insert's uniqueness check; a collision
 * against a *different* hub's existing device is rejected with a
 * clear message rather than silently overwritten.
 *
 * Admin's existing manual provisionSyncDevice (Sync.gs) is untouched
 * and stays the fallback for a brand-new hub with no Hub Manager
 * account yet to approve anything.
 * ============================================================
 */

var DEVICE_REQUESTS_TABLE = 'DeviceRequests';
var DEVICE_REQUEST_MAX_PENDING_PER_HUB = 5;
var DEVICE_REQUEST_EXPIRY_MINUTES = 60;

function generateConfirmationCode_() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** "482193" -> "482-193", purely for display in the notification message / UI. */
function formatConfirmationCode_(code) {
  code = String(code || '');
  return code.length === 6 ? code.slice(0, 3) + '-' + code.slice(3) : code;
}

// ---------- Unauthenticated entry points (called from Code.gs's doGet/doPost) ----------

/** doPost target when body.action === 'requestDevice'. body is already-parsed JSON. */
function handleDeviceRequestSubmit_(body) {
  try {
    return jsonResponse_({ status: 'ok', data: submitDeviceRequest_(body) });
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message });
  }
}

/** doGet target for ?api=deviceRequestStatus&requestId=... */
function handleDeviceRequestStatusCheck_(e) {
  try {
    var requestId = e.parameter.requestId;
    if (!requestId) throw new Error('requestId is required.');
    return jsonResponse_({ status: 'ok', data: getDeviceRequestStatus_(requestId) });
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message });
  }
}

function submitDeviceRequest_(body) {
  var hubId = body && body.hubId;
  var label = String((body && body.deviceLabel) || '').trim();
  if (!hubId) throw new Error('Please choose a Hub.');
  if (!label) throw new Error('Device label is required.');

  var hub = DB.getById('Hubs', hubId);
  if (!hub || hub.Status !== 'Active') throw new Error('Hub not found.');

  var now = new Date();
  var pendingCount = DB.getAll(DEVICE_REQUESTS_TABLE).filter(function (r) {
    return r.HubID === hubId && r.Status === 'Pending' && new Date(r.ExpiresAt) > now;
  }).length;
  if (pendingCount >= DEVICE_REQUEST_MAX_PENDING_PER_HUB) {
    throw new Error('Too many pending device requests for this hub right now — please try again shortly or contact your Admin.');
  }

  var code = generateConfirmationCode_();
  var expiresAt = new Date(now.getTime() + DEVICE_REQUEST_EXPIRY_MINUTES * 60000);

  var created = DB.insert(DEVICE_REQUESTS_TABLE, {
    HubID: hubId, DeviceLabel: label, ComposedDeviceID: '', ConfirmationCode: code,
    Status: 'Pending', ExpiresAt: expiresAt.toISOString(),
    ApprovedByEmail: '', ApprovedAt: '', IssuedApiKeyPlaintext: ''
  });

  notify_({
    type: 'DeviceRequestPending', severity: 'info',
    message: 'A new device ("' + label + '") wants to join ' + hub.HubName + '. Confirmation code: ' + formatConfirmationCode_(code),
    targetRole: 'HubManager', targetHubId: hubId,
    relatedTable: DEVICE_REQUESTS_TABLE, relatedRecordId: created.RequestID
  });

  return { requestId: created.RequestID, confirmationCode: formatConfirmationCode_(code), expiresAt: created.ExpiresAt };
}

/**
 * Polled by the kiosk. Lazily expires stale Pending rows on read (no
 * trigger needed). On Approved, hands back the plaintext key exactly
 * once — the row is cleared + flipped to Claimed in this same call,
 * so a second poll (or anyone else who somehow gets this requestId)
 * gets 'claimed', not the key.
 */
function getDeviceRequestStatus_(requestId) {
  var row = DB.getById(DEVICE_REQUESTS_TABLE, requestId);
  if (!row) return { requestStatus: 'not_found' };

  if (row.Status === 'Pending' && new Date(row.ExpiresAt) <= new Date()) {
    row = DB.update(DEVICE_REQUESTS_TABLE, requestId, { Status: 'Expired' });
  }

  if (row.Status === 'Approved') {
    var apiKey = row.IssuedApiKeyPlaintext;
    DB.update(DEVICE_REQUESTS_TABLE, requestId, { IssuedApiKeyPlaintext: '', Status: 'Claimed' });
    return { requestStatus: 'approved', deviceId: row.ComposedDeviceID, apiKey: apiKey };
  }

  return { requestStatus: String(row.Status || '').toLowerCase() };
}

// ---------- Hub Manager (session-authenticated) ----------

/** Pending, unexpired requests for the caller's own hub — powers the MyDevices page and (defensively) the approval modal. */
function getPendingDeviceRequestsForMyHub(sessionToken) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    var now = new Date();
    return DB.getAll(DEVICE_REQUESTS_TABLE)
      .filter(function (r) { return r.HubID === identity.hubId && r.Status === 'Pending' && new Date(r.ExpiresAt) > now; })
      .sort(function (a, b) { return new Date(b.DateCreated) - new Date(a.DateCreated); });
  });
}

/** Single request's details for the approval modal, scoped to the caller's own hub. */
function getDeviceRequestDetail(sessionToken, requestId) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    var request = DB.getById(DEVICE_REQUESTS_TABLE, requestId);
    if (!request) throw new Error('Request not found.');
    if (request.HubID !== identity.hubId) throw new Error('This request is not for your hub.');
    var hub = DB.getById('Hubs', request.HubID);
    return {
      RequestID: request.RequestID, DeviceLabel: request.DeviceLabel, Status: request.Status,
      HubName: hub ? hub.HubName : request.HubID, ExpiresAt: request.ExpiresAt,
      ConfirmationCodeDisplay: formatConfirmationCode_(request.ConfirmationCode)
    };
  });
}

function approveDeviceRequest(sessionToken, requestId) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    var request = DB.getById(DEVICE_REQUESTS_TABLE, requestId);
    if (!request) throw new Error('Request not found.');
    if (request.HubID !== identity.hubId) throw new Error('This request is not for your hub.');
    if (request.Status !== 'Pending') throw new Error('This request has already been handled.');
    if (new Date(request.ExpiresAt) <= new Date()) {
      DB.update(DEVICE_REQUESTS_TABLE, requestId, { Status: 'Expired' });
      throw new Error('This request expired — ask them to submit a new one.');
    }

    var composedDeviceId = identity.hubId + '-' + request.DeviceLabel;
    var existing = DB.getById(SYNC_DEVICES_TABLE, composedDeviceId);
    if (existing && existing.HubID !== identity.hubId) {
      throw new Error('A device with this label is already registered to a different hub — ask them to use a different device label and try again.');
    }

    var apiKey = generateRandomPassword(24);
    var salt = Utilities.getUuid();
    var hash = hashPassword(apiKey, salt);

    if (existing) {
      DB.update(SYNC_DEVICES_TABLE, composedDeviceId, {
        DeviceLabel: request.DeviceLabel, APIKeyHash: hash, APIKeySalt: salt, Active: true
      });
    } else {
      DB.insert(SYNC_DEVICES_TABLE, {
        DeviceID: composedDeviceId, HubID: identity.hubId, DeviceLabel: request.DeviceLabel,
        APIKeyHash: hash, APIKeySalt: salt, Active: true, LastSyncAt: ''
      });
    }

    DB.update(DEVICE_REQUESTS_TABLE, requestId, {
      Status: 'Approved', ComposedDeviceID: composedDeviceId,
      ApprovedByEmail: identity.email, ApprovedAt: new Date().toISOString(),
      IssuedApiKeyPlaintext: apiKey
    });

    logAudit_(identity, existing ? 'Update' : 'Create', SYNC_DEVICES_TABLE, composedDeviceId, '(record)', '', request.DeviceLabel, identity.hubId);
    return { deviceId: composedDeviceId };
  });
}

function rejectDeviceRequest(sessionToken, requestId) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    var request = DB.getById(DEVICE_REQUESTS_TABLE, requestId);
    if (!request) throw new Error('Request not found.');
    if (request.HubID !== identity.hubId) throw new Error('This request is not for your hub.');
    if (request.Status !== 'Pending') throw new Error('This request has already been handled.');
    return DB.update(DEVICE_REQUESTS_TABLE, requestId, {
      Status: 'Rejected', ApprovedByEmail: identity.email, ApprovedAt: new Date().toISOString()
    });
  });
}

/** Read-only list of the caller's own hub's connected devices — "Connected devices" section of MyDevices. */
function getMyHubSyncDevices(sessionToken) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    return DB.getAll(SYNC_DEVICES_TABLE).filter(function (d) { return d.HubID === identity.hubId; });
  });
}

/** Hub-Manager-scoped twin of Sync.gs's Admin-only setSyncDeviceActive — a manager can deactivate their own hub's lost/retired kiosk without waiting on Admin. */
function setMyHubDeviceActive(sessionToken, deviceId, active) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    var device = DB.getById(SYNC_DEVICES_TABLE, deviceId);
    if (!device) throw new Error('Device not found.');
    if (device.HubID !== identity.hubId) throw new Error('This device is not registered to your hub.');
    return DB.update(SYNC_DEVICES_TABLE, deviceId, { Active: !!active });
  });
}
