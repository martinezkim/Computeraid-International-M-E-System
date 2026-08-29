/**
 * ============================================================
 * INVENTORYSUMMARY.GS — "Inventory Summary" dashboard
 * ============================================================
 * The landing page for the Inventory section: combines the Hub
 * Inventory breakdown (Inventory.gs) and the Laptop Sales summary
 * (Laptops.gs) into one call so the dashboard loads with a single
 * round trip. Every figure here is computed live from the two
 * tables for the calling Hub Manager's own hub — nothing is
 * manually entered or cached.
 * ============================================================
 */

function getInventorySummaryDashboard(sessionToken) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);

    var hubItems = DB.getAll(INVENTORY_TABLE).filter(function (item) { return item.HubID === manager.hubId; });
    var byCategory = {};
    INVENTORY_CATEGORIES.forEach(function (c) { byCategory[c] = 0; });
    var byStatus = {};
    INVENTORY_STATUSES.forEach(function (s) { byStatus[s] = 0; });
    var totalAssets = 0;
    hubItems.forEach(function (item) {
      var qty = Number(item.Quantity) || 0;
      totalAssets += qty;
      if (byCategory.hasOwnProperty(item.Category)) byCategory[item.Category] += qty;
      if (byStatus.hasOwnProperty(item.Status)) byStatus[item.Status] += qty;
    });

    var laptops = DB.getAll(LAPTOPS_TABLE).filter(function (l) { return l.HubID === manager.hubId; });
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
      hubInventory: { totalAssets: totalAssets, byCategory: byCategory, byStatus: byStatus },
      laptopSales: laptopSummary
    };
  });
}
