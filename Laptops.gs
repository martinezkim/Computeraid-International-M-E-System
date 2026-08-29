/**
 * ============================================================
 * LAPTOPS.GS — "Laptops for Sale" module
 * ============================================================
 * One row per laptop being resold, scoped to the calling Hub
 * Manager's own hub exactly like Inventory.gs and Projects.gs —
 * HubID is resolved server-side from the session, every mutation
 * re-checks ownership before touching a record.
 *
 * The three UI sub-sections (Current Stock / Sold / Faulty) are
 * NOT separate tables — they're filtered views of this one table
 * keyed on Status. A laptop only ever has one Status, so it can
 * never show up in more than one view at once, and "moving" a
 * laptop between sections is just editing its Status (see
 * updateLaptop / buildLaptopRecord_, which also clears/requires
 * the Buyer/Sale fields based on that Status).
 *
 * Spreadsheet import (previewLaptopImport / confirmLaptopImport)
 * expects rows already column-mapped client-side in LaptopsJS.html
 * (normalizeImportRow) from whatever headers the uploaded file used
 * (Barcode, ManName, "Blancco Processor", HDD, ...) to the same
 * field names this module already uses (AssetID, Manufacturer,
 * Processor, Storage, ...) — so validation logic only has to exist
 * once, shared between manual entry and import.
 * ============================================================
 */

var LAPTOPS_TABLE = 'Laptops';
var LAPTOP_CONDITIONS = ['New', 'Refurbished'];
var LAPTOP_STATUSES = ['Current Stock', 'Sold', 'Faulty'];

/** Condition/Status option lists for the Add/Edit form and filters. */
function getLaptopFormOptions(sessionToken) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    return { conditions: LAPTOP_CONDITIONS, statuses: LAPTOP_STATUSES };
  });
}

/**
 * Laptops at the calling Hub Manager's own hub — filterable by Status
 * (i.e. which of the three sub-sections is active), plus the extra
 * laptop-specific filters (manufacturer, processor, RAM, storage,
 * price range, date-added range) and the usual search/sort/pagination.
 */
function getMyLaptops(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};

    var all = DB.getAll(LAPTOPS_TABLE).filter(function (l) { return l.HubID === manager.hubId; });
    all = applyLaptopFilters_(all, options);

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[LAPTOPS_TABLE].searchableColumns,
      sortBy: options.sortBy || 'DateAdded',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Same scope/filters as getMyLaptops, but collapses individual units
 * into one card per distinct Manufacturer+Model+Status combination —
 * e.g. twenty identical "HP EliteBook 745 G6" units in Current Stock
 * become a single group with a count, instead of dozens of inventory
 * pages. The client shows a "Group by Model" toggle to switch between
 * this and the flat getMyLaptops list.
 */
function getMyLaptopsGrouped(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};

    var all = DB.getAll(LAPTOPS_TABLE).filter(function (l) { return l.HubID === manager.hubId; });
    all = applyLaptopFilters_(all, options);

    var searched = paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[LAPTOPS_TABLE].searchableColumns,
      page: 1,
      pageSize: Math.max(all.length, 1)
    }).records;

    return paginateGroupList_(groupLaptops_(searched, false), options);
  });
}

/** The manufacturer/processor/RAM/storage/price/date filter chain shared by getMyLaptops and getMyLaptopsGrouped. */
function applyLaptopFilters_(list, options) {
  options = options || {};
  if (options.status) list = list.filter(function (l) { return l.Status === options.status; });
  if (options.manufacturer) list = list.filter(function (l) { return l.Manufacturer === options.manufacturer; });
  if (options.processor) list = list.filter(function (l) { return l.Processor === options.processor; });
  if (options.ram) list = list.filter(function (l) { return l.RAM === options.ram; });
  if (options.storage) list = list.filter(function (l) { return l.Storage === options.storage; });
  if (options.priceMin !== undefined && options.priceMin !== '' && options.priceMin !== null) {
    list = list.filter(function (l) { return Number(l.SellingPrice) >= Number(options.priceMin); });
  }
  if (options.priceMax !== undefined && options.priceMax !== '' && options.priceMax !== null) {
    list = list.filter(function (l) { return Number(l.SellingPrice) <= Number(options.priceMax); });
  }
  if (options.dateFrom) list = list.filter(function (l) { return l.DateAdded && l.DateAdded >= options.dateFrom; });
  if (options.dateTo) list = list.filter(function (l) { return l.DateAdded && l.DateAdded <= options.dateTo; });
  return list;
}

