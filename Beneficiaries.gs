/**
 * ============================================================
 * BENEFICIARIES.GS — Beneficiary registration & lookup (Phase 15)
 * ============================================================
 * Beneficiaries are org-wide, not Hub-owned (spec Decision D-1) — a
 * person can visit many Hubs, so there is no single "this hub's
 * beneficiaries" table the way Inventory belongs to one Hub. Instead:
 *   - registerBeneficiary(): either role can register; HubID on a
 *     Hub Manager's registration is always resolved server-side from
 *     their session, exactly like every other Hub-Manager write in
 *     this app (requireManagerSession_ pattern from Projects.gs).
 *   - lookupBeneficiary(): open to any authenticated session, used at
 *     check-in to find a *returning* person before ever creating a
 *     new record (spec FR-2) — returns minimal fields only.
 *   - getMyHubBeneficiaries(): a Hub Manager's own working list. Until
 *     Visits exist (Phase 15 Milestone 3), this is scoped to people
 *     whose HomeHubID is this Hub — once BeneficiaryVisits exists,
 *     extend this to also include anyone with a visit at this Hub,
 *     not just their registered home Hub.
 * ============================================================
 */

var BENEFICIARIES_TABLE = 'Beneficiaries';

var BENEFICIARY_GENDERS = ['Female', 'Male', 'Other', 'Prefer not to say'];
// Kept — not collected on the form anymore (see validateBeneficiaryInput),
// but the ConsentStatus/ConsentDate columns and this list stay for any
// historical record that still has a value.
var BENEFICIARY_CONSENT_STATUSES = ['Granted', 'Guardian Consent', 'Declined', 'Pending'];
var BENEFICIARY_USER_CATEGORIES = ['Youth', 'Adult', 'Student', 'Community Member', 'Entrepreneur', 'Job Seeker', 'Other'];
var BENEFICIARY_EDUCATION_LEVELS = ['Primary school', 'High school', 'Campus student', 'College', 'Post graduate'];
var BENEFICIARY_DISTANCE_BANDS = ['Less than a kilometer', '2 kilometers', '5 kilometers', 'More than 5 kilometers'];
var BENEFICIARY_FIRST_TIME_OPTIONS = ['Yes', 'No'];

/** Form option lists for the registration form — open to any logged-in session. */
function getBeneficiaryFormOptions(sessionToken) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    var ageBandsResult = getAgeBandOptions();
    return {
      genders: BENEFICIARY_GENDERS,
      userCategories: BENEFICIARY_USER_CATEGORIES,
      educationLevels: BENEFICIARY_EDUCATION_LEVELS,
      distanceBands: BENEFICIARY_DISTANCE_BANDS,
      firstTimeOptions: BENEFICIARY_FIRST_TIME_OPTIONS,
      ageBands: ageBandsResult.success ? ageBandsResult.data : []
    };
  });
}

/**
 * Capitalizes each word — applied to free-text name/location fields on
 * every registration path (PWA sync + this file's registerBeneficiary)
 * so data stays consistent regardless of entry point, even though the
 * PWA also does this client-side for immediate visual feedback.
 */
