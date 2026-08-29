/**
 * ============================================================
 * MANAGERPROFILE.GS — Hub Manager self-service profile
 * ============================================================
 * Address, profile picture, and payment details (bank / mobile money)
 * a Hub Manager manages for themselves — Finance reads the payment
 * fields when actually processing a salary/reimbursement payout.
 *
 * BankAccountNumber/MobileMoneyNumber follow the same masking
 * convention FinancialAccounts already uses (maskAccountNumber_ in
 * FinanceCommon.gs): stored in full, but getMyManagerProfile only
 * ever hands back the masked form, with "leave blank to keep the
 * existing one" on edit — the manager can't see their own full number
 * again after saving it, matching FinancialAccounts' own account
 * number exactly. Admin (Managers.gs) sees the real values, since
 * Admin is already fully trusted with Finance data everywhere else in
 * this system and is the one who'd action a payout.
 *
 * Email is deliberately NOT editable here — see the immutable-primary-
 * key note in Managers.gs. requestManagerEmailChange() only notifies
 * Admin; changeManagerEmail() (Admin-only) does the actual migration.
 * ============================================================
 */

function getMyManagerProfile(sessionToken) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    var manager = DB.getById(MANAGERS_TABLE, identity.email);
    if (!manager) throw new Error('Manager not found.');

    var hub = DB.getById('Hubs', manager.HubID);
    var safe = stripSensitiveManagerFields([manager])[0];
    var bankAccountNumberMasked = maskAccountNumber_(safe.BankAccountNumber);
    var mobileMoneyNumberMasked = maskAccountNumber_(safe.MobileMoneyNumber);
    delete safe.BankAccountNumber;
    delete safe.MobileMoneyNumber;
    return withField_(safe, {
      HubName: hub ? hub.HubName : '',
      BankAccountNumberMasked: bankAccountNumberMasked,
      MobileMoneyNumberMasked: mobileMoneyNumberMasked
    });
  });
}

function updateMyManagerProfile(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    data = data || {};

    var error = Validate.run([
      [Validate.isPhone, data.Phone, 'Phone'],
      [Validate.maxLength, data.Address, 300, 'Address']
    ]);
    if (error) throw new Error(error);

    var updates = {
      Phone: (data.Phone || '').trim(),
      Address: (data.Address || '').trim(),
      BankName: (data.BankName || '').trim(),
      BankAccountName: (data.BankAccountName || '').trim(),
      MobileMoneyProvider: (data.MobileMoneyProvider || '').trim(),
      MobileMoneyName: (data.MobileMoneyName || '').trim(),
      // Non-sensitive bank block (unmasked) — feeds the generated invoice's
      // Terms footer alongside BankName/BankAccountName/BankAccountNumber.
      BankCode: (data.BankCode || '').trim(),
      SwiftCode: (data.SwiftCode || '').trim(),
      BankBranch: (data.BankBranch || '').trim(),
      BranchCode: (data.BranchCode || '').trim()
    };

    // Masked on the way out, so a blank submission here means "didn't
    // touch it," not "clear it" — the manager has no way to see (and
    // therefore no way to deliberately re-type) their current full
    // number to leave it unchanged otherwise.
    var bankAccountNumber = String(data.BankAccountNumber || '').trim();
    if (bankAccountNumber) updates.BankAccountNumber = bankAccountNumber;
    var mobileMoneyNumber = String(data.MobileMoneyNumber || '').trim();
    if (mobileMoneyNumber) updates.MobileMoneyNumber = mobileMoneyNumber;

    DB.update(MANAGERS_TABLE, identity.email, updates);
    return getMyManagerProfile(sessionToken).data;
  });
}

/** Mirrors Sync.gs's syncProfileUpdate_ Drive-upload pattern for a Beneficiary photo. */
function updateMyManagerPhoto(sessionToken, photoBase64, photoMimeType) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    if (!photoBase64) throw new Error('No photo provided.');

    var bytes = Utilities.base64Decode(photoBase64);
    var blob = Utilities.newBlob(bytes, photoMimeType || 'image/jpeg', identity.email + '.jpg');
    var file = DriveApp.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var photoUrl = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w400';

    DB.update(MANAGERS_TABLE, identity.email, { PhotoUrl: photoUrl });
    return { photoUrl: photoUrl };
  });
}

/**
 * Notifies Admin that this manager wants to change their login email —
 * changes nothing itself. Broadcast (not hub-scoped): this is account
 * integrity, any Admin should be able to action it, not just whoever
 * happens to manage this manager's hub.
 */
function requestManagerEmailChange(sessionToken, newEmail) {
  return safeExecute(function () {
    var identity = requireManagerSession_(sessionToken);
    newEmail = String(newEmail || '').trim().toLowerCase();

    var error = Validate.run([
      [Validate.required, newEmail, 'New email'],
      [Validate.isEmail, newEmail, 'New email']
    ]);
    if (error) throw new Error(error);
    if (newEmail === identity.email) throw new Error('That is already your current email.');
    if (findResettableAccount_(newEmail)) throw new Error('That email is already in use by another account.');

    notify_({
      type: 'ManagerEmailChangeRequested', severity: 'info',
      message: identity.email + ' has requested to change their login email to ' + newEmail + '.',
      targetRole: 'Admin', targetAccessLevels: ['SuperAdmin', 'CountryDirector'], relatedTable: 'HubManagers', relatedRecordId: identity.email
    });

    return { message: 'Request sent — an Admin will action it shortly.' };
  });
}

/**
 * Admin-only. Migrates a manager's account to a new email: copies the
 * full record (including PasswordHash/PasswordSalt — not derived from
 * email, so the current password keeps working) under the new key,
 * then deletes the old row. DB.update() can't do this directly since
 * Email is HubManagers' primary key.
 */
function changeManagerEmail(sessionToken, oldEmail, newEmail) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var manager = DB.getById(MANAGERS_TABLE, oldEmail);
    if (!manager) throw new Error('Manager not found.');

    newEmail = String(newEmail || '').trim().toLowerCase();
    var error = Validate.run([
      [Validate.required, newEmail, 'New email'],
      [Validate.isEmail, newEmail, 'New email']
    ]);
    if (error) throw new Error(error);
    if (newEmail === manager.Email) throw new Error('That is already this manager\'s email.');
    if (DB.getById(MANAGERS_TABLE, newEmail) || getAdminByEmail_(newEmail)) {
      throw new Error('That email is already in use by another account.');
    }

    var moved = DB.insert(MANAGERS_TABLE, Object.assign({}, manager, { Email: newEmail }));
    DB.remove(MANAGERS_TABLE, oldEmail);

    return stripSensitiveManagerFields([moved])[0];
  });
}
