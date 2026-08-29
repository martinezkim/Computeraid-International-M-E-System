/**
 * ============================================================
 * EXCHANGERATES.GS — Multi-currency conversion (Finance Phase 2)
 * ============================================================
 * Every FinancialAccount already carries its own Currency, and the
 * balance engine (FinanceBalance.gs) has always kept currencies
 * strictly separate — figures for different currencies are never
 * summed together (see FINANCE_MODULE_INSTRUCTIONS.md §6). This
 * module adds an OPTIONAL, clearly-labeled converted view on top of
 * that, for when an Admin wants one combined number across accounts
 * held in different currencies. It never replaces the native,
 * per-currency figures — only supplements them.
 *
 * Rates are manually entered by an Admin (no live FX API — this is a
 * small NGO tool, not a trading system) and converted TO the system
 * currency (Settings.gs) only — not a full N-currency matrix. That
 * covers the actual need: "we mostly operate in KES but hold one USD
 * account, show me a combined picture."
 * ============================================================
 */

var EXCHANGE_RATES_TABLE = 'ExchangeRates';

/**
 * Internal: the most-recently-dated exchange rate for a currency, or
 * null if none has ever been logged. The system currency itself
 * always converts at 1 — no row needed.
 */
function getEffectiveExchangeRate_(currencyCode) {
  var systemCurrency = PropertiesService.getScriptProperties().getProperty(CURRENCY_PROPERTY_KEY) || DEFAULT_CURRENCY_CODE;
  if (currencyCode === systemCurrency) return { rate: 1, rateDate: null, systemCurrency: systemCurrency };

  var rows = DB.getAll(EXCHANGE_RATES_TABLE).filter(function (r) { return r.CurrencyCode === currencyCode; });
  if (!rows.length) return null;

  rows.sort(function (a, b) {
    var byDate = String(b.RateDate || '').localeCompare(String(a.RateDate || ''));
    if (byDate !== 0) return byDate;
    return String(b.DateCreated).localeCompare(String(a.DateCreated));
  });
  return { rate: Number(rows[0].Rate), rateDate: rows[0].RateDate, systemCurrency: systemCurrency };
}

/**
 * Internal: converts an amount from currencyCode into the system
 * currency. Returns { converted, rate, missingRate } — missingRate is
 * true (and converted is null) when no rate has ever been logged for
 * that currency, so callers can exclude it from a total rather than
 * silently treating an unknown rate as 1.
 */
function convertToSystemCurrency_(amount, currencyCode) {
  var effective = getEffectiveExchangeRate_(currencyCode);
  if (!effective) return { converted: null, rate: null, missingRate: true };
  return { converted: Number(amount) * effective.rate, rate: effective.rate, missingRate: false };
}

/** Any authenticated user: every currency that has ever had a rate logged, with its current effective rate — used by the Financial Dashboard to know what a converted total is built from. */
function getExchangeRateSummary(sessionToken) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    var systemCurrency = PropertiesService.getScriptProperties().getProperty(CURRENCY_PROPERTY_KEY) || DEFAULT_CURRENCY_CODE;
    var codes = {};
    DB.getAll(EXCHANGE_RATES_TABLE).forEach(function (r) { codes[r.CurrencyCode] = true; });
    var summary = Object.keys(codes).map(function (code) {
      var eff = getEffectiveExchangeRate_(code);
      return { currencyCode: code, rate: eff.rate, rateDate: eff.rateDate };
    });
    return { systemCurrency: systemCurrency, rates: summary };
  });
}

/** Admin: full logged rate history, newest first. */
function getExchangeRates(sessionToken, options) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    options = options || {};
    var all = DB.getAll(EXCHANGE_RATES_TABLE);
    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[EXCHANGE_RATES_TABLE].searchableColumns,
      sortBy: options.sortBy || 'RateDate',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Admin: logs a new rate — always an insert, never overwrites a prior entry (see file header). */
function setExchangeRate(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var error = validateExchangeRateInput(data);
    if (error) throw new Error(error);

    var record = DB.insert(EXCHANGE_RATES_TABLE, {
      CurrencyCode: data.CurrencyCode,
      Rate: Number(data.Rate),
      RateDate: data.RateDate,
      Source: (data.Source || '').trim(),
      EnteredByEmail: identity.email
    });
    logAudit_(identity, 'Create', EXCHANGE_RATES_TABLE, record.ExchangeRateID, 'Rate', '', data.CurrencyCode + ' = ' + data.Rate, '');
    return record;
  });
}

function validateExchangeRateInput(data) {
  var systemCurrency = PropertiesService.getScriptProperties().getProperty(CURRENCY_PROPERTY_KEY) || DEFAULT_CURRENCY_CODE;
  var error = Validate.run([
    [Validate.required, data && data.CurrencyCode, 'Currency'],
    [Validate.required, data && data.Rate, 'Rate'],
    [Validate.required, data && data.RateDate, 'Rate date']
  ]);
  if (error) return error;
  if (data.CurrencyCode === systemCurrency) return 'The system currency (' + systemCurrency + ') always converts at 1 — no rate needed.';
  if (CURRENCY_CATALOG.filter(function (c) { return c.code === data.CurrencyCode; }).length === 0) return 'Unknown currency code.';
  var rateNum = Number(data.Rate);
  if (isNaN(rateNum) || rateNum <= 0) return 'Rate must be a positive number.';
  return null;
}