function titleCase_(str) {
  return String(str || '').trim().replace(/\w\S*/g, function (word) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

/**
 * Registers a new beneficiary. Both roles may call this (spec
 * permissions table); a Hub Manager's HomeHubID always comes from
 * their own session, never the client. Admins may specify any Hub.
 *
 * Before inserting, checks for likely duplicates (spec FR-3). If any
 * are found and the caller hasn't explicitly confirmed they want a
 * new record anyway (data.confirmNewRecord), returns the matches
 * instead of creating anything — the client shows them and lets the
 * user pick an existing person or confirm a genuinely new one.
 */
function registerBeneficiary(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var homeHubId;
    if (identity.role === 'HubManager') {
      homeHubId = identity.hubId;
    } else if (identity.role === 'Admin') {
      if (!data.HomeHubID) throw new Error('Home Hub is required.');
      if (!DB.getById('Hubs', data.HomeHubID)) throw new Error('Home Hub not found.');
      homeHubId = data.HomeHubID;
    } else {
      throw new Error('You do not have permission to register a beneficiary.');
    }

    var error = validateBeneficiaryInput(data);
    if (error) throw new Error(error);

    if (!data.confirmNewRecord) {
      var duplicates = findPossibleDuplicates_(data);
      if (duplicates.length) {
        return { created: false, possibleDuplicates: duplicates };
      }
    }

    var lastName = titleCase_(data.LastName);
    var age = Number(data.Age);

    var record = DB.insert(BENEFICIARIES_TABLE, {
      FirstName: titleCase_(data.FirstName),
      LastName: lastName,
      // Derived, not client-supplied — every existing band/initial-based
      // report and KPI keeps working unchanged, and this pair also serves
      // as the anonymized view of this record for Admin-level reporting.
      SurnameInitial: lastName.charAt(0).toUpperCase(),
      Age: age,
      AgeGroup: mapAgeToBand_(age),
      Gender: data.Gender,
      Country: String(data.Country || '').trim(),
      Region: titleCase_(data.Region),
      Community: titleCase_(data.Community),
      EducationLevel: data.EducationLevel || '',
      Occupation: titleCase_(data.Occupation),
      UserCategory: data.UserCategory || '',
      DisabilityInfo: String(data.DisabilityInfo || '').trim(),
      Phone: String(data.Phone || '').trim(),
      Email: String(data.Email || '').trim(),
      DistanceFromHub: data.DistanceFromHub || '',
      FirstTimeVisitor: data.FirstTimeVisitor || '',
      HomeHubID: homeHubId,
      RegistrationDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      QRToken: Utilities.getUuid(),
      CreatedByEmail: identity.email,
      CreatedByRole: identity.role,
      ClientUUID: Utilities.getUuid(),
      DeviceID: '',
      SyncStatus: 'Synced'
    });

    logAudit_(identity, 'Create', BENEFICIARIES_TABLE, record.BeneficiaryID, '(record)', '',
      record.FirstName + ' ' + record.SurnameInitial + '. (' + record.AgeGroup + ', ' + record.Gender + ')', homeHubId);

    if (record.Email) EmailService.sendBeneficiaryWelcomeEmail(record);

    return { created: true, record: record };
  });
}

/**
 * Search-only lookup for returning-user check-in (spec FR-2/§11).
 * Accepts either an exact BeneficiaryID/QRToken, or a fuzzy
 * name-initial + age group search. Returns minimal fields — never
 * the full profile — since this is used at a shared check-in point,
 * not a data-management screen.
 */
function lookupBeneficiary(sessionToken, query) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    query = query || {};

    var all = DB.getAll(BENEFICIARIES_TABLE);
    var matches;

    var exactId = String(query.beneficiaryId || query.qrToken || '').trim();
    if (exactId) {
      matches = all.filter(function (b) {
        return b.BeneficiaryID === exactId || b.QRToken === exactId;
      });
    } else {
      matches = fuzzyMatchBeneficiaries_(all, query);
    }

    return resolveForeignKey(matches.map(stripBeneficiaryPII_), 'HomeHubID', 'Hubs', 'HubName', 'HomeHubName');
  });
}

/** Internal: fuzzy duplicate/returning-user match on name-initial + age group + gender + community. */
function fuzzyMatchBeneficiaries_(all, criteria) {
  var firstName = String(criteria.FirstName || criteria.firstName || '').trim().toLowerCase();
  var lastName = String(criteria.LastName || criteria.lastName || '').trim().toLowerCase();
  var surnameInitial = String(criteria.SurnameInitial || criteria.surnameInitial || '').trim().toUpperCase();
  var ageGroup = criteria.AgeGroup || criteria.ageGroup || '';
  var gender = criteria.Gender || criteria.gender || '';
  var community = String(criteria.Community || criteria.community || '').trim().toLowerCase();

  if (!firstName && !surnameInitial && !lastName) return [];

  return all.filter(function (b) {
    var firstMatches = firstName ? String(b.FirstName).trim().toLowerCase() === firstName : true;
    var lastMatches = lastName ? String(b.LastName).trim().toLowerCase() === lastName : true;
    var surnameMatches = surnameInitial ? b.SurnameInitial === surnameInitial : true;
    var ageMatches = ageGroup ? b.AgeGroup === ageGroup : true;
    var genderMatches = gender ? b.Gender === gender : true;
    var communityMatches = community ? String(b.Community).trim().toLowerCase() === community : true;
    return firstMatches && lastMatches && surnameMatches && ageMatches && genderMatches && communityMatches;
  });
}

