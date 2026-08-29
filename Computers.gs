/**
 * ============================================================
 * COMPUTERS.GS — Computer registry over Inventory (Phase 15)
 * ============================================================
 * "Computers" are Hub Inventory items in the Desktop Computers /
 * Laptops categories (COMPUTER_CATEGORIES, already defined in
 * HubHealth.gs) — deployed equipment, not the Laptops-for-sale
 * resale catalog. This module never duplicates Inventory's Status;
 * it only assigns a stable ComputerID the usage-tracking tables can
 * reference, lazily created the first time a hub's computer item is
 * seen here.
 * ============================================================
 */

var COMPUTERS_TABLE = 'Computers';

/** Internal: ensures every computer-category Inventory item at a Hub has a Computers row; returns the full set. */
function provisionAndGetHubComputers_(hubId) {
  var hubInventoryComputers = DB.getAll('Inventory').filter(function (i) {
    return i.HubID === hubId && COMPUTER_CATEGORIES.indexOf(i.Category) !== -1;
  });

  var existing = DB.getAll(COMPUTERS_TABLE).filter(function (c) { return c.HubID === hubId; });
  var existingByInventoryId = {};
  existing.forEach(function (c) { existingByInventoryId[c.InventoryID] = c; });

  var nextSeq = existing.length + 1;
  hubInventoryComputers.forEach(function (item) {
    if (existingByInventoryId[item.InventoryID]) return;
    var computerId = hubId + '-PC' + String(nextSeq).padStart(3, '0');
    nextSeq++;
    var created = DB.insert(COMPUTERS_TABLE, {
      ComputerID: computerId,
      InventoryID: item.InventoryID,
      HubID: hubId,
      DeviceType: item.Category,
      LastActiveDate: ''
    });
    existingByInventoryId[item.InventoryID] = created;
  });

  var inventoryById = {};
  hubInventoryComputers.forEach(function (i) { inventoryById[i.InventoryID] = i; });

  return Object.keys(existingByInventoryId).map(function (invId) {
    var computer = existingByInventoryId[invId];
    var inv = inventoryById[invId];
    return {
      ComputerID: computer.ComputerID,
      InventoryID: computer.InventoryID,
      HubID: computer.HubID,
      DeviceType: computer.DeviceType,
      LastActiveDate: computer.LastActiveDate,
      ItemName: inv ? inv.ItemName : '(removed from inventory)',
      Manufacturer: inv ? inv.Manufacturer : '',
      Model: inv ? inv.Model : '',
      Status: inv ? inv.Status : 'Decommissioned'
    };
  });
}

/** Hub Manager: their own Hub's computer registry (auto-provisioned from Inventory). */
function getMyHubComputers(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    return provisionAndGetHubComputers_(manager.hubId);
  });
}

/** Admin: every Hub's computer registry, optionally filtered to one Hub. */
function getAllComputers(sessionToken, hubId, countryId) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var hubs = hubId ? [DB.getById('Hubs', hubId)].filter(Boolean) : DB.getAll('Hubs');
    if (countryId) hubs = hubs.filter(function (h) { return h.CountryID === countryId; });
    var all = [];
    hubs.forEach(function (h) {
      var computers = provisionAndGetHubComputers_(h.HubID);
      computers.forEach(function (c) { c.HubName = h.HubName; });
      all = all.concat(computers);
    });
    return all;
  });
}

/** Internal: a single computer's registry row + live status, or null. */
function getComputerWithStatus_(computerId) {
  var computer = DB.getById(COMPUTERS_TABLE, computerId);
  if (!computer) return null;
  // Ad hoc computers (see findOrCreateComputerByName_) have no
  // InventoryID — they're not a tracked physical asset, just a name
  // someone typed, so they're always considered usable rather than
  // deferring to an Inventory Status that doesn't exist for them.
  if (!computer.InventoryID) {
    return { ComputerID: computer.ComputerID, InventoryID: '', HubID: computer.HubID, ItemName: computer.Name, Status: 'In Use' };
  }
  var inv = DB.getById('Inventory', computer.InventoryID);
  return {
    ComputerID: computer.ComputerID,
    InventoryID: computer.InventoryID,
    HubID: computer.HubID,
    ItemName: inv ? inv.ItemName : '(removed from inventory)',
    Status: inv ? inv.Status : 'Decommissioned'
  };
}

/**
 * Finds an existing computer at this Hub matching the typed name
 * (case-insensitive, matches either an ad hoc computer's own Name or an
 * Inventory-backed computer's ItemName) — or creates a new ad hoc one on
 * the spot. This is what lets a beneficiary start a session on whatever
 * PC they're sitting at without a Hub Manager having pre-registered it
 * in Inventory first; see Sync.gs's syncSessionLogin_.
 */
function findOrCreateComputerByName_(hubId, name) {
  name = String(name || '').trim();
  if (!name) return null;
  var norm = name.toLowerCase();

  var registered = provisionAndGetHubComputers_(hubId);
  var match = registered.filter(function (c) { return String(c.ItemName || '').trim().toLowerCase() === norm; })[0];
  if (match) return getComputerWithStatus_(match.ComputerID);

  var adHoc = DB.getAll(COMPUTERS_TABLE).filter(function (c) { return c.HubID === hubId && !c.InventoryID; });
  var existing = adHoc.filter(function (c) { return String(c.Name || '').trim().toLowerCase() === norm; })[0];
  if (existing) return getComputerWithStatus_(existing.ComputerID);

  var computerId = hubId + '-ADHOC' + String(adHoc.length + 1).padStart(3, '0');
  DB.insert(COMPUTERS_TABLE, {
    ComputerID: computerId, InventoryID: '', HubID: hubId, DeviceType: 'Ad Hoc', LastActiveDate: '', Name: name
  });
  return getComputerWithStatus_(computerId);
}
