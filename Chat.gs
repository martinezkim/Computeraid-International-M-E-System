/**
 * ============================================================
 * CHAT.GS — Internal 1-to-1 messaging (Module 3)
 * ============================================================
 * Lets the UK roles (M&E Lead, Accountant) request clarifications from
 * Hub Managers and Country Directors, and reply back — open to any
 * authenticated Admin (any AccessLevel) or Hub Manager, both directions.
 * No public/anonymous access; every function is requireIdentity_-gated
 * and every thread/message read is scoped to the two actual
 * participants (see assertThreadParticipant_).
 *
 * No real-time push in Apps Script — the client polls getUnreadChatCount
 * for the topnav badge and getThreadMessages while a conversation is
 * open, same "poll on an interval" pattern NotificationsJS.html already
 * uses for the bell icon.
 *
 * A thread is exactly one pair of participants, keyed by their emails in
 * a canonical (alphabetical) order — see findOrCreateThread_ — so
 * re-opening a conversation with the same person always reuses the same
 * thread rather than forking a new one. Per-participant read state lives
 * on the thread itself (ParticipantALastReadAt/ParticipantBLastReadAt),
 * not per-message — simpler, and all "unread" needs here are "how many
 * messages after I last looked," never per-message read receipts.
 * ============================================================
 */

var CHAT_THREADS_TABLE = 'ChatThreads';
var CHAT_MESSAGES_TABLE = 'ChatMessages';
var CHAT_MESSAGE_MAX_LENGTH = 2000;

/** Everyone the caller is allowed to start/continue a conversation with. */
function getMyContacts(sessionToken) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);

    var admins = DB.getAll(ADMINS_TABLE)
      .filter(function (a) { return a.Status === 'Active' && a.Email !== identity.email; })
      .map(function (a) { return { email: a.Email, name: adminFullName_(a), role: 'Admin', accessLevel: resolveAdminAccessLevel_(a) }; });

    if (identity.role === 'HubManager') {
      return admins;
    }

    var managers = DB.getAll(MANAGERS_TABLE)
      .filter(function (m) { return m.Status === 'Active'; })
      .map(function (m) { return { email: m.Email, name: managerFullName_(m), role: 'HubManager' }; });

    return managers.concat(admins);
  });
}

/** Every conversation the caller participates in, newest activity first, each with its unread count and the other participant's display info. */
function getMyThreads(sessionToken) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var myEmail = identity.email;

    var threads = DB.getAll(CHAT_THREADS_TABLE).filter(function (t) {
      return t.ParticipantAEmail === myEmail || t.ParticipantBEmail === myEmail;
    });
    if (!threads.length) return [];

    var contactLookup = chatContactLookup_();
    var messages = DB.getAll(CHAT_MESSAGES_TABLE);

    var result = threads.map(function (t) {
      var isA = t.ParticipantAEmail === myEmail;
      var otherEmail = isA ? t.ParticipantBEmail : t.ParticipantAEmail;
      var contact = contactLookup[otherEmail] || { name: otherEmail, role: '' };

      return {
        threadId: t.ThreadID,
        otherEmail: otherEmail,
        otherName: contact.name,
        otherRole: contact.role,
        lastMessageAt: t.LastMessageAt,
        lastMessagePreview: t.LastMessagePreview,
        unread: computeThreadUnread_(t, messages, myEmail)
      };
    });

    result.sort(function (a, b) { return String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)); });
    return result;
  });
}

/** Every message in one conversation, oldest first — the caller must be one of its two participants. */
function getThreadMessages(sessionToken, threadId) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var thread = assertThreadParticipant_(threadId, identity.email);

    return DB.getAll(CHAT_MESSAGES_TABLE)
      .filter(function (m) { return m.ThreadID === threadId; })
      .sort(function (a, b) { return new Date(a.SentAt) - new Date(b.SentAt); })
      .map(function (m) {
        return { messageId: m.MessageID, senderEmail: m.SenderEmail, body: m.Body, dateCreated: m.SentAt, mine: m.SenderEmail === identity.email };
      });
  });
}