function findPossibleDuplicates_(data) {
  var all = DB.getAll(BENEFICIARIES_TABLE);
  return fuzzyMatchBeneficiaries_(all, data).map(stripBeneficiaryPII_);
}

/** Strips fields not needed for identification/duplicate-review — keeps rows privacy-minimal. */
function stripBeneficiaryPII_(b) {
  return {
    BeneficiaryID: b.BeneficiaryID,
    FirstName: b.FirstName,
    LastName: b.LastName,
    SurnameInitial: b.SurnameInitial,
    Age: b.Age,
    AgeGroup: b.AgeGroup,
    Gender: b.Gender,
    Community: b.Community,
    HomeHubID: b.HomeHubID,
    RegistrationDate: b.RegistrationDate
  };
}

/**
 * Hub Manager's own working list. Interim definition (own Hub =
 * HomeHubID) until BeneficiaryVisits exists — see file header.
 */
function getMyHubBeneficiaries(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};

    var all = DB.getAll(BENEFICIARIES_TABLE).filter(function (b) { return b.HomeHubID === manager.hubId; });
    var schema = SCHEMA[BENEFICIARIES_TABLE];

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: schema.searchableColumns,
      sortBy: options.sortBy || 'RegistrationDate',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Admin: global beneficiary registry, with Home Hub name resolved for display. */
function getAllBeneficiaries(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var all = DB.getAll(BENEFICIARIES_TABLE);
    all = applyHubScope_(all, resolveAdminHubScope_(identity), 'HomeHubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HomeHubID');
    if (options.hubId) all = all.filter(function (b) { return b.HomeHubID === options.hubId; });
    all = resolveForeignKey(all, 'HomeHubID', 'Hubs', 'HubName', 'HomeHubName');

    var schema = SCHEMA[BENEFICIARIES_TABLE];
    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: schema.searchableColumns,
      sortBy: options.sortBy || 'RegistrationDate',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Internal: registered-beneficiary counts bucketed by each quota-quarter
 * within a Project Year — e.g. "how many people registered in Q1 2026
 * vs Q2 2026", using each quota's own (possibly custom) date range, not
 * a fixed Jan-Apr/May-Aug/Sep-Dec split. hubId null/omitted = every hub
 * (Admin's global view); a specific hubId scopes to just that hub (Hub
 * Manager's own view).
 */
function beneficiaryRegistrationBandsForYear_(projectYear, hubId) {
  var quotas = DB.getAll(QUOTAS_TABLE)
    .filter(function (q) { return q.ProjectYear === projectYear; })
    .sort(function (a, b) { return String(a.QuarterStart || '').localeCompare(String(b.QuarterStart || '')); });

  var beneficiaries = DB.getAll(BENEFICIARIES_TABLE);
  if (hubId) beneficiaries = beneficiaries.filter(function (b) { return b.HomeHubID === hubId; });

  return quotas.map(function (q) {
    var range = getQuotaDateRange_(q);
    var startStr = Utilities.formatDate(range.start, 'UTC', 'yyyy-MM-dd');
    var endStr = Utilities.formatDate(range.end, 'UTC', 'yyyy-MM-dd');
    var count = beneficiaries.filter(function (b) {
      return b.RegistrationDate && b.RegistrationDate >= startStr && b.RegistrationDate <= endStr;
    }).length;
    return { quarterLabel: quotaLabel_(q), dateRangeLabel: formatQuotaDateRangeLabel_(range), count: count };
  });
}

/** Admin: registration bands across every hub (or filtered to one) within a Project Year. */
function getBeneficiaryRegistrationBands(sessionToken, projectYear, hubId) {
  return safeExecute(function () {
    requireAdminSession_(sessionToken);
    return beneficiaryRegistrationBandsForYear_(projectYear, hubId || null);
  });
}

/** Hub Manager: registration bands for their own hub within a Project Year. */
function getMyBeneficiaryRegistrationBands(sessionToken, projectYear) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    return beneficiaryRegistrationBandsForYear_(projectYear, manager.hubId);
  });
}

