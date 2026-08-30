/**
 * ============================================================
 * DATABASE.GS — Generic relational-style data access layer
 * ============================================================
 * Every table (sheet) is accessed exclusively through these
 * functions. No other module should touch SpreadsheetApp
 * directly. This isolation is what makes a future MySQL
 * migration mostly a matter of rewriting THIS file only —
 * every module above it (Countries.gs, Hubs.gs, ...) would
 * keep working unchanged against the same DB.* API.
 * ============================================================
 */

var DB = {

  /** Returns the working spreadsheet (bound file, or by ID). */
  getSpreadsheet: function () {
    if (APP_CONFIG.SPREADSHEET_ID) {
      return SpreadsheetApp.openById(APP_CONFIG.SPREADSHEET_ID);
    }
    return SpreadsheetApp.getActiveSpreadsheet();
  },

  /** Gets (or lazily creates) the sheet for a given table name. */
  getSheet: function (tableName) {
    var schema = this._getSchema(tableName);
    var ss = this.getSpreadsheet();
    var sheet = ss.getSheetByName(schema.sheetName);
    if (!sheet) {
      sheet = this._createTable(tableName);
    } else {
      this._ensureColumns(sheet, schema);
    }
    return sheet;
  },

  /**
   * The DB is positional — getAll reads getRange(2,1,rows,columns.length)
   * and insert appendRow()s a full-width array, both keyed by a column's
   * INDEX in schema.columns, never by matching a header name. So when a
   * schema gains a column (always appended at the end), the physical sheet
   * must have at least that many columns or getRange throws "range exceeds
   * grid". A sheet created with N columns never grows on its own until an
   * insert happens, so a read-before-insert after a schema append would
   * crash. This widens the grid to fit and backfills the (cosmetic) header
   * names for the new columns the first time we notice the shortfall —
   * making every append self-healing with no manual migration. Cheap: only
   * a getMaxColumns() call in the common case, real work only right after
   * a schema grows.
   */
  _ensureColumns: function (sheet, schema) {
    var needed = schema.columns.length;
    var have = sheet.getMaxColumns();
    if (have >= needed) return;
    sheet.insertColumnsAfter(have, needed - have);
    var headerRange = sheet.getRange(1, 1, 1, needed);
    var headers = headerRange.getValues()[0];
    for (var c = 0; c < needed; c++) {
      if (!headers[c]) headers[c] = schema.columns[c];
    }
    headerRange.setValues([headers]);
  },

  /** Creates every table defined in SCHEMA that doesn't exist yet. */
  initializeAllTables: function () {
    for (var tableName in SCHEMA) {
      this.getSheet(tableName);
    }
  },

  /** Creates a sheet with a bold, frozen header row for the given table. */
  _createTable: function (tableName) {
    var schema = this._getSchema(tableName);
    var ss = this.getSpreadsheet();
    var sheet = ss.insertSheet(schema.sheetName);
    sheet.appendRow(schema.columns);
    sheet.getRange(1, 1, 1, schema.columns.length)
      .setFontWeight('bold')
      .setBackground('#12172b')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    return sheet;
  },

  _getSchema: function (tableName) {
    var schema = SCHEMA[tableName];
    if (!schema) {
      throw new Error('Unknown table: ' + tableName);
    }
    return schema;
  },

  /**
   * Reads every row of a table and returns it as an array of
   * plain objects keyed by column name (plus an internal
   * _rowIndex used by update/remove).
   */
  getAll: function (tableName) {
    var schema = this._getSchema(tableName);
    var sheet = this.getSheet(tableName);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    var lastCol = schema.columns.length;
    var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    var records = [];

    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      if (row.join('') === '') continue; // skip blank rows
      records.push(this._rowToObject(schema, row, i + 2));
    }
    return records;
  },

  /**
   * Converts a raw sheet row into a keyed object. Date-typed cells are
   * formatted to a plain 'yyyy-MM-dd' display string — fine for things
   * like DateCreated, but NEVER store a time-sensitive value (session/
   * token expiries) as a raw Date for this reason: it would lose its
   * time-of-day here and could look "expired" hours early. Those fields
   * must be written as ISO strings instead (see ManagerAuth.gs), so they
   * pass through this method untouched.
   *
   * Separately: a plain "HH:mm" string (e.g. OpenTime, ArrivalTime) that
   * gets written into a cell is silently auto-converted by Sheets into a
   * real time-of-day value stamped with Sheets' own date epoch, Dec 30
   * 1899 — this is Sheets' behavior on write, not something this code
   * does. Reading it back as a Date and formatting with 'yyyy-MM-dd'
   * then shows that meaningless epoch date ("1899-12-30") instead of the
   * actual time. Detected here by the epoch date and formatted as
   * 'HH:mm' instead, so every time-only field is correct on read without
   * each module needing its own workaround.
   *
   * CORRECTED (was wrong — caused a live bug, see below): both branches
   * use the script's real timezone, not UTC. `Range.getValue()` on a
   * date/time-formatted cell builds the Date using the SPREADSHEET's own
   * bound timezone (which should match Session.getScriptTimeZone() —
   * Africa/Nairobi here), not plain UTC — so a value typed as "09:33"
   * gets anchored as 1899-12-30 09:33 Nairobi time, whose UTC instant is
   * 06:33Z. The previous version formatted that instant with 'Etc/UTC',
   * which just reads the UTC components straight off (06:33) — silently
   * re-applying the timezone offset a second time and shifting every
   * time-only field back by the zone's offset (confirmed live: a Hub
   * Visit's ArrivalTime consistently displayed exactly 3 hours early).
   * Formatting with the script's timezone instead cancels that offset
   * out correctly, the same way the date-only branch already did (which
   * is exactly why DATE fields were never seen to have this bug).
   */
  _rowToObject: function (schema, row, rowIndex) {
    var obj = { _rowIndex: rowIndex };
    for (var c = 0; c < schema.columns.length; c++) {
      var value = row[c];
      if (value instanceof Date) {
        // Dec 29 as well as Dec 30 — a time near midnight local can roll
        // the Date's UTC representation back a calendar day once anchored
        // to the script's (positive UTC-offset) timezone; both are really
        // still "1899-12-30 in the script's own timezone".
        var isTimeOnly = value.getUTCFullYear() === 1899 && value.getUTCMonth() === 11 && (value.getUTCDate() === 30 || value.getUTCDate() === 29);
        value = isTimeOnly
          ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm')
          : Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
      obj[schema.columns[c]] = value;
    }
    return obj;
  },

  /** Finds a single record by primary key value. */
  getById: function (tableName, id) {
    var schema = this._getSchema(tableName);
    var all = this.getAll(tableName);
    for (var i = 0; i < all.length; i++) {
      if (String(all[i][schema.primaryKey]) === String(id)) {
        return all[i];
      }
    }
    return null;
  },

  /**
   * Finds records matching a simple equality filter, e.g.
   * DB.findWhere('Hubs', 'CountryID', 'C001')
   */
  findWhere: function (tableName, column, value) {
    var all = this.getAll(tableName);
    return all.filter(function (row) {
      return String(row[column]) === String(value);
    });
  },

  /**
   * Inserts a new record. For auto-ID tables, generates the primary key;
   * for natural-key tables (schema.autoId === false, e.g. HubManagers
   * keyed by Email), uses the caller-provided value and enforces
   * uniqueness. Stamps DateCreated/DateModified where those columns exist.
   */
  insert: function (tableName, data) {
    var schema = this._getSchema(tableName);
    var sheet = this.getSheet(tableName);
    var now = new Date();
    var newId;

    if (schema.autoId === false) {
      newId = data[schema.primaryKey];
      if (!newId) {
        throw new Error(schema.primaryKey + ' is required.');
      }
      if (this.getById(tableName, newId)) {
        throw new Error(schema.sheetName + ' already has a record with ' + schema.primaryKey + ' = ' + newId);
      }
    } else {
      newId = this.generateId(tableName);
    }

    var record = {};
    record[schema.primaryKey] = newId;

    schema.columns.forEach(function (col) {
      if (col === schema.primaryKey) return;
      if (col === 'DateCreated' || col === 'DateModified') {
        record[col] = now;
      } else {
        record[col] = data.hasOwnProperty(col) ? data[col] : '';
      }
    });

    var row = schema.columns.map(function (col) { return record[col]; });
    sheet.appendRow(row);

    return this.getById(tableName, newId);
  },

  /**
   * Updates an existing record by primary key. Only columns present in
   * `data` are changed; everything else is left completely untouched —
   * literally not written to at all, not "rewritten with its current
   * value". That distinction matters: a cell holding an "HH:mm"-only
   * time gets read back through _rowToObject's lossy time-only handling
   * (see its header comment — Sheets' own auto-conversion of that value
   * doesn't always land exactly on the expected 1899-12-30 epoch this
   * table's read logic checks for). Writing that already-reformatted
   * value straight back — which is what this function used to do for
   * every column not being changed — would silently and permanently
   * corrupt a time field on the very first unrelated update to that row
   * (e.g. closing a visit's linked ComputerSession, which never touches
   * ArrivalTime, could still clobber it). Skipping untouched columns
   * entirely avoids that failure mode altogether, for every table, not
   * just the ones this was first noticed on.
   */
  update: function (tableName, id, data) {
    var schema = this._getSchema(tableName);
    var sheet = this.getSheet(tableName);
    var existing = this.getById(tableName, id);

    if (!existing) {
      throw new Error(schema.sheetName + ' record not found: ' + id);
    }

    var now = new Date();
    schema.columns.forEach(function (col, idx) {
      if (col === schema.primaryKey || col === 'DateCreated') return; // immutable after insert, never rewritten
      if (col === 'DateModified') {
        sheet.getRange(existing._rowIndex, idx + 1).setValue(now);
        return;
      }
      if (!data.hasOwnProperty(col)) return; // not being changed — leave the cell exactly as it is
      sheet.getRange(existing._rowIndex, idx + 1).setValue(data[col]);
    });

    return this.getById(tableName, id);
  },

  /**
   * Permanently deletes a record by primary key.
   * (Kept distinct from a "soft delete", which just sets Status='Inactive'
   * via update() — modules choose whichever is appropriate.)
   */
  remove: function (tableName, id) {
    var schema = this._getSchema(tableName);
    var sheet = this.getSheet(tableName);
    var existing = this.getById(tableName, id);
    if (!existing) {
      throw new Error(schema.sheetName + ' record not found: ' + id);
    }
    sheet.deleteRow(existing._rowIndex);
    return true;
  },

  /**
   * Generates the next sequential ID for a table, e.g. C001, C002 ...
   * Scans existing IDs (rather than counting rows) so numbering
   * stays correct even after deletions.
   */
  generateId: function (tableName) {
    var schema = this._getSchema(tableName);
    var all = this.getAll(tableName);
    var maxNum = 0;

    all.forEach(function (row) {
      var id = String(row[schema.primaryKey] || '');
      var num = parseInt(id.replace(schema.idPrefix, ''), 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    });

    var nextNum = maxNum + 1;
    var padded = String(nextNum);
    while (padded.length < schema.idPadding) padded = '0' + padded;
    return schema.idPrefix + padded;
  },

  /**
   * Checks whether any child records reference a given parent ID
   * via a foreign key. Used to block deletes that would orphan data.
   * e.g. DB.hasDependents('Countries', 'C001', 'Hubs', 'CountryID')
   */
  hasDependents: function (parentTable, parentId, childTable, fkColumn) {
    var children = this.findWhere(childTable, fkColumn, parentId);
    return children.length > 0;
  }
};
