/**
 * ============================================================
 * ADMINAUTH.GS — Admin login & account bootstrap
 * ============================================================
 * Mirrors ManagerAuth.gs's shape, but against the Admins table.
 * There's no self-registration flow — that would be a chicken-
 * and-egg problem (you'd need an admin to create an admin) — so
 * the very first account is created by running createInitialAdmin()
 * once from the Apps Script editor, the same way you run
 * initializeDatabase(). Run it again with different arguments any
 * time you need to add another admin; a proper "Manage Admins" UI
 * is a natural follow-up once this is in use.
 * ============================================================
 */

var ADMINS_TABLE = 'Admins';

/**
 * ONE-TIME SETUP ONLY — the chicken-and-egg bootstrap for the very first
 * admin account (there's no one yet to create one from the in-app
 * Administrators page). Edit the four values below, then in the Apps
 * Script editor select `createInitialAdmin` from the function dropdown
 * and click Run. For every admin after this one — any AccessLevel,
 * including another SuperAdmin — use the Administrators page instead
 * (AdminTeam.gs), which sends a proper welcome email.
 */
function createInitialAdmin() {
  var email = 'martin@computeraid.org';
  var password = 'REPLACE_ME_BEFORE_RUNNING';  // edit this to a real temporary password before running — never commit a real one here
  var firstName = 'Martin';
  var lastName = 'Kimani';

  var normalizedEmail = String(email).trim().toLowerCase();

  if (DB.getById(ADMINS_TABLE, normalizedEmail)) {
    return 'An admin with this email already exists — nothing was changed.';
  }
  if (String(password).length < 8) {
    return 'Password must be at least 8 characters — edit the script and run it again.';
  }

  var salt = Utilities.getUuid();
  DB.insert(ADMINS_TABLE, {
    Email: normalizedEmail,
    FirstName: String(firstName).trim(),
    LastName: String(lastName).trim(),
    PasswordHash: hashPassword(password, salt),
    PasswordSalt: salt,
    Status: 'Active',
    AccessLevel: 'SuperAdmin'
  });

  return 'Admin account created for ' + normalizedEmail + '. Log in at: ' + ScriptApp.getService().getUrl() + '?page=login';
}

/** Looks up an admin by email, case-insensitively normalized. */
function getAdminByEmail_(email) {
  if (!email) return null;
  return DB.getById(ADMINS_TABLE, String(email).trim().toLowerCase());
}

/** Combines FirstName + LastName into one display string. */
function adminFullName_(admin) {
  return (admin.FirstName + ' ' + admin.LastName).trim();
}

var ADMIN_ACCESS_LEVELS = ['SuperAdmin', 'CountryDirector', 'MELead', 'Accountant'];
var ADMIN_ACCESS_LEVEL_LABELS_ = { SuperAdmin: 'Super Admin', CountryDirector: 'Country Director', MELead: 'M&E Lead', Accountant: 'Accountant' };

/** Human-readable label for an AccessLevel — used anywhere the role needs to read out (welcome email, etc.). */
function accessLevelLabel_(level) {
  return ADMIN_ACCESS_LEVEL_LABELS_[level] || 'Admin';
}

/**
 * Resolves (and, if blank, persists) an admin's AccessLevel — self-heals
 * every existing account the first time it's read after this column was
 * added, no manual backfill needed. Every admin that ever existed before
 * Module 3 becomes 'CountryDirector' (= today's original, unrestricted
 * Admin, functionally unchanged) except the founding account, which
 * becomes 'SuperAdmin' so there's always at least one from day one.
 */
function resolveAdminAccessLevel_(admin) {
  if (admin.AccessLevel) return admin.AccessLevel;
  var level = admin.Email === 'martin@computeraid.org' ? 'SuperAdmin' : 'CountryDirector';
  DB.update(ADMINS_TABLE, admin.Email, { AccessLevel: level });
  return level;
}

/** Authenticates an admin with email + password. */
function adminLogin(email, password) {
  return safeExecute(function () {
    var admin = getAdminByEmail_(email);

    // Same generic message whether the email is unknown or the password
    // is wrong — never reveal which one it was.
    var invalidCredentials = 'Incorrect email or password.';
    if (!admin) throw new Error(invalidCredentials);
    if (!verifyPassword(password, admin.PasswordSalt, admin.PasswordHash)) {
      throw new Error(invalidCredentials);
    }
    if (admin.Status !== 'Active') {
      throw new Error('Your account is inactive.');
    }

    var sessionToken = SessionService.createSession(admin.Email, 'Admin');
    return { sessionToken: sessionToken, email: admin.Email, fullName: adminFullName_(admin) };
  });
}