/**
 * Counts of records elsewhere that reference this beneficiary (Visits,
 * Computer Sessions, Feedback) — shown before deleting so staff know
 * what will be left with a dangling BeneficiaryID (deletion here is not
 * cascading; those child rows are never touched, matching how DB.remove
 * works everywhere else in this app).
 */
function getBeneficiaryDependentCounts(sessionToken, id) {
  return safeExecute(function () {
    requireIdentity_(sessionToken);
    return {
      visits: DB.getAll(BENEFICIARY_VISITS_TABLE).filter(function (v) { return v.BeneficiaryID === id; }).length,
      sessions: DB.getAll(COMPUTER_SESSIONS_TABLE).filter(function (s) { return s.BeneficiaryID === id; }).length,
      feedback: DB.getAll(FEEDBACK_TABLE).filter(function (f) { return f.BeneficiaryID === id; }).length
    };
  });
}

/**
 * Deletes a beneficiary — mainly for cleaning up duplicate or test
 * registrations. Admin may delete anyone; a Hub Manager only someone
 * registered at their own Hub. Does not cascade to Visits/Sessions/
 * Feedback (see getBeneficiaryDependentCounts, shown to the caller
 * beforehand so this isn't a surprise).
 */
function deleteBeneficiary(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(BENEFICIARIES_TABLE, id);
    if (!existing) throw new Error('Beneficiary not found.');
    if (identity.role === 'HubManager' && existing.HomeHubID !== identity.hubId) {
      throw new Error('Beneficiary not found.');
    }

    DB.remove(BENEFICIARIES_TABLE, id);
    logAudit_(identity, 'Delete', BENEFICIARIES_TABLE, id, '(record)',
      existing.FirstName + ' ' + existing.SurnameInitial + '. (' + existing.AgeGroup + ', ' + existing.Gender + ')', '',
      identity.role === 'HubManager' ? identity.hubId : existing.HomeHubID);
    return true;
  });
}

/** Any authenticated Admin or Hub Manager session — used by endpoints both roles may call. */
function requireIdentity_(sessionToken) {
  var result = getIdentity(sessionToken);
  if (!result.success) throw new Error('You must be logged in to do this.');
  return result.data;
}

function validateBeneficiaryInput(data) {
  var error = Validate.run([
    [Validate.required, data && data.FirstName, 'First name'],
    [Validate.maxLength, data && data.FirstName, 60, 'First name'],
    [Validate.required, data && data.LastName, 'Last name'],
    [Validate.maxLength, data && data.LastName, 60, 'Last name'],
    [Validate.required, data && data.Age, 'Age'],
    [Validate.required, data && data.Gender, 'Gender'],
    [Validate.oneOf, data && data.Gender, BENEFICIARY_GENDERS, 'Gender'],
    [Validate.required, data && data.Country, 'Country'],
    [Validate.maxLength, data && data.Country, 60, 'Country'],
    [Validate.required, data && data.Region, 'Region/County'],
    [Validate.maxLength, data && data.Region, 60, 'Region/County'],
    [Validate.required, data && data.Community, 'Location'],
    [Validate.maxLength, data && data.Community, 100, 'Location'],
    [Validate.required, data && data.EducationLevel, 'Education level'],
    [Validate.oneOf, data && data.EducationLevel, BENEFICIARY_EDUCATION_LEVELS, 'Education level'],
    [Validate.required, data && data.UserCategory, 'User category'],
    [Validate.oneOf, data && data.UserCategory, BENEFICIARY_USER_CATEGORIES, 'User category'],
    [Validate.isPhone, data && data.Phone, 'Phone'],
    [Validate.isEmail, data && data.Email, 'Email'],
    [Validate.required, data && data.DistanceFromHub, 'Distance from hub'],
    [Validate.oneOf, data && data.DistanceFromHub, BENEFICIARY_DISTANCE_BANDS, 'Distance from hub'],
    [Validate.required, data && data.FirstTimeVisitor, 'First-time visitor'],
    [Validate.oneOf, data && data.FirstTimeVisitor, BENEFICIARY_FIRST_TIME_OPTIONS, 'First-time visitor']
  ]);
  if (error) return error;

  var age = Number(data.Age);
  if (isNaN(age) || age < 0 || age > 120) return 'Age must be a number between 0 and 120.';

  return null;
}
