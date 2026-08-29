/**
 * ============================================================
 * MANAGERS.GS — Hub Managers module (Module 3)
 * ============================================================
 * Same shape as Countries.gs / Hubs.gs, plus the account
 * provisioning flow: on creation, a temporary password is
 * generated, hashed, and emailed along with a "set your own
 * password" link. Password/token fields are NEVER sent to the
 * client — see stripSensitiveManagerFields().
 *
 * Login, password reset, and session handling live in
 * ManagerAuth.gs, kept separate since that logic is invoked by
 * unauthenticated visitors (from the email link / login page),
 * not by the admin dashboard.
 * ============================================================
 */

var MANAGERS_TABLE = 'HubManagers';

/**
 * Returns a filtered, sorted, paginated list of hub managers, with
 * each record's HubName resolved for display.
 *
 * Admin-only — this now includes Address and full (unmasked) bank/
 * mobile-money payment details (see Config.gs's HubManagers schema),
 * so unlike most list endpoints in this codebase it genuinely can't be
 * left ungated.
 * @param {Object} options {search, sortBy, sortDir, page, pageSize, hubId}
 */
function getManagers(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};
    var schema = SCHEMA[MANAGERS_TABLE];
    var all = DB.getAll(MANAGERS_TABLE);

    all = applyHubScope_(all, resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');

    // Hub filter is an exact match, applied before search/sort/pagination.
    if (options.hubId) {
      all = all.filter(function (m) { return m.HubID === options.hubId; });
    }

    resolveForeignKey(all, 'HubID', 'Hubs', 'HubName', 'HubName');
    stripSensitiveManagerFields(all);

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
 * Creates a new hub manager: validates input (including that the email
 * isn't already registered — Email is this table's primary key, so
 * DB.insert() also enforces uniqueness as a second line of defense),
 * generates a temporary password + password-reset token, stores only
 * the salted hash, and emails the manager their credentials and a
 * "set your password" link.
 */
function addManager(sessionToken, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateManagerInput(data, true);
    if (error) throw new Error(error);

    var email = String(data.Email).trim().toLowerCase();
    // Generated only to fill PasswordHash with something unguessable until
    // the manager sets their own via the reset link — never emailed or
    // exposed anywhere; see EmailService.sendManagerWelcomeEmail().
    var tempPassword = generateRandomPassword(10);
    var salt = Utilities.getUuid();
    var resetToken = generateSecureToken();
    // Stored as an ISO string, not a Date — DB._rowToObject() truncates
    // any Date-typed cell down to a bare 'yyyy-MM-dd' on read, which
    // would silently drop the time-of-day and make links look expired
    // hours early. An ISO string round-trips through the sheet untouched.
    var expiry = new Date(Date.now() + APP_CONFIG.RESET_TOKEN_HOURS * 60 * 60 * 1000).toISOString();

    var record = DB.insert(MANAGERS_TABLE, {
      Email: email,
      FirstName: data.FirstName.trim(),
      LastName: data.LastName.trim(),
      Phone: (data.Phone || '').trim(),
      HubID: data.HubID,
      PasswordHash: hashPassword(tempPassword, salt),
      PasswordSalt: salt,
      MustResetPassword: true,
      ResetToken: resetToken,
      ResetTokenExpiry: expiry,
      Status: data.Status || 'Active',
      Address: (data.Address || '').trim(),
      BankName: (data.BankName || '').trim(),
      BankAccountName: (data.BankAccountName || '').trim(),
      BankAccountNumber: (data.BankAccountNumber || '').trim(),
      MobileMoneyProvider: (data.MobileMoneyProvider || '').trim(),
      MobileMoneyName: (data.MobileMoneyName || '').trim(),
      MobileMoneyNumber: (data.MobileMoneyNumber || '').trim()
    });

    EmailService.sendManagerWelcomeEmail(record);

    return stripSensitiveManagerFields([record])[0];
  });
}

/**
 * Updates a hub manager's profile fields. Email (the primary key) and
 * password are never changed here — email is immutable by design, and
 * password changes only happen through the reset flow in ManagerAuth.gs.
 */