/**
 * Collapses laptop rows into one group per distinct
 * Manufacturer+Model+Status (+Hub, when includeHub is true — the
 * Admin view spans multiple hubs, so two hubs' identical models stay
 * separate groups since they're physically different units). Each
 * group keeps its member records under `.units` so the client can
 * expand a card to the individual serials/prices without a second
 * server round-trip.
 */
function groupLaptops_(records, includeHub) {
  var groups = {};
  var order = [];

  records.forEach(function (l) {
    var key = (includeHub ? (l.HubID + '|') : '') + l.Manufacturer + '|' + l.Model + '|' + l.Status;
    if (!groups[key]) {
      groups[key] = {
        key: key,
        Manufacturer: l.Manufacturer,
        Model: l.Model,
        Status: l.Status,
        HubID: includeHub ? l.HubID : null,
        HubName: includeHub ? l.HubName : null,
        count: 0,
        priceMin: null,
        priceMax: null,
        totalValue: 0,
        units: []
      };
      order.push(key);
    }
    var g = groups[key];
    var price = Number(l.Status === 'Sold' ? l.SalePrice : l.SellingPrice) || 0;
    g.count++;
    g.totalValue += price;
    g.priceMin = g.priceMin === null ? price : Math.min(g.priceMin, price);
    g.priceMax = g.priceMax === null ? price : Math.max(g.priceMax, price);
    g.units.push(l);
  });

  return order.map(function (k) { return groups[k]; });
}

/** Sorts (by count or Manufacturer+Model) and paginates an already-built group list — mirrors paginateAndFilter's shape so the client's pagination UI works unchanged. */
function paginateGroupList_(groups, options) {
  options = options || {};
  var sortBy = options.groupSortBy || 'count';
  var dir = options.groupSortDir === 'asc' ? 1 : -1;

  groups = groups.slice().sort(function (a, b) {
    if (sortBy === 'count') return (a.count - b.count) * dir;
    var av = (a.Manufacturer + ' ' + a.Model).toLowerCase();
    var bv = (b.Manufacturer + ' ' + b.Model).toLowerCase();
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  var pageSize = options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE;
  var page = options.page || 1;
  var totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
  page = Math.min(Math.max(1, page), totalPages);
  var start = (page - 1) * pageSize;

  return {
    records: groups.slice(start, start + pageSize),
    pagination: { page: page, pageSize: pageSize, totalRecords: groups.length, totalPages: totalPages }
  };
}

/** Laptop Sales Summary numbers for the calling Hub Manager's own hub. */
function getMyLaptopsSummary(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var mine = DB.getAll(LAPTOPS_TABLE).filter(function (l) { return l.HubID === manager.hubId; });

    var summary = {
      totalLaptops: mine.length,
      currentStock: 0,
      sold: 0,
      faulty: 0,
      totalStockValue: 0,
      totalSalesValue: 0
    };

    mine.forEach(function (l) {
      if (l.Status === 'Current Stock') {
        summary.currentStock++;
        summary.totalStockValue += Number(l.SellingPrice) || 0;
      } else if (l.Status === 'Sold') {
        summary.sold++;
        summary.totalSalesValue += Number(l.SalePrice) || 0;
      } else if (l.Status === 'Faulty') {
        summary.faulty++;
      }
    });

    return summary;
  });
}

