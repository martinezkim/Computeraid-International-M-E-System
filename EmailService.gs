/**
 * ============================================================
 * EMAILSERVICE.GS — Outbound transactional email
 * ============================================================
 * Centralizes every email the system sends, so future modules
 * (password resets for other roles, notifications, report
 * delivery, ...) reuse the same sender instead of each module
 * building its own MailApp calls.
 * ============================================================
 */

var EmailService = {

  /**
   * Sends a Hub Manager a welcome email with a link to set their own
   * password. Called right after a manager record is created, and
   * again by "Resend Credentials" if the original email is lost.
   *
   * Deliberately never includes the system-generated temporary password
   * — it's an internal placeholder the manager is never meant to see or
   * use; the reset link is the only credential that matters to them.
   */
  sendManagerWelcomeEmail: function (manager) {
    var appUrl = ScriptApp.getService().getUrl();
    var resetLink = appUrl + '?page=resetpassword'
      + '&email=' + encodeURIComponent(manager.Email)
      + '&token=' + encodeURIComponent(manager.ResetToken);
    var loginLink = appUrl + '?page=managerlogin';

    var subject = 'Welcome to ' + APP_CONFIG.APP_NAME + ' — Set Up Your Account';

    var body =
      'Hi ' + manager.FirstName + ',\n\n' +
      'An account has been created for you on the ' + APP_CONFIG.APP_NAME + ' as the manager of your hub.\n\n' +
      'Your login email is: ' + manager.Email + '\n\n' +
      'To get started, set your own password here:\n' +
      resetLink + '\n\n' +
      'This link expires in ' + APP_CONFIG.RESET_TOKEN_HOURS + ' hours. If it expires, ask your administrator to resend your credentials.\n\n' +
      'After that, you can log in any time at:\n' + loginLink + '\n\n' +
      '— ' + APP_CONFIG.APP_NAME + ' Team';

    var htmlBody =
      '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1f2430;">' +
        '<div style="background:linear-gradient(135deg,#feca38,#ffdd6b);border-radius:14px;padding:1.5rem;text-align:center;margin-bottom:1.5rem;">' +
          '<h2 style="margin:0;color:#12172b;">Welcome to ' + escapeHtml_(APP_CONFIG.APP_NAME) + '</h2>' +
        '</div>' +
        '<p>Hi ' + escapeHtml_(manager.FirstName) + ',</p>' +
        '<p>An account has been created for you as the manager of your hub. Your login email is:</p>' +
        '<p style="font-weight:600;font-size:1.05rem;">' + escapeHtml_(manager.Email) + '</p>' +
        '<p>To get started, set your own password:</p>' +
        '<p style="text-align:center;margin:1.5rem 0;">' +
          '<a href="' + resetLink + '" style="background:linear-gradient(135deg,#feca38,#ffdd6b);color:#12172b;text-decoration:none;font-weight:700;padding:.75rem 1.5rem;border-radius:999px;display:inline-block;">Set My Password</a>' +
        '</p>' +
        '<p style="color:#6b7280;font-size:.85rem;">This link expires in ' + APP_CONFIG.RESET_TOKEN_HOURS + ' hours. If it expires, ask your administrator to resend your credentials.</p>' +
        '<p style="color:#6b7280;font-size:.85rem;">After that, you can log in any time at: <a href="' + loginLink + '">' + loginLink + '</a></p>' +
      '</div>';

    MailApp.sendEmail({
      to: manager.Email,
      subject: subject,
      body: body,
      htmlBody: htmlBody,
      name: APP_CONFIG.APP_NAME
    });
  },

  /**
   * Same shape as sendManagerWelcomeEmail, for a new admin account
   * (any AccessLevel) created from the Administrators page — see
   * AdminTeam.gs's addAdmin/resendAdminCredentials. Links to the Admin
   * login tab specifically (?page=adminlogin) rather than the shared
   * ?page=login, since a brand-new admin has no reason to land on the
   * Hub Manager tab by default.
   */
  sendAdminWelcomeEmail: function (admin) {
    var appUrl = ScriptApp.getService().getUrl();
    var resetLink = appUrl + '?page=resetpassword'
      + '&email=' + encodeURIComponent(admin.Email)
      + '&token=' + encodeURIComponent(admin.ResetToken);
    var loginLink = appUrl + '?page=adminlogin';

    var subject = 'Welcome to ' + APP_CONFIG.APP_NAME + ' — Set Up Your Account';

    var roleLabel = accessLevelLabel_(admin.AccessLevel);

    var body =
      'Hi ' + admin.FirstName + ',\n\n' +
      'An administrator account has been created for you on the ' + APP_CONFIG.APP_NAME + ', with the role: ' + roleLabel + '.\n\n' +
      'Your login email is: ' + admin.Email + '\n\n' +
      'To get started, set your own password here:\n' +
      resetLink + '\n\n' +
      'This link expires in ' + APP_CONFIG.RESET_TOKEN_HOURS + ' hours. If it expires, ask a Super Admin to resend your credentials.\n\n' +
      'After that, you can log in any time at:\n' + loginLink + '\n\n' +
      '— ' + APP_CONFIG.APP_NAME + ' Team';

    var htmlBody =
      '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1f2430;">' +
        '<div style="background:linear-gradient(135deg,#feca38,#ffdd6b);border-radius:14px;padding:1.5rem;text-align:center;margin-bottom:1.5rem;">' +
          '<h2 style="margin:0;color:#12172b;">Welcome to ' + escapeHtml_(APP_CONFIG.APP_NAME) + '</h2>' +
        '</div>' +
        '<p>Hi ' + escapeHtml_(admin.FirstName) + ',</p>' +
        '<p>An administrator account has been created for you, with the role:</p>' +
        '<p style="font-weight:600;font-size:1.05rem;color:#12172b;">' + escapeHtml_(roleLabel) + '</p>' +
        '<p>Your login email is:</p>' +
        '<p style="font-weight:600;font-size:1.05rem;">' + escapeHtml_(admin.Email) + '</p>' +
        '<p>To get started, set your own password:</p>' +
        '<p style="text-align:center;margin:1.5rem 0;">' +
          '<a href="' + resetLink + '" style="background:linear-gradient(135deg,#feca38,#ffdd6b);color:#12172b;text-decoration:none;font-weight:700;padding:.75rem 1.5rem;border-radius:999px;display:inline-block;">Set My Password</a>' +
        '</p>' +
        '<p style="color:#6b7280;font-size:.85rem;">This link expires in ' + APP_CONFIG.RESET_TOKEN_HOURS + ' hours. If it expires, ask a Super Admin to resend your credentials.</p>' +
        '<p style="color:#6b7280;font-size:.85rem;">After that, you can log in any time at: <a href="' + loginLink + '">' + loginLink + '</a></p>' +
      '</div>';

    MailApp.sendEmail({
      to: admin.Email,
      subject: subject,
      body: body,
      htmlBody: htmlBody,
      name: APP_CONFIG.APP_NAME
    });
  },

  /**
   * Self-service "forgot password" email — same reset-link mechanism as
   * sendManagerWelcomeEmail, just triggered by the account holder
   * themselves (PasswordReset.gs) instead of an Admin creating/resending
   * credentials, and works for either role.
   */
  sendPasswordResetEmail: function (account, role) {
    var appUrl = ScriptApp.getService().getUrl();
    var resetLink = appUrl + '?page=resetpassword'
      + '&email=' + encodeURIComponent(account.Email)
      + '&token=' + encodeURIComponent(account.ResetToken);
    var loginLink = appUrl + '?page=' + (role === 'Admin' ? 'adminlogin' : 'managerlogin');

    var subject = 'Reset Your ' + APP_CONFIG.APP_NAME + ' Password';

    var body =
      'Hi ' + account.FirstName + ',\n\n' +
      'We received a request to reset the password for your ' + APP_CONFIG.APP_NAME + ' account (' + account.Email + ').\n\n' +
      'If this was you, set a new password here:\n' +
      resetLink + '\n\n' +
      'This link expires in ' + APP_CONFIG.RESET_TOKEN_HOURS + ' hours.\n\n' +
      'If you did not request this, you can safely ignore this email — your password will not change.\n\n' +
      'You can always sign in at:\n' + loginLink + '\n\n' +
      '— ' + APP_CONFIG.APP_NAME + ' Team';

    var htmlBody =
      '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1f2430;">' +
        '<div style="background:linear-gradient(135deg,#feca38,#ffdd6b);border-radius:14px;padding:1.5rem;text-align:center;margin-bottom:1.5rem;">' +
          '<h2 style="margin:0;color:#12172b;">Reset Your Password</h2>' +
        '</div>' +
        '<p>Hi ' + escapeHtml_(account.FirstName) + ',</p>' +
        '<p>We received a request to reset the password for your ' + escapeHtml_(APP_CONFIG.APP_NAME) + ' account:</p>' +
        '<p style="font-weight:600;font-size:1.05rem;">' + escapeHtml_(account.Email) + '</p>' +
        '<p>If this was you, set a new password:</p>' +
        '<p style="text-align:center;margin:1.5rem 0;">' +
          '<a href="' + resetLink + '" style="background:linear-gradient(135deg,#feca38,#ffdd6b);color:#12172b;text-decoration:none;font-weight:700;padding:.75rem 1.5rem;border-radius:999px;display:inline-block;">Reset My Password</a>' +
        '</p>' +
        '<p style="color:#6b7280;font-size:.85rem;">This link expires in ' + APP_CONFIG.RESET_TOKEN_HOURS + ' hours. If you did not request this, you can safely ignore this email — your password will not change.</p>' +
      '</div>';

    MailApp.sendEmail({
      to: account.Email,
      subject: subject,
      body: body,
      htmlBody: htmlBody,
      name: APP_CONFIG.APP_NAME
    });
  },

  /**
   * Sends a beneficiary a welcome email right after they register (web
   * or PWA — both routes call this whenever an Email address was given;
   * it's optional on the form, so this simply no-ops when there isn't one).
   * Copy is fixed/verbatim per Hub program messaging, not templated per-Hub.
   */
  sendBeneficiaryWelcomeEmail: function (beneficiary) {
    var name = beneficiary.FirstName;
    var subject = 'Welcome to the Solar Community Hub! 🌱💻';

    var body =
      'Dear ' + name + ',\n\n' +
      'Welcome to the Solar Community Hub! We are delighted to have you with us.\n\n' +
      'Our Hub is a space where technology, learning, innovation, and community come together. Whether you are here to learn new digital skills, use a computer, access the internet, attend a training session, work on a project, meet with a community group, or explore new ideas, we hope your time with us will be valuable and inspiring.\n\n' +
      'At the Solar Community Hub, you can take part in activities such as:\n\n' +
      '💻 Digital and computer skills training\n' +
      '🤖 Artificial Intelligence and emerging technology\n' +
      '📚 Online learning and access to educational resources\n' +
      '🌱 Environmental conservation and community activities\n' +
      '👥 Community meetings, workshops and group activities\n' +
      '🚀 Innovation, entrepreneurship and digital projects\n' +
      '🌐 Access to computers, internet and other digital resources\n\n' +
      'Your participation helps us understand how the Hub is being used and how we can continue improving the services we provide to our community.\n\n' +
      'We would love to hear from you!\n\n' +
      'Before you leave, please take a moment to share your experience. Tell us what you worked on, what you learned, what you enjoyed, and what we could do better.\n\n' +
      'Your feedback matters. It helps us make the Solar Community Hub more useful and responsive to the needs of our community.\n\n' +
      'Thank you for being part of our community, and we hope to see you again soon!\n\n' +
      'Warm regards,\n' +
      'The Solar Community Hub Team\n' +
      'Connecting communities. Empowering people. Creating opportunities through technology.';

    MailApp.sendEmail({
      to: beneficiary.Email,
      subject: subject,
      body: body,
      name: 'The Solar Community Hub Team'
    });
  }
};

/** Minimal HTML-escaping for values interpolated into email HTML. */
function escapeHtml_(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
