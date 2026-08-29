/**
 * ============================================================
 * VALIDATION.GS — Reusable field validators
 * ============================================================
 * Every module validates input server-side (never trust the
 * client) by composing these small checks with Validate.run().
 * ============================================================
 */

var Validate = {

  required: function (value, fieldName) {
    if (value === undefined || value === null || String(value).trim() === '') {
      return fieldName + ' is required.';
    }
    return null;
  },

  maxLength: function (value, max, fieldName) {
    if (value && String(value).length > max) {
      return fieldName + ' must be at most ' + max + ' characters.';
    }
    return null;
  },

  minLength: function (value, min, fieldName) {
    if (value && String(value).length < min) {
      return fieldName + ' must be at least ' + min + ' characters.';
    }
    return null;
  },

  exactLength: function (value, len, fieldName) {
    if (value && String(value).length !== len) {
      return fieldName + ' must be exactly ' + len + ' characters.';
    }
    return null;
  },

  isEmail: function (value, fieldName) {
    var re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (value && !re.test(value)) {
      return fieldName + ' must be a valid email address.';
    }
    return null;
  },

  isPhone: function (value, fieldName) {
    var re = /^[+0-9\s\-()]{7,20}$/;
    if (value && !re.test(value)) {
      return fieldName + ' must be a valid phone number.';
    }
    return null;
  },

  /** A non-negative whole number — for beneficiary counts, ages, etc. */
  wholeNumber: function (value, fieldName) {
    if (value === undefined || value === null || value === '') return null; // let required() handle emptiness
    var num = Number(value);
    if (isNaN(num) || !isFinite(num) || num < 0 || Math.floor(num) !== num) {
      return fieldName + ' must be a whole number of 0 or more.';
    }
    return null;
  },

  /** A non-negative number that may include decimals — for dollar amounts like Cost. */
  nonNegativeNumber: function (value, fieldName) {
    if (value === undefined || value === null || value === '') return null; // let required() handle emptiness
    var num = Number(value);
    if (isNaN(num) || !isFinite(num) || num < 0) {
      return fieldName + ' must be a number of 0 or more.';
    }
    return null;
  },

  oneOf: function (value, allowed, fieldName) {
    if (value && allowed.indexOf(value) === -1) {
      return fieldName + ' must be one of: ' + allowed.join(', ');
    }
    return null;
  },

  /** Confirms a foreign key value actually exists in its parent table. */
  exists: function (tableName, id, fieldName) {
    if (!id) return null; // let required() handle emptiness separately
    var record = DB.getById(tableName, id);
    if (!record) {
      return fieldName + ' references a record that does not exist.';
    }
    return null;
  },

  /**
   * Runs a list of [checkFn, ...args] tuples and returns the first
   * error found, or null if everything passes.
   * e.g. Validate.run([
   *   [Validate.required, data.CountryName, 'Country name'],
   *   [Validate.maxLength, data.CountryName, 100, 'Country name']
   * ])
   */
  run: function (checks) {
    for (var i = 0; i < checks.length; i++) {
      var check = checks[i];
      var fn = check[0];
      var args = check.slice(1);
      var error = fn.apply(Validate, args);
      if (error) return error;
    }
    return null;
  }
};