/** Sends a message — finds or creates the thread with `toEmail`, appends the message, and notifies the recipient (same notify_ the rest of the app uses). */
function sendChatMessage(sessionToken, toEmail, body) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var trimmed = String(body || '').trim();
    if (!trimmed) throw new Error('Message cannot be empty.');
    if (trimmed.length > CHAT_MESSAGE_MAX_LENGTH) throw new Error('Message is too long (max ' + CHAT_MESSAGE_MAX_LENGTH + ' characters).');
    if (toEmail === identity.email) throw new Error('You cannot message yourself.');
    if (!getAdminByEmail_(toEmail) && !getManagerByEmail_(toEmail)) throw new Error('Recipient not found.');

    var thread = findOrCreateThread_(identity.email, toEmail);
    var nowIso = new Date().toISOString();

    var message = DB.insert(CHAT_MESSAGES_TABLE, {
      ThreadID: thread.ThreadID,
      SenderEmail: identity.email,
      Body: trimmed,
      SentAt: nowIso
    });

    var isA = thread.ParticipantAEmail === identity.email;
    var patch = { LastMessageAt: nowIso, LastMessagePreview: trimmed.slice(0, 140) };
    patch[isA ? 'ParticipantALastReadAt' : 'ParticipantBLastReadAt'] = nowIso; // sending counts as having read up to now
    DB.update(CHAT_THREADS_TABLE, thread.ThreadID, patch);

    notify_({
      type: 'ChatMessage', severity: 'info',
      message: (identity.fullName || identity.email) + ' sent you a message.',
      targetEmail: toEmail, relatedTable: CHAT_THREADS_TABLE, relatedRecordId: thread.ThreadID
    });

    return { messageId: message.MessageID, threadId: thread.ThreadID, dateCreated: message.SentAt };
  });
}

/** Marks everything in a conversation read up to now, for the caller only. */
function markChatThreadRead(sessionToken, threadId) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var thread = assertThreadParticipant_(threadId, identity.email);
    var isA = thread.ParticipantAEmail === identity.email;
    var patch = {};
    patch[isA ? 'ParticipantALastReadAt' : 'ParticipantBLastReadAt'] = new Date().toISOString();
    DB.update(CHAT_THREADS_TABLE, threadId, patch);
    return true;
  });
}

/** Total unread messages across every conversation — powers the topnav chat badge, polled the same way getMyNotifications already is. */
function getUnreadChatCount(sessionToken) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var myEmail = identity.email;
    var threads = DB.getAll(CHAT_THREADS_TABLE).filter(function (t) {
      return t.ParticipantAEmail === myEmail || t.ParticipantBEmail === myEmail;
    });
    if (!threads.length) return 0;
    var messages = DB.getAll(CHAT_MESSAGES_TABLE);
    return threads.reduce(function (sum, t) { return sum + computeThreadUnread_(t, messages, myEmail); }, 0);
  });
}

/** {email: {name, role}} for every Hub Manager and Admin — used to resolve a thread's "other participant" for display. */
function chatContactLookup_() {
  var lookup = {};
  DB.getAll(MANAGERS_TABLE).forEach(function (m) { lookup[m.Email] = { name: managerFullName_(m), role: 'HubManager' }; });
  DB.getAll(ADMINS_TABLE).forEach(function (a) { lookup[a.Email] = { name: adminFullName_(a), role: 'Admin' }; });
  return lookup;
}

/** How many messages in `thread` were sent by the other side after `myEmail` last read it. */
function computeThreadUnread_(thread, messages, myEmail) {
  var isA = thread.ParticipantAEmail === myEmail;
  var myLastReadAt = isA ? thread.ParticipantALastReadAt : thread.ParticipantBLastReadAt;
  return messages.filter(function (m) {
    return m.ThreadID === thread.ThreadID && m.SenderEmail !== myEmail &&
      (!myLastReadAt || new Date(m.SentAt) > new Date(myLastReadAt));
  }).length;
}

/** Finds the existing thread for this pair of emails, or creates one — canonically ordered so the pair always maps to one thread regardless of who looks it up first. */
function findOrCreateThread_(emailX, emailY) {
  var a = emailX < emailY ? emailX : emailY;
  var b = emailX < emailY ? emailY : emailX;

  var existing = DB.getAll(CHAT_THREADS_TABLE).filter(function (t) {
    return t.ParticipantAEmail === a && t.ParticipantBEmail === b;
  })[0];
  if (existing) return existing;

  return DB.insert(CHAT_THREADS_TABLE, {
    ParticipantAEmail: a,
    ParticipantBEmail: b,
    LastMessageAt: '',
    LastMessagePreview: '',
    ParticipantALastReadAt: '',
    ParticipantBLastReadAt: ''
  });
}

/** Loads a thread and throws unless `email` is actually one of its two participants — the real access check behind getThreadMessages/markChatThreadRead. */
function assertThreadParticipant_(threadId, email) {
  var thread = DB.getById(CHAT_THREADS_TABLE, threadId);
  if (!thread || (thread.ParticipantAEmail !== email && thread.ParticipantBEmail !== email)) {
    throw new Error('Conversation not found.');
  }
  return thread;
}
