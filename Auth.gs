/**
 * ============================================================
 * AUTH.GS — LEGACY / SUPERSEDED
 * ============================================================
 * This was the original scaffold: it trusted whoever's Google
 * account was running the script as "the admin," with no real
 * login. That's been replaced by AdminAuth.gs (credential-based
 * login, same pattern as Hub Managers) — see Login.html and
 * SessionService.gs for the current flow.
 *
 * Nothing in the app calls getSessionUser()/AUTH.* anymore. Kept
 * only as a reference in case Google SSO is ever added alongside
 * (or instead of) email/password login for admins.
 * ============================================================
 */

var AUTH = {
  getCurrentUser: function () {
    var email = Session.getActiveUser().getEmail() || 'unknown@user';
    return {
      email: email,
      role: 'Admin',
      isAuthenticated: !!email
    };
  },

  requireRole: function (allowedRoles) {
    var user = this.getCurrentUser();
    if (allowedRoles.indexOf(user.role) === -1) {
      throw new Error('Access denied: insufficient permissions.');
    }
    return user;
  }
};

function getSessionUser() {
  return safeExecute(function () {
    return AUTH.getCurrentUser();
  });
}