/** Distinct values already in use, to populate the Manufacturer/Processor/RAM/Storage filter dropdowns. */
function getMyLaptopFilterValues(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var mine = DB.getAll(LAPTOPS_TABLE).filter(function (l) { return l.HubID === manager.hubId; });

    function distinct(field) {
      var seen = {};
      var out = [];
      mine.forEach(function (l) {
        var v = String(l[field] || '').trim();
        if (v && !seen[v]) { seen[v] = true; out.push(v); }
      });
      return out.sort();
    }

    return {
      manufacturers: distinct('Manufacturer'),
      processors: distinct('Processor'),
      rams: distinct('RAM'),
      storages: distinct('Storage')
    };
  });
}

/** Next auto-suggested order number for this hub's next stock list/import batch. */
function suggestNextLaptopOrderNumber(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    return nextOrderNumber_(manager.hubId);
  });
}

function nextOrderNumber_(hubId) {
  var mine = DB.getAll(LAPTOPS_TABLE).filter(function (l) { return l.HubID === hubId; });
  var max = 0;
  mine.forEach(function (l) {
    var match = /(\d+)\s*$/.exec(String(l.OrderNumber || ''));
    if (match) {
      var n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  });
  var padded = String(max + 1);
  while (padded.length < 4) padded = '0' + padded;
  return 'ORD' + padded;
}

/** Adds a single laptop manually. */
function addLaptop(sessionToken, data) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var errors = validateLaptopInput(data, false);

    if (data && data.SerialNumber) {
      var dup = findLaptopBySerial_(manager.hubId, data.SerialNumber, null);
      if (dup) errors.push('A laptop with this serial number already exists (' + dup.InventoryID + ').');
    }
    if (errors.length) throw new Error(errors.join(' '));

    var orderNumber = String((data && data.OrderNumber) || '').trim() || nextOrderNumber_(manager.hubId);
    var record = DB.insert(LAPTOPS_TABLE, buildLaptopRecord_(manager.hubId, data, orderNumber, false));
    logAudit_(manager, 'Create', LAPTOPS_TABLE, record.InventoryID, '(record)', '',
      record.Manufacturer + ' ' + record.Model + ' (S/N ' + record.SerialNumber + ')', manager.hubId);
    return record;
  });
}

/**
 * Updates a laptop — including moving it between sub-sections by
 * changing its Status (e.g. Current Stock -> Sold, or -> Faulty).
 * Refuses if the record doesn't belong to the caller's own hub.
 */
function updateLaptop(sessionToken, id, data) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var existing = DB.getById(LAPTOPS_TABLE, id);
    if (!existing || existing.HubID !== manager.hubId) {
      throw new Error('Laptop record not found.');
    }

    var errors = validateLaptopInput(data, false);
    if (data && data.SerialNumber) {
      var dup = findLaptopBySerial_(manager.hubId, data.SerialNumber, id);
      if (dup) errors.push('Another laptop already uses this serial number (' + dup.InventoryID + ').');
    }
    if (errors.length) throw new Error(errors.join(' '));

    var orderNumber = String((data && data.OrderNumber) || '').trim() || existing.OrderNumber;
    var updated = DB.update(LAPTOPS_TABLE, id, buildLaptopRecord_(manager.hubId, data, orderNumber, true));
    logAuditDiff_(manager, LAPTOPS_TABLE, id, existing, updated, manager.hubId);
    return updated;
  });
}

/** Deletes a laptop — refuses if it doesn't belong to the caller's own hub. */
function deleteLaptop(sessionToken, id) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    var existing = DB.getById(LAPTOPS_TABLE, id);
    if (!existing || existing.HubID !== manager.hubId) {
      throw new Error('Laptop record not found.');
    }
    DB.remove(LAPTOPS_TABLE, id);
    logAudit_(manager, 'Delete', LAPTOPS_TABLE, id, '(record)',
      existing.Manufacturer + ' ' + existing.Model + ' (S/N ' + existing.SerialNumber + ')', '', manager.hubId);
    return true;
  });
}

