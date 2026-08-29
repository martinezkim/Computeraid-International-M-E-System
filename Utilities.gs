/**
 * ============================================================
 * UTILITIES.GS — Shared helper functions
 * ============================================================
 */

/**
 * Standard envelope for every server response sent to the client.
 * Keeps frontend success/error handling identical across all modules.
 */
function buildResponse(success, data, message) {
  return {
    success: success,
    data: data || null,
    message: message || ''
  };
}

/**
 * Wraps a function call in try/catch and returns a standardized
 * response object, so every *.gs module can stay focused on logic
 * instead of repeating error handling.
 */
function safeExecute(fn) {
  try {
    var result = fn();
    return buildResponse(true, result);
  } catch (err) {
    return buildResponse(false, null, err.message);
  }
}

/**
 * Applies search, sort, and pagination to an array of records in
 * one pass. Every module's "list" endpoint (Countries, Hubs, ...)
 * funnels through this so behavior is identical everywhere.
 *
 * options = {
 *   search: 'kenya',
 *   searchColumns: ['CountryName', 'ISOCode'],
 *   sortBy: 'CountryName',
 *   sortDir: 'asc' | 'desc',
 *   page: 1,
 *   pageSize: 10
 * }
 */
function paginateAndFilter(records, options) {
  options = options || {};
  var result = records.slice();

  if (options.search && options.searchColumns && options.searchColumns.length) {
    var term = String(options.search).toLowerCase();
    result = result.filter(function (row) {
      return options.searchColumns.some(function (col) {
        return String(row[col] || '').toLowerCase().indexOf(term) !== -1;
      });
    });
  }

  if (options.sortBy) {
    var dir = options.sortDir === 'desc' ? -1 : 1;
    result.sort(function (a, b) {
      var rawA = a[options.sortBy];
      var rawB = b[options.sortBy];
      var numA = Number(rawA);
      var numB = Number(rawB);
      var bothNumeric = rawA !== '' && rawA != null && rawB !== '' && rawB != null && !isNaN(numA) && !isNaN(numB);

      if (bothNumeric) {
        return (numA - numB) * dir;
      }

      var av = String(rawA || '').toLowerCase();
      var bv = String(rawB || '').toLowerCase();
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  var total = result.length;
  var pageSize = options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE;
  var page = options.page || 1;
  var totalPages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.min(Math.max(1, page), totalPages);

  var start = (page - 1) * pageSize;
  var pageData = result.slice(start, start + pageSize);

  return {
    records: pageData,
    pagination: {
      page: page,
      pageSize: pageSize,
      totalRecords: total,
      totalPages: totalPages
    }
  };
}

/**
 * Attaches a human-readable name from a parent table onto each
 * record, based on a foreign key value. This is what keeps the
 * "store ID, display name" rule intact without ever duplicating
 * names inside the child sheet.
 *
 * e.g. resolveForeignKey(hubs, 'CountryID', 'Countries', 'CountryName', 'CountryName')
 *      -> each hub gains a `.CountryName` field for display.
 */
function resolveForeignKey(records, fkColumn, parentTable, parentDisplayColumn, outputAlias) {
  var parentRecords = DB.getAll(parentTable);
  var parentSchema = SCHEMA[parentTable];
  var lookup = {};
  parentRecords.forEach(function (p) {
    lookup[p[parentSchema.primaryKey]] = p[parentDisplayColumn];
  });

  records.forEach(function (row) {
    row[outputAlias] = lookup.hasOwnProperty(row[fkColumn]) ? lookup[row[fkColumn]] : '';
  });

  return records;
}

/**
 * ============================================================
 * CREDENTIAL HELPERS
 * ============================================================
 * Generic enough for any future credentialed-login table, not
 * just Hub Managers — passwords are always salted + hashed,
 * never stored or returned in plain text.
 * ============================================================
 */

/** Generates a random temporary password (unambiguous character set). */
function generateRandomPassword(length) {
  length = length || 10;
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  var password = '';
  for (var i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/** Generates a long, hard-to-guess token for reset links / session IDs. */
function generateSecureToken() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

/** Hashes a password with a salt using SHA-256, returned as a hex string. */
function hashPassword(plainPassword, salt) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(plainPassword) + String(salt));
  return digest.map(function (byte) {
    var v = (byte < 0 ? byte + 256 : byte).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/** Verifies a plaintext password against a stored salt + hash. */
function verifyPassword(plainPassword, salt, expectedHash) {
  return hashPassword(plainPassword, salt) === expectedHash;
}
