/**
 * ============================================================
 * SESSIONSERVICE.GS — Shared login sessions for every role
 * ============================================================
 * Both AdminAuth.gs and ManagerAuth.gs create/read/destroy
 * sessions through this one object instead of duplicating the
 * same Sessions-table logic twice. A session only ever knows
 * an Email + a Role ('Admin' or 'HubManager') — resolving that
 * into a display identity (name, hub, ...) is each role's own
 * job, tied together generically by getIdentity() below.
 * ============================================================
 */

var SessionService = {

  /** Creates a session row for the given email/role and returns its token. */
  createSession: function (email, role) {
    var token = generateSecureToken();
    // Stored as an ISO string, not a Date — DB._rowToObject() truncates
    // Date-typed cells to a bare 'yyyy-MM-dd' on read, which would drop
    // the time-of-day and make sessions look expired hours early.
    var expiry = new Date(Date.now() + APP_CONFIG.SESSION_HOURS * 60 * 60 * 1000).toISOString();
    DB.insert('Sessions', {
      SessionToken: token,
      Email: email,
      Role: role,
      ExpiresAt: expiry
    });
    return token;
  },

  /** Returns the session row if the token is valid and unexpired, else null. */
  getSession: function (token) {
    if (!token) return null;
    var session = DB.getById('Sessions', token);
    if (!session) return null;
    if (new Date(session.ExpiresAt) < new Date()) {
      DB.remove('Sessions', token);
      return null;
    }
    return session;
  },

  destroySession: function (token) {
    if (token && DB.getById('Sessions', token)) {
      DB.remove('Sessions', token);
    }
  }
};

/**
 * Resolves ANY session token — Admin or Hub Manager — into a display
 * identity. This is the single function the SPA shell calls on load,
 * so the client doesn't need to know or care which role it's dealing
 * with; it just gets back { email, fullName, role, hubId? }.
 */
function getIdentity(sessionToken) {
  return safeExecute(function () {
    var session = SessionService.getSession(sessionToken);
    if (!session) throw new Error('Session expired. Please log in again.');

    if (session.Role === 'Admin') {
      var admin = getAdminByEmail_(session.Email);
      if (!admin || admin.Status !== 'Active') {
        SessionService.destroySession(sessionToken);
        throw new Error('Session no longer valid. Please log in again.');
      }
      return { email: admin.Email, fullName: adminFullName_(admin), role: 'Admin', accessLevel: resolveAdminAccessLevel_(admin), countryId: admin.CountryID || '' };
    }

    var manager = getManagerByEmail_(session.Email);
    if (!manager || manager.Status !== 'Active') {
      SessionService.destroySession(sessionToken);
      throw new Error('Session no longer valid. Please log in again.');
    }
    return {
      email: manager.Email, fullName: managerFullName_(manager), role: 'HubManager', hubId: manager.HubID, photoUrl: manager.PhotoUrl || '',
      enabledTabs: getHubEnabledTabs_(manager.HubID)
    };
  });
}

/** Ends whichever kind of session the token belongs to. */
function logout(sessionToken) {
  return safeExecute(function () {
    SessionService.destroySession(sessionToken);
    return true;
  });
}
