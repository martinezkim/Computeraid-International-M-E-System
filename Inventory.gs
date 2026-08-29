/**
 * ============================================================
 * INVENTORY.GS — "Inventory at the Hub" module
 * ============================================================
 * One row per physical asset/equipment item held at a Hub
 * Manager's own hub. Same hub-scoping pattern as Projects.gs:
 * HubID is never supplied by the client — it's resolved
 * server-side from the caller's own Hub Manager session
 * (requireManagerSession_, defined in Projects.gs), so a manager
 * can only ever see/manage their own hub's inventory. Every
 * mutation re-checks that the record being touched still belongs
 * to that hub, so a manager can't edit/delete another hub's item
 * by guessing its ID.
 *
 * "Laptops for Sale" is a separate, not-yet-built sub-section
 * (see the "Coming soon" link in Sidebar.html) — this module is
 * "Inventory at the Hub" only.
 * ============================================================
 */

var INVENTORY_TABLE = 'Inventory';

var INVENTORY_CATEGORIES = [
  'Desktop Computers', 'Laptops', 'Printers', 'Projectors',
  'Routers / Networking Equipment', 'Solar Equipment', 'VR Headsets',
  'Tablets', 'UPS / Power Backup', 'Other Devices'
];

var INVENTORY_CONDITIONS = ['New', 'Refurbished'];

var INVENTORY_STATUSES = ['In Use', 'In Storage', 'Under Repair', 'Faulty', 'Decommissioned'];

/**
 * Returns the Category/Condition/Status option lists so the Add/Edit
 * form and filter dropdowns are built from one source of truth.
 */
function getInventoryFormOptions(sessionToken) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    return {
      categories: INVENTORY_CATEGORIES,
      conditions: INVENTORY_CONDITIONS,
      statuses: INVENTORY_STATUSES
    };
  });
}

/**
 * Returns every inventory item at the calling Hub Manager's own hub,
 * filterable by category and/or status, with the usual search/sort/pagination.
 * @param {string} sessionToken
 * @param {Object} options {search, sortBy, sortDir, page, pageSize, category, status}
 */
function getMyInventory(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};

    var all = DB.getAll(INVENTORY_TABLE).filter(function (item) { return item.HubID === manager.hubId; });

    if (options.category) {
      all = all.filter(function (item) { return item.Category === options.category; });
    }
    if (options.status) {
      all = all.filter(function (item) { return item.Status === options.status; });
    }
    if (options.dateFrom) {
      all = all.filter(function (item) { return item.DateAcquired && item.DateAcquired >= options.dateFrom; });
    }
    if (options.dateTo) {
      all = all.filter(function (item) { return item.DateAcquired && item.DateAcquired <= options.dateTo; });
    }

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[INVENTORY_TABLE].searchableColumns,
      sortBy: options.sortBy || 'DateAcquired',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Full breakdown for the "Inventory Summary" dashboard: totals by
 * category (Total Desktops, Total Laptops, ...) and totals by status
 * (In Use / In Storage / Under Repair / Faulty / Decommissioned),
 * quantity-weighted, for the calling Hub Manager's own hub.
 */
function getMyInventoryOverview(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var mine = DB.getAll(INVENTORY_TABLE).filter(function (item) { return item.HubID === manager.hubId; });

    var byCategory = {};
    INVENTORY_CATEGORIES.forEach(function (c) { byCategory[c] = 0; });

    var byStatus = {};
    INVENTORY_STATUSES.forEach(function (s) { byStatus[s] = 0; });

    var totalAssets = 0;
    mine.forEach(function (item) {
      var qty = Number(item.Quantity) || 0;
      totalAssets += qty;
      if (byCategory.hasOwnProperty(item.Category)) byCategory[item.Category] += qty;
      if (byStatus.hasOwnProperty(item.Status)) byStatus[item.Status] += qty;
    });

    return { totalAssets: totalAssets, byCategory: byCategory, byStatus: byStatus };
  });
}

/**
 * Small counts strip for the page header: how many items are currently
 * In Use / In Storage / Under Repair / Faulty / Decommissioned, plus a total.
 * Quantity-weighted — a row with Quantity 5 counts as 5 units, since
 * that's what a Hub Manager actually cares about ("how many do we have").
 */
function getMyInventorySummary(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var mine = DB.getAll(INVENTORY_TABLE).filter(function (item) { return item.HubID === manager.hubId; });

    var summary = { totalLines: mine.length, totalUnits: 0, inUse: 0, inStorage: 0, underRepair: 0, faulty: 0, decommissioned: 0 };
    mine.forEach(function (item) {
      var qty = Number(item.Quantity) || 0;
      summary.totalUnits += qty;
      if (item.Status === 'In Use') summary.inUse += qty;
      else if (item.Status === 'In Storage') summary.inStorage += qty;
      else if (item.Status === 'Under Repair') summary.underRepair += qty;
      else if (item.Status === 'Faulty') summary.faulty += qty;
      else if (item.Status === 'Decommissioned') summary.decommissioned += qty;
    });
    return summary;
  });
}

