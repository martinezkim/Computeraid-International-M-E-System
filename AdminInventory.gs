/**
 * ============================================================
 * ADMININVENTORY.GS — Admin-wide inventory visibility
 * ============================================================
 * Everything in Inventory.gs and Laptops.gs is deliberately scoped
 * to "the calling Hub Manager's own hub" — this module is the admin
 * counterpart: the same two tables, but readable across every hub,
 * filterable by hub, with a hub name joined onto each row so an
 * admin looking at a flat list can tell which hub an item belongs
 * to. Nothing here writes to Inventory/Laptops — Admins view and
 * export; Hub Managers are still the only ones who add/edit/delete
 * their own hub's items.
 * ============================================================
 */

/** Global stats across every hub: Hub Inventory breakdown + Laptop Sales summary, admin view. */
function getGlobalInventoryOverview(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};
    var hubScope = resolveAdminHubScope_(identity);
    var countryScope = resolveCountryFilterScope_(options.countryId);
    var filterHubId = options.hubId;

    function scopedByHub_(table) {
      var records = applyHubScope_(DB.getAll(table), hubScope, 'HubID');
      records = applyHubScope_(records, countryScope, 'HubID');
      if (filterHubId) records = records.filter(function (r) { return r.HubID === filterHubId; });
      return records;
    }

    var allItems = scopedByHub_(INVENTORY_TABLE);
    var byCategory = {};
    INVENTORY_CATEGORIES.forEach(function (c) { byCategory[c] = 0; });
    var byStatus = {};
    INVENTORY_STATUSES.forEach(function (s) { byStatus[s] = 0; });
    var totalAssets = 0;
    allItems.forEach(function (item) {
      var qty = Number(item.Quantity) || 0;
      totalAssets += qty;
      if (byCategory.hasOwnProperty(item.Category)) byCategory[item.Category] += qty;
      if (byStatus.hasOwnProperty(item.Status)) byStatus[item.Status] += qty;
    });

    var laptops = scopedByHub_(LAPTOPS_TABLE);
    var laptopSummary = { totalLaptops: laptops.length, currentStock: 0, sold: 0, faulty: 0, totalStockValue: 0, totalSalesValue: 0 };
    laptops.forEach(function (l) {
      if (l.Status === 'Current Stock') {
        laptopSummary.currentStock++;
        laptopSummary.totalStockValue += Number(l.SellingPrice) || 0;
      } else if (l.Status === 'Sold') {
        laptopSummary.sold++;
        laptopSummary.totalSalesValue += Number(l.SalePrice) || 0;
      } else if (l.Status === 'Faulty') {
        laptopSummary.faulty++;
      }
    });

    return {
      hubInventory: { totalAssets: totalAssets, byCategory: byCategory, byStatus: byStatus, hubCount: scopedByHub_('Hubs').length },
      laptopSales: laptopSummary
    };
  });
}

/** Hub Inventory rows across every hub (or one, via options.hubId), with the hub name joined on. */
function getAdminInventoryList(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var all = applyHubScope_(DB.getAll(INVENTORY_TABLE), resolveAdminHubScope_(identity), 'HubID');

    if (options.hubId) all = all.filter(function (i) { return i.HubID === options.hubId; });
    if (options.category) all = all.filter(function (i) { return i.Category === options.category; });
    if (options.status) all = all.filter(function (i) { return i.Status === options.status; });

    all = all.map(function (i) { return withField_(i, { HubName: hubNames[i.HubID] || i.HubID }); });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[INVENTORY_TABLE].searchableColumns.concat(['HubName']),
      sortBy: options.sortBy || 'DateAcquired',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Laptop rows across every hub (or one, via options.hubId), with the hub name joined on. */
function getAdminLaptopsList(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var all = applyHubScope_(DB.getAll(LAPTOPS_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');

    if (options.hubId) all = all.filter(function (l) { return l.HubID === options.hubId; });
    if (options.status) all = all.filter(function (l) { return l.Status === options.status; });

    all = all.map(function (l) { return withField_(l, { HubName: hubNames[l.HubID] || l.HubID }); });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[LAPTOPS_TABLE].searchableColumns.concat(['HubName']),
      sortBy: options.sortBy || 'DateAdded',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Same scope/filters as getAdminLaptopsList, but grouped by
 * Manufacturer+Model+Status+Hub (see groupLaptops_ in Laptops.gs) —
 * collapses e.g. "20x HP EliteBook 745 G6, Current Stock, Nairobi Hub"
 * into a single card instead of 20 individual pages.
 */
function getAdminLaptopsGrouped(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var all = applyHubScope_(DB.getAll(LAPTOPS_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');

    if (options.hubId) all = all.filter(function (l) { return l.HubID === options.hubId; });
    if (options.status) all = all.filter(function (l) { return l.Status === options.status; });

    all = all.map(function (l) { return withField_(l, { HubName: hubNames[l.HubID] || l.HubID }); });

    var searched = paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[LAPTOPS_TABLE].searchableColumns.concat(['HubName']),
      page: 1,
      pageSize: Math.max(all.length, 1)
    }).records;

    return paginateGroupList_(groupLaptops_(searched, true), options);
  });
}

/**
 * Unfiltered, unpaginated export feeds — one function per report type
 * requested ("Hub Inventory", "Laptop Current Stock", "Sold Laptops",
 * "Faulty Laptops", "Complete Inventory"). Returns the full row set
 * with hub names joined on; the client turns this into CSV/Excel/PDF
 * (see the export helpers in CoreJS.html) so the actual file format
 * never has to be generated server-side.
 */
function getInventoryExportData(sessionToken, reportType, hubId) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var hubScope = resolveAdminHubScope_(identity);
    var hubNames = hubNameLookup_();
    var withHubName = function (r) { return withField_(r, { HubName: hubNames[r.HubID] || r.HubID }); };
    var byHub = function (r) { return (!hubId || r.HubID === hubId) && (!hubScope || !!hubScope[r.HubID]); };

    if (reportType === 'hubInventory') {
      return DB.getAll(INVENTORY_TABLE).filter(byHub).map(withHubName);
    }
    if (reportType === 'laptopCurrentStock') {
      return DB.getAll(LAPTOPS_TABLE).filter(byHub).filter(function (l) { return l.Status === 'Current Stock'; }).map(withHubName);
    }
    if (reportType === 'laptopSold') {
      return DB.getAll(LAPTOPS_TABLE).filter(byHub).filter(function (l) { return l.Status === 'Sold'; }).map(withHubName);
    }
    if (reportType === 'laptopFaulty') {
      return DB.getAll(LAPTOPS_TABLE).filter(byHub).filter(function (l) { return l.Status === 'Faulty'; }).map(withHubName);
    }
    if (reportType === 'complete') {
      var hubRows = DB.getAll(INVENTORY_TABLE).filter(byHub).map(withHubName).map(function (r) {
        return withField_(r, { Source: 'Hub Inventory' });
      });
      var laptopRows = DB.getAll(LAPTOPS_TABLE).filter(byHub).map(withHubName).map(function (r) {
        return withField_(r, { Source: 'Laptops for Sale' });
      });
      return hubRows.concat(laptopRows);
    }
    throw new Error('Unknown report type: ' + reportType);
  });
}

function withField_(record, extra) {
  var merged = {};
  Object.keys(record).forEach(function (k) { merged[k] = record[k]; });
  Object.keys(extra).forEach(function (k) { merged[k] = extra[k]; });
  return merged;
}

function hubNameLookup_() {
  var lookup = {};
  DB.getAll('Hubs').forEach(function (h) { lookup[h.HubID] = h.HubName; });
  return lookup;
}