/** Builds the column set written to the sheet for an add or update. Buyer/Sale fields only persist when Status is Sold. */
function buildLaptopRecord_(hubId, data, orderNumber, isUpdate) {
  data = data || {};
  var record = {
    Manufacturer: String(data.Manufacturer || '').trim(),
    Model: String(data.Model || '').trim(),
    SerialNumber: String(data.SerialNumber || '').trim(),
    AssetID: String(data.AssetID || '').trim(),
    Processor: String(data.Processor || '').trim(),
    RAM: String(data.RAM || '').trim(),
    Storage: String(data.Storage || '').trim(),
    ScreenSize: String(data.ScreenSize || '').trim(),
    OperatingSystem: String(data.OperatingSystem || '').trim(),
    Condition: data.Condition || 'Refurbished',
    SellingPrice: Number(data.SellingPrice) || 0,
    DateAdded: parseDateOnly_(data.DateAdded || todayDateString_()),
    Status: data.Status || 'Current Stock',
    BuyerName: data.Status === 'Sold' ? String(data.BuyerName || '').trim() : '',
    SaleDate: (data.Status === 'Sold' && data.SaleDate) ? parseDateOnly_(data.SaleDate) : '',
    SalePrice: data.Status === 'Sold' ? (Number(data.SalePrice) || 0) : '',
    Notes: String(data.Notes || '').trim(),
    OrderNumber: orderNumber,
    PurchaseOrderNumber: String(data.PurchaseOrderNumber || '').trim(),
    SalesOrderNumber: String(data.SalesOrderNumber || '').trim()
  };
  if (!isUpdate) record.HubID = hubId;
  return record;
}

/**
 * Finds an existing laptop with the same serial number, if any
 * (case/whitespace-insensitive). Checked GLOBALLY across every hub —
 * not just the caller's own — because a physical serial number is
 * unique regardless of which hub it's at, and this is what stops the
 * same asset from ever being logged at two hubs simultaneously.
 */
function findLaptopBySerial_(hubId, serialNumber, excludeId) {
  var norm = String(serialNumber || '').trim().toLowerCase();
  if (!norm) return null;
  var all = DB.getAll(LAPTOPS_TABLE);
  for (var i = 0; i < all.length; i++) {
    var l = all[i];
    if (excludeId && l.InventoryID === excludeId) continue;
    if (String(l.SerialNumber || '').trim().toLowerCase() === norm) return l;
  }
  return null;
}

/**
 * Shared validation for manual add/edit AND import rows.
 * lenient=true (import) only requires a serial number plus at least
 * one of manufacturer/model — spreadsheet exports are often missing
 * spec details, and requiring every field would reject rows that are
 * perfectly fine to bring in with gaps to fill in later.
 */
function validateLaptopInput(data, lenient) {
  var errors = [];
  data = data || {};

  if (!lenient) {
    if (!String(data.Manufacturer || '').trim()) errors.push('Manufacturer is required.');
    if (!String(data.Model || '').trim()) errors.push('Model is required.');
  } else if (!String(data.Manufacturer || '').trim() && !String(data.Model || '').trim()) {
    errors.push('Missing both manufacturer and model.');
  }

  if (!String(data.SerialNumber || '').trim()) {
    errors.push('Serial number is required.');
  }

  if (!lenient) {
    if (!data.Condition || LAPTOP_CONDITIONS.indexOf(data.Condition) === -1) {
      errors.push('Condition must be New or Refurbished.');
    }
    if (data.SellingPrice === undefined || data.SellingPrice === '' || isNaN(Number(data.SellingPrice)) || Number(data.SellingPrice) < 0) {
      errors.push('Selling price must be a valid non-negative number.');
    }
    if (!data.DateAdded) errors.push('Date added is required.');
    if (!data.Status || LAPTOP_STATUSES.indexOf(data.Status) === -1) {
      errors.push('Status must be Current Stock, Sold, or Faulty.');
    }
    if (data.Status === 'Sold') {
      if (!String(data.BuyerName || '').trim()) errors.push('Buyer name is required for a sold laptop.');
      if (!data.SaleDate) errors.push('Sale date is required for a sold laptop.');
      if (data.SalePrice === undefined || data.SalePrice === '' || isNaN(Number(data.SalePrice)) || Number(data.SalePrice) < 0) {
        errors.push('Sale price must be a valid non-negative number for a sold laptop.');
      }
    }
  }

  return errors;
}

