/**
 * ============================================================
 * PASSWORDRESET.GS — Self-service "Forgot password?"
 * ============================================================
 * Reuses the exact reset-link mechanism already built for a Hub
 * Manager's first-time welcome email (ManagerAuth.gs's ResetToken /
 * ResetTokenExpiry columns + ResetPassword.html, generalized to cover
 * both Admins and HubManagers) — this just adds a way for someone to
 * trigger that same link themselves, for either role, instead of only
 * an Admin being able to send one via "Resend Credentials".
 * ============================================================
 */

/**
 * Called from a "Forgot password?" link on Login.html. Deliberately
 * returns the exact same message whether or not the email matches a
 * real account, and never throws for an unknown email — revealing
 * that distinction doesn't help a legitimate user and does help an
 * attacker enumerate valid accounts.
 */
function requestPasswordReset(email) {
  return safeExecute(function () {
    var GENERIC_MESSAGE = 'If that email has an account, a reset link has been sent to it.';
    email = String(email || '').trim().toLowerCase();
    if (!email) return { message: GENERIC_MESSAGE };

    var found = findResettableAccount_(email);
    if (!found || found.record.Status !== 'Active') return { message: GENERIC_MESSAGE };

    var token = generateSecureToken();
    // ISO string, not a raw Date — see Database.gs's _rowToObject header
    // comment: a Date-typed cell gets truncated to a bare 'yyyy-MM-dd' on
    // read, which would drop the time-of-day and make the link look
    // expired hours early.
    var expiry = new Date(Date.now() + APP_CONFIG.RESET_TOKEN_HOURS * 60 * 60 * 1000).toISOString();

    DB.update(found.table, found.record.Email, { ResetToken: token, ResetTokenExpiry: expiry });

    var recordWithToken = Object.assign({}, found.record, { ResetToken: token });
    EmailService.sendPasswordResetEmail(recordWithToken, found.role);

    return { message: GENERIC_MESSAGE };
  });
}
