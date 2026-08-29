/**
 * ============================================================
 * ADMINTEAM.GS — SuperAdmin-only management of admin accounts (Module 3)
 * ============================================================
 * Every admin account after the very first (createInitialAdmin, run
 * once from the editor — see AdminAuth.gs) is created here instead,
 * with a real welcome email + "set your password" link, same mechanism
 * Managers.gs already uses for Hub Managers.
 *
 * Every function here is SuperAdmin-only (requireSuperAdmin_) — a
 * CountryDirector, despite otherwise having full page access, does NOT
 * manage other admin accounts; only a SuperAdmin does.
 * ============================================================
 */

/** Confirms the token belongs to an active Admin session AND that admin is a SuperAdmin. */
function requireSuperAdmin_(sessionToken) {
  var identity = requireAdminSession_(sessionToken);
  if (identity.accessLevel !== 'SuperAdmin') {
    throw new Error('You must be a Super Admin to do this.');
  }
  return identity;
}

function stripSensitiveAdminFields_(records) {
  records.forEach(function (r) {
    delete r.PasswordHash;
    delete r.PasswordSalt;
    delete r.ResetToken;
    delete r.ResetTokenExpiry;
  });
  return records;
}

/** Every admin account, any AccessLevel — SuperAdmin-only, same filtered/sorted/paginated shape as every other list endpoint. */
function getAdmins(sessionToken, options) {
  return safeExecute(function () {
    requireSuperAdmin_(sessionToken);
    options = options || {};
    var schema = SCHEMA[ADMINS_TABLE];
    var countryNames = {};
    DB.getAll('Countries').forEach(function (c) { countryNames[c.CountryID] = c.CountryName; });
    var all = DB.getAll(ADMINS_TABLE);
    all.forEach(function (a) {
      a.AccessLevel = resolveAdminAccessLevel_(a);
      a.CountryName = a.CountryID ? (countryNames[a.CountryID] || a.CountryID) : '';
    });
    stripSensitiveAdminFields_(all);

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: schema.searchableColumns,
      sortBy: options.sortBy || 'FirstName',
      sortDir: options.sortDir || 'asc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Creates a new admin account at the given AccessLevel: validates input,
 * generates a temporary password + reset token (same pattern as
 * Managers.addManager), and emails a welcome/"set your password" link.
 */
function addAdmin(sessionToken, data) {
  return safeExecute(function () {
    requireSuperAdmin_(sessionToken);
    var error = validateAdminInput_(data, true);
    if (error) throw new Error(error);

    var email = String(data.Email).trim().toLowerCase();
    if (getAdminByEmail_(email) || getManagerByEmail_(email)) {
      throw new Error('An account with this email already exists.');
    }

    var tempPassword = generateRandomPassword(10);
    var salt = Utilities.getUuid();
    var resetToken = generateSecureToken();
    var expiry = new Date(Date.now() + APP_CONFIG.RESET_TOKEN_HOURS * 60 * 60 * 1000).toISOString();

    var record = DB.insert(ADMINS_TABLE, {
      Email: email,
      FirstName: data.FirstName.trim(),
      LastName: data.LastName.trim(),
      PasswordHash: hashPassword(tempPassword, salt),
      PasswordSalt: salt,
      Status: 'Active',
      ResetToken: resetToken,
      ResetTokenExpiry: expiry,
      AccessLevel: data.AccessLevel,
      CountryID: data.CountryID || ''
    });

    EmailService.sendAdminWelcomeEmail(record);

    return stripSensitiveAdminFields_([record])[0];
  });
}

/** Changes an existing admin's AccessLevel (and, for a CountryDirector, their CountryID scope). A SuperAdmin cannot change their own — avoids accidentally locking themselves out. */
function updateAdminAccessLevel(sessionToken, email, accessLevel, countryId) {
  return safeExecute(function () {
    var identity = requireSuperAdmin_(sessionToken);
    if (email === identity.email) throw new Error('You cannot change your own access level.');
    if (ADMIN_ACCESS_LEVELS.indexOf(accessLevel) === -1) throw new Error('Invalid access level.');
    if (!DB.getById(ADMINS_TABLE, email)) throw new Error('Admin not found.');
    if (countryId && !DB.getById('Countries', countryId)) throw new Error('Country not found.');

    var record = DB.update(ADMINS_TABLE, email, { AccessLevel: accessLevel, CountryID: countryId || '' });
    return stripSensitiveAdminFields_([record])[0];
  });
}

/** Activates/deactivates an admin account. A SuperAdmin cannot deactivate their own. */
function updateAdminStatus(sessionToken, email, status) {
  return safeExecute(function () {
    var identity = requireSuperAdmin_(sessionToken);
    if (email === identity.email) throw new Error('You cannot deactivate your own account.');
    if (['Active', 'Inactive'].indexOf(status) === -1) throw new Error('Invalid status.');
    if (!DB.getById(ADMINS_TABLE, email)) throw new Error('Admin not found.');

    var record = DB.update(ADMINS_TABLE, email, { Status: status });
    return stripSensitiveAdminFields_([record])[0];
  });
}

/**
 * Edits an admin's First/Last name and, optionally, their Email.
 * Email is this table's primary key (Config.gs) and DB.update() never
 * rewrites a primary key column (see Database.gs) — so an actual email
 * change is a rename: insert a fresh row under the new email carrying
 * every other field forward untouched, then remove the old row. A
 * SuperAdmin cannot change their OWN email — doing so would invalidate
 * their current session's identity lookup mid-use (Admins is looked up
 * by email on every request); ask another Super Admin to do it instead.
 * Historical AuditLog/Chat/Notification rows that reference the old
 * email as plain text are deliberately NOT rewritten — same as any
 * other audit trail, they preserve what was true at the time.
 */
function updateAdminProfile(sessionToken, email, data) {
  return safeExecute(function () {
    var identity = requireSuperAdmin_(sessionToken);
    var existing = DB.getById(ADMINS_TABLE, email);
    if (!existing) throw new Error('Admin not found.');

    var error = validateAdminProfileInput_(data);
    if (error) throw new Error(error);

    var firstName = data.FirstName.trim();
    var lastName = data.LastName.trim();
    var newEmail = String(data.Email).trim().toLowerCase();

    if (newEmail === email) {
      var record = DB.update(ADMINS_TABLE, email, { FirstName: firstName, LastName: lastName });
      return stripSensitiveAdminFields_([record])[0];
    }

    if (email === identity.email) {
      throw new Error('You cannot change your own email. Ask another Super Admin to update it.');
    }
    if (getAdminByEmail_(newEmail) || getManagerByEmail_(newEmail)) {
      throw new Error('An account with this email already exists.');
    }

    var created = DB.insert(ADMINS_TABLE, {
      Email: newEmail,
      FirstName: firstName,
      LastName: lastName,
      PasswordHash: existing.PasswordHash,
      PasswordSalt: existing.PasswordSalt,
      Status: existing.Status,
      ResetToken: existing.ResetToken,
      ResetTokenExpiry: existing.ResetTokenExpiry,
      AccessLevel: existing.AccessLevel,
      CountryID: existing.CountryID || ''
    });
    DB.remove(ADMINS_TABLE, email);
    return stripSensitiveAdminFields_([created])[0];
  });
}

/** Permanently deletes an admin account. A SuperAdmin cannot delete their own — avoids locking themselves out. */
function deleteAdmin(sessionToken, email) {
  return safeExecute(function () {
    var identity = requireSuperAdmin_(sessionToken);
    if (email === identity.email) throw new Error('You cannot delete your own account.');
    if (!DB.getById(ADMINS_TABLE, email)) throw new Error('Admin not found.');

    DB.remove(ADMINS_TABLE, email);
    return true;
  });
}

/** Re-issues a fresh temporary password + reset link and re-sends the welcome email — mirrors Managers.resendManagerCredentials. */
function resendAdminCredentials(sessionToken, email) {
  return safeExecute(function () {
    requireSuperAdmin_(sessionToken);
    var admin = getAdminByEmail_(email);
    if (!admin) throw new Error('Admin not found.');

    var tempPassword = generateRandomPassword(10);
    var salt = Utilities.getUuid();
    var resetToken = generateSecureToken();
    var expiry = new Date(Date.now() + APP_CONFIG.RESET_TOKEN_HOURS * 60 * 60 * 1000).toISOString();

    var updated = DB.update(ADMINS_TABLE, email, {
      PasswordHash: hashPassword(tempPassword, salt),
      PasswordSalt: salt,
      ResetToken: resetToken,
      ResetTokenExpiry: expiry
    });

    EmailService.sendAdminWelcomeEmail(updated);
    return stripSensitiveAdminFields_([updated])[0];
  });
}

function validateAdminInput_(data, isNew) {
  var checks = [
    [Validate.required, data && data.FirstName, 'First name'],
    [Validate.maxLength, data && data.FirstName, 60, 'First name'],
    [Validate.required, data && data.LastName, 'Last name'],
    [Validate.maxLength, data && data.LastName, 60, 'Last name'],
    [Validate.required, data && data.AccessLevel, 'Access level'],
    [Validate.oneOf, data && data.AccessLevel, ADMIN_ACCESS_LEVELS, 'Access level']
  ];
  if (isNew) {
    checks.push([Validate.required, data && data.Email, 'Email']);
    checks.push([Validate.isEmail, data && data.Email, 'Email']);
  }
  if (data && data.CountryID) checks.push([Validate.exists, 'Countries', data.CountryID, 'Country']);
  return Validate.run(checks);
}

function validateAdminProfileInput_(data) {
  return Validate.run([
    [Validate.required, data && data.FirstName, 'First name'],
    [Validate.maxLength, data && data.FirstName, 60, 'First name'],
    [Validate.required, data && data.LastName, 'Last name'],
    [Validate.maxLength, data && data.LastName, 60, 'Last name'],
    [Validate.required, data && data.Email, 'Email'],
    [Validate.isEmail, data && data.Email, 'Email']
  ]);
}