/** Adds a new inventory item to the calling Hub Manager's own hub. */
function addInventoryItem(sessionToken, data) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var error = validateInventoryInput(data);
    if (error) throw new Error(error);

    var record = DB.insert(INVENTORY_TABLE, {
      HubID: manager.hubId,
      Category: data.Category,
      ItemName: String(data.ItemName).trim(),
      Manufacturer: (data.Manufacturer || '').trim(),
      Model: (data.Model || '').trim(),
      SerialNumber: (data.SerialNumber || '').trim(),
      Quantity: Number(data.Quantity),
      Condition: data.Condition,
      DateAcquired: parseDateOnly_(data.DateAcquired),
      Status: data.Status,
      PhotoURL: (data.PhotoURL || '').trim()
    });

    logAudit_(manager, 'Create', INVENTORY_TABLE, record.InventoryID, '(record)', '',
      record.Category + ' — ' + record.ItemName + ' (qty ' + record.Quantity + ')', manager.hubId);

    return record;
  });
}

/**
 * Updates an inventory item — including just its Condition and/or
 * Status, e.g. moving something from "In Use" to "Under Repair" as
 * things change over time. Refuses if the item doesn't belong to the
 * caller's own hub.
 */
function updateInventoryItem(sessionToken, id, data) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var existing = DB.getById(INVENTORY_TABLE, id);
    if (!existing || existing.HubID !== manager.hubId) {
      throw new Error('Inventory item not found.');
    }

    var error = validateInventoryInput(data);
    if (error) throw new Error(error);

    var updated = DB.update(INVENTORY_TABLE, id, {
      Category: data.Category,
      ItemName: String(data.ItemName).trim(),
      Manufacturer: (data.Manufacturer || '').trim(),
      Model: (data.Model || '').trim(),
      SerialNumber: (data.SerialNumber || '').trim(),
      Quantity: Number(data.Quantity),
      Condition: data.Condition,
      DateAcquired: parseDateOnly_(data.DateAcquired),
      Status: data.Status,
      PhotoURL: (data.PhotoURL || '').trim()
    });

    logAuditDiff_(manager, INVENTORY_TABLE, id, existing, updated, manager.hubId);
    return updated;
  });
}

/** Deletes an inventory item — refuses if it doesn't belong to the caller's own hub. */
function deleteInventoryItem(sessionToken, id) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var existing = DB.getById(INVENTORY_TABLE, id);
    if (!existing || existing.HubID !== manager.hubId) {
      throw new Error('Inventory item not found.');
    }
    DB.remove(INVENTORY_TABLE, id);
    logAudit_(manager, 'Delete', INVENTORY_TABLE, id, '(record)',
      existing.Category + ' — ' + existing.ItemName + ' (qty ' + existing.Quantity + ')', '', manager.hubId);
    return true;
  });
}

/** Shared validation for add/edit. */
function validateInventoryInput(data) {
  var error = Validate.run([
    [Validate.required, data && data.Category, 'Category'],
    [Validate.oneOf, data && data.Category, INVENTORY_CATEGORIES, 'Category'],
    [Validate.required, data && data.ItemName, 'Item name/description'],
    [Validate.maxLength, data && data.ItemName, 150, 'Item name/description'],
    [Validate.maxLength, data && data.Manufacturer, 100, 'Manufacturer'],
    [Validate.maxLength, data && data.Model, 100, 'Model'],
    [Validate.maxLength, data && data.SerialNumber, 100, 'Serial number'],
    [Validate.required, data && data.Quantity, 'Quantity'],
    [Validate.wholeNumber, data && data.Quantity, 'Quantity'],
    [Validate.required, data && data.Condition, 'Condition'],
    [Validate.oneOf, data && data.Condition, INVENTORY_CONDITIONS, 'Condition'],
    [Validate.required, data && data.DateAcquired, 'Date acquired'],
    [Validate.required, data && data.Status, 'Status'],
    [Validate.oneOf, data && data.Status, INVENTORY_STATUSES, 'Status'],
    [Validate.maxLength, data && data.PhotoURL, 500, 'Photo URL']
  ]);
  if (error) return error;

  if (Number(data.Quantity) < 1) {
    return 'Quantity must be at least 1.';
  }

  var acquiredDate = parseDateOnly_(data.DateAcquired);
  if (!acquiredDate || isNaN(acquiredDate.getTime())) {
    return 'Date acquired must be a valid date.';
  }
  if (acquiredDate.getTime() > Date.now()) {
    return 'Date acquired cannot be in the future.';
  }

  return null;
}