function todayDateString_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyy-MM-dd');
}

/**
 * Validates a batch of already column-mapped spreadsheet rows WITHOUT
 * saving anything, so the client can show an import preview with an
 * error report before anything touches the database.
 */
function previewLaptopImport(sessionToken, rows) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    rows = rows || [];

    var validRows = [];
    var errorRows = [];
    var seenSerials = {};

    rows.forEach(function (row, idx) {
      var rowNumber = row.rowNumber || (idx + 2); // +2: header row, 1-based
      var errors = validateLaptopInput(row, true);

      var serialNorm = String(row.SerialNumber || '').trim().toLowerCase();
      if (serialNorm) {
        if (seenSerials[serialNorm]) {
          errors.push('Duplicate serial number within this file (also row ' + seenSerials[serialNorm] + ').');
        } else {
          seenSerials[serialNorm] = rowNumber;
          var dup = findLaptopBySerial_(manager.hubId, row.SerialNumber, null);
          if (dup) errors.push('Serial number already exists in inventory (' + dup.InventoryID + ').');
        }
      }

      if (errors.length) {
        errorRows.push({ rowNumber: rowNumber, data: row, errors: errors });
      } else {
        validRows.push({ rowNumber: rowNumber, data: row });
      }
    });

    return {
      validRows: validRows,
      errorRows: errorRows,
      suggestedOrderNumber: nextOrderNumber_(manager.hubId)
    };
  });
}

/**
 * Re-validates and inserts the rows the user confirmed after reviewing
 * the preview. Never trusts the client's "these passed" claim — re-runs
 * the same checks server-side (including a fresh duplicate check, in
 * case something else was added in the meantime) before writing.
 * All inserted rows land in Current Stock, tagged with orderNumber.
 */
function confirmLaptopImport(sessionToken, rows, orderNumber) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    rows = rows || [];

    var finalOrderNumber = String(orderNumber || '').trim() || nextOrderNumber_(manager.hubId);
    var inserted = 0;
    var skipped = [];
    var seenSerials = {};

    rows.forEach(function (row, idx) {
      var data = row.data || row;
      var errors = validateLaptopInput(data, true);

      var serialNorm = String(data.SerialNumber || '').trim().toLowerCase();
      if (serialNorm) {
        if (seenSerials[serialNorm]) {
          errors.push('Duplicate serial number within this import batch.');
        } else {
          seenSerials[serialNorm] = true;
          var dup = findLaptopBySerial_(manager.hubId, data.SerialNumber, null);
          if (dup) errors.push('Serial number already exists in inventory (' + dup.InventoryID + ').');
        }
      }

      if (errors.length) {
        skipped.push({ rowNumber: row.rowNumber || (idx + 2), reasons: errors });
        return;
      }

      var insertedRecord = DB.insert(LAPTOPS_TABLE, buildLaptopRecord_(manager.hubId, {
        Manufacturer: data.Manufacturer,
        Model: data.Model,
        SerialNumber: data.SerialNumber,
        AssetID: data.AssetID,
        Processor: data.Processor,
        RAM: data.RAM,
        Storage: data.Storage,
        Condition: data.Condition || 'Refurbished',
        SellingPrice: data.SellingPrice || 0,
        DateAdded: data.DateAdded || todayDateString_(),
        Status: 'Current Stock',
        Notes: data.Notes,
        PurchaseOrderNumber: data.PurchaseOrderNumber,
        SalesOrderNumber: data.SalesOrderNumber
      }, finalOrderNumber, false));
      logAudit_(manager, 'Create', LAPTOPS_TABLE, insertedRecord.InventoryID, '(record)', '',
        (data.Manufacturer || '') + ' ' + (data.Model || '') + ' (S/N ' + (data.SerialNumber || '') + ') — imported under ' + finalOrderNumber, manager.hubId);
      inserted++;
    });

    return { inserted: inserted, skipped: skipped, orderNumber: finalOrderNumber };
  });
}