function updateManager(sessionToken, email, data) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var error = validateManagerInput(data, false);
    if (error) throw new Error(error);

    var record = DB.update(MANAGERS_TABLE, email, {
      FirstName: data.FirstName.trim(),
      LastName: data.LastName.trim(),
      Phone: (data.Phone || '').trim(),
      HubID: data.HubID,
      Status: data.Status,
      Address: (data.Address || '').trim(),
      BankName: (data.BankName || '').trim(),
      BankAccountName: (data.BankAccountName || '').trim(),
      BankAccountNumber: (data.BankAccountNumber || '').trim(),
      MobileMoneyProvider: (data.MobileMoneyProvider || '').trim(),
      MobileMoneyName: (data.MobileMoneyName || '').trim(),
      MobileMoneyNumber: (data.MobileMoneyNumber || '').trim()
    });

    return stripSensitiveManagerFields([record])[0];
  });
}

/** Permanently removes a hub manager. */
function deleteManager(sessionToken, email) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    if (!DB.getById(MANAGERS_TABLE, email)) {
      throw new Error('Hub manager not found.');
    }
    DB.remove(MANAGERS_TABLE, email);
    return true;
  });
}

/**
 * Re-issues a fresh temporary password + reset link and re-sends the
 * welcome email — useful if the original email was lost or the reset
 * link expired.
 */
function resendManagerCredentials(sessionToken, email) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var manager = DB.getById(MANAGERS_TABLE, email);
    if (!manager) throw new Error('Hub manager not found.');

    var tempPassword = generateRandomPassword(10);
    var salt = Utilities.getUuid();
    var resetToken = generateSecureToken();
    var expiry = new Date(Date.now() + APP_CONFIG.RESET_TOKEN_HOURS * 60 * 60 * 1000).toISOString();

    var updated = DB.update(MANAGERS_TABLE, email, {
      PasswordHash: hashPassword(tempPassword, salt),
      PasswordSalt: salt,
      MustResetPassword: true,
      ResetToken: resetToken,
      ResetTokenExpiry: expiry
    });

    EmailService.sendManagerWelcomeEmail(updated);

    return stripSensitiveManagerFields([updated])[0];
  });
}

/**
 * Shared validation for add/edit. Email is only validated — and checked
 * for uniqueness — on create, since it's the immutable primary key.
 */
function validateManagerInput(data, isNew) {
  var error = Validate.run([
    [Validate.required, data && data.FirstName, 'First name'],
    [Validate.maxLength, data && data.FirstName, 100, 'First name'],
    [Validate.required, data && data.LastName, 'Last name'],
    [Validate.maxLength, data && data.LastName, 100, 'Last name'],
    [Validate.isPhone, data && data.Phone, 'Phone'],
    [Validate.required, data && data.HubID, 'Hub'],
    [Validate.exists, 'Hubs', data && data.HubID, 'Hub'],
    [Validate.oneOf, data && data.Status, ['Active', 'Inactive'], 'Status']
  ]);
  if (error) return error;

  if (isNew) {
    var emailError = Validate.run([
      [Validate.required, data && data.Email, 'Email'],
      [Validate.isEmail, data && data.Email, 'Email']
    ]);
    if (emailError) return emailError;

    // Belt-and-braces: this is checked again inside DB.insert(), but
    // failing here first gives a friendlier, specific error message
    // instead of a generic insert failure.
    if (DB.getById(MANAGERS_TABLE, String(data.Email).trim().toLowerCase())) {
      return 'A hub manager with this email already exists.';
    }
  }

  return null;
}

/**
 * Strips password/token fields before a record ever leaves the server.
 * Mutates and returns the same array for convenient chaining.
 */
function stripSensitiveManagerFields(records) {
  records.forEach(function (r) {
    delete r.PasswordHash;
    delete r.PasswordSalt;
    delete r.ResetToken;
    delete r.ResetTokenExpiry;
  });
  return records;
}
