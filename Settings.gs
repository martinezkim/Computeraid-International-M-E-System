/**
 * ============================================================
 * SETTINGS.GS — Small system-wide settings (Phase 16+)
 * ============================================================
 * Currently just the display currency. Stored in Script Properties
 * rather than a Sheet — this is a single global scalar, not tabular
 * data, so a whole table would be overkill (same reasoning as the
 * ANTHROPIC_API_KEY property in AIAnalytics.gs).
 * ============================================================
 */

var CURRENCY_PROPERTY_KEY = 'SYSTEM_CURRENCY';
var DEFAULT_CURRENCY_CODE = 'KES';

/**
 * Common currencies for the picker — deliberately not exhaustive, just
 * the ones plausible for this program's deployments. Symbol is used
 * for display only (formatCurrency in CoreJS.html); amounts are always
 * stored as plain numbers, never currency-tagged per record.
 */
var CURRENCY_CATALOG = [
  { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling' },
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'UGX', symbol: 'USh', name: 'Ugandan Shilling' },
  { code: 'TZS', symbol: 'TSh', name: 'Tanzanian Shilling' },
  { code: 'RWF', symbol: 'FRw', name: 'Rwandan Franc' },
  { code: 'ETB', symbol: 'Br', name: 'Ethiopian Birr' },
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira' },
  { code: 'GHS', symbol: 'GH₵', name: 'Ghanaian Cedi' },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'EUR', symbol: '€', name: 'Euro' }
];

/** Open to any authenticated session — every page needs this to format money consistently. */
function getSystemCurrency(sessionToken) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    var code = PropertiesService.getScriptProperties().getProperty(CURRENCY_PROPERTY_KEY) || DEFAULT_CURRENCY_CODE;
    var match = CURRENCY_CATALOG.filter(function (c) { return c.code === code; })[0];
    return { code: code, symbol: match ? match.symbol : code, catalog: CURRENCY_CATALOG };
  });
}

function setSystemCurrency(sessionToken, code) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    var match = CURRENCY_CATALOG.filter(function (c) { return c.code === code; })[0];
    if (!match) throw new Error('Unknown currency code.');
    PropertiesService.getScriptProperties().setProperty(CURRENCY_PROPERTY_KEY, code);
    return { code: match.code, symbol: match.symbol };
  });
}
