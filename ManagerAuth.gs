/**
 * ============================================================
 * MANAGERAUTH.GS — Hub Manager login + shared password-reset link handling
 * ============================================================
 * Deliberately separate from AdminAuth.gs for login itself. These
 * functions are reachable by unauthenticated visitors — anyone with a
 * valid emailed link or valid credentials — so every one of them
 * re-validates everything itself rather than trusting anything the
 * client claims. Session creation/lookup itself is shared logic and
 * lives in SessionService.gs.
 *
 * The reset-link functions (validateResetToken / resetAccountPassword)
 * are role-agnostic — findResettableAccount_() checks both Admins and
 * HubManagers — because ResetPassword.html is one shared page for both
 * a brand-new Hub Manager setting their first password AND anyone
 * (Admin or Hub Manager) using a self-service "forgot password" link
 * (see PasswordReset.gs). They stayed in this file rather than moving,
 * since the very first thing that ever calls them is still
 * Managers.addManager()'s welcome email.
 *
 * Flow:
 *   1. Managers.addManager() emails a "set your password" link, OR
 *      PasswordReset.gs's requestPasswordReset() emails one on demand.
 *   2. ResetPassword.html calls validateResetToken() to check the
 *      link, then resetAccountPassword() to set a real password.
 *      A successful reset immediately issues a session (auto-login)
 *      so the person lands straight in the dashboard, per spec.
 *   3. On later visits, Login.html calls managerLogin() or adminLogin().
 *   4. The SPA shell calls the role-agnostic getIdentity() (in
 *      SessionService.gs) to identify a returning user from their
 *      locally-stored session token.
 * ============================================================
 */

/** Looks up a manager by email, case-insensitively normalized. */
function getManagerByEmail_(email) {
  if (!email) return null;
  return DB.getById('HubManagers', String(email).trim().toLowerCase());
}

/** Combines FirstName + LastName into one display string. */
function managerFullName_(manager) {
  return (manager.FirstName + ' ' + manager.LastName).trim();
}

/** Looks up a credentialed account by email across both roles. Returns {table, role, record} or null. */
function findResettableAccount_(email) {
  var admin = getAdminByEmail_(email);
  if (admin) return { table: 'Admins', role: 'Admin', record: admin };
  var manager = getManagerByEmail_(email);
  if (manager) return { table: 'HubManagers', role: 'HubManager', record: manager };
  return null;
}

function accountFullName_(found) {
  return found.role === 'Admin' ? adminFullName_(found.record) : managerFullName_(found.record);
}

/**
 * Checks whether a reset link (email + token) is currently valid,
 * without changing anything. Called as soon as ResetPassword.html loads.
 */
function validateResetToken(email, token) {
  return safeExecute(function () {
    var found = findResettableAccount_(email);
    if (!found || !token || found.record.ResetToken !== token) {
      throw new Error('This reset link is invalid. Please use the exact link from your email, or request a new one.');
    }
    if (new Date(found.record.ResetTokenExpiry) < new Date()) {
      throw new Error('This reset link has expired. Request a new one from the sign-in page.');
    }
    return { email: found.record.Email, fullName: accountFullName_(found) };
  });
}

/**
 * Sets an account's own password using a valid reset link, then
 * immediately logs them in (per the requested flow: reset -> straight
 * into the dashboard, no separate login step needed the first time).
 * Works for either role — see findResettableAccount_().
 */
function resetAccountPassword(email, token, newPassword) {
  return safeExecute(function () {
    var found = findResettableAccount_(email);
    if (!found || !token || found.record.ResetToken !== token) {
      throw new Error('This reset link is invalid. Please use the exact link from your email, or request a new one.');
    }
    if (new Date(found.record.ResetTokenExpiry) < new Date()) {
      throw new Error('This reset link has expired. Request a new one from the sign-in page.');
    }

    var error = Validate.run([
      [Validate.required, newPassword, 'Password'],
      [Validate.minLength, newPassword, 8, 'Password'],
      [Validate.maxLength, newPassword, 100, 'Password']
    ]);
    if (error) throw new Error(error);

    var salt = Utilities.getUuid();
    var updates = {
      PasswordHash: hashPassword(newPassword, salt),
      PasswordSalt: salt,
      ResetToken: '',
      ResetTokenExpiry: ''
    };
    if (found.role === 'HubManager') updates.MustResetPassword = false;
    DB.update(found.table, found.record.Email, updates);

    var sessionToken = SessionService.createSession(found.record.Email, found.role);
    return { sessionToken: sessionToken, email: found.record.Email, fullName: accountFullName_(found), role: found.role };
  });
}

/** Authenticates a returning hub manager with email + password. */
function managerLogin(email, password) {
  return safeExecute(function () {
    var manager = getManagerByEmail_(email);

    // Same generic message whether the email is unknown or the password
    // is wrong — never reveal which one it was.
    var invalidCredentials = 'Incorrect email or password.';
    if (!manager) throw new Error(invalidCredentials);
    if (!verifyPassword(password, manager.PasswordSalt, manager.PasswordHash)) {
      throw new Error(invalidCredentials);
    }
    if (manager.Status !== 'Active') {
      throw new Error('Your account is inactive. Please contact your administrator.');
    }
    if (manager.MustResetPassword) {
      throw new Error('Please set your password first using the link from your welcome email.');
    }

    var sessionToken = SessionService.createSession(manager.Email, 'HubManager');
    return { sessionToken: sessionToken, email: manager.Email, fullName: managerFullName_(manager) };
  });
}
