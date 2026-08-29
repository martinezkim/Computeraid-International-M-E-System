/**
 * ============================================================
 * RPCBRIDGE.GS — HTTP RPC dispatcher (Firebase frontend proof-of-concept)
 * ============================================================
 * Every page in this app already calls the backend through one seam:
 * runServer(functionName, ...args) in CoreJS.html, which wraps
 * google.script.run. This lets a frontend hosted OUTSIDE this Apps
 * Script project (a static site on Firebase Hosting, no iframe) call
 * the exact same functions over plain HTTP instead — CoreJS.html's
 * runServer is reimplemented against fetch() there, everything else
 * about every page is unchanged.
 *
 * RPC_ALLOWLIST is deliberately an explicit list, not "call any global
 * function". google.script.run is already effectively unrestricted-by-
 * name today, but it's only reachable from JS this Apps Script project
 * itself served — a much higher bar than "anyone with the exec URL and
 * curl". Opening that up to a public HTTP endpoint without an allowlist
 * would expose functions that are only safe today because nothing
 * client-side ever calls them (editor-only one-offs like
 * backfillAutoVisitDepartures, createInitialAdmin, etc.), not because
 * they have their own auth check. Every function below keeps its
 * existing internal requireAdminSession_/requireManagerSession_/
 * requireIdentity_ gate completely untouched — this dispatcher changes
 * transport only, never authorization.
 *
 * Started with exactly what the Login + Dashboard proof-of-concept
 * needed; now growing incrementally, one ported batch at a time, per
 * the Firebase-migration plan's Phase 2 rollout — NOT all ~200
 * functions the full app calls yet.
 */

var RPC_ALLOWLIST = {
  getPageContent: getPageContent,
  adminLogin: adminLogin,
  managerLogin: managerLogin,
  getAdmins: getAdmins,
  addAdmin: addAdmin,
  updateAdminAccessLevel: updateAdminAccessLevel,
  updateAdminStatus: updateAdminStatus,
  updateAdminProfile: updateAdminProfile,
  deleteAdmin: deleteAdmin,
  resendAdminCredentials: resendAdminCredentials,
  getMyContacts: getMyContacts,
  getMyThreads: getMyThreads,
  getThreadMessages: getThreadMessages,
  sendChatMessage: sendChatMessage,
  markChatThreadRead: markChatThreadRead,
  getUnreadChatCount: getUnreadChatCount,
  requestPasswordReset: requestPasswordReset,
  // Phase 3: ResetPassword.html was never part of the original POC —
  // these two are public-by-design (gated by the reset token matching
  // the DB record, not a session), same pattern as requestPasswordReset
  // above.
  validateResetToken: validateResetToken,
  resetAccountPassword: resetAccountPassword,
  getIdentity: getIdentity,
  getSystemCurrency: getSystemCurrency,
  logout: logout,
  getDashboardStats: getDashboardStats,
  getMyDashboardStats: getMyDashboardStats,
  getHubById: getHubById,
  getMyNotifications: getMyNotifications,
  markNotificationRead: markNotificationRead,
  markAllNotificationsRead: markAllNotificationsRead,

  // Batch 1 (Beneficiaries + Hub Usage) — BeneficiariesJS, MyBeneficiariesJS,
  // HubUsageJS, MyHubUsageJS
  getHubOptions: getHubOptions,
  getAllBeneficiaries: getAllBeneficiaries,
  getBeneficiaryDependentCounts: getBeneficiaryDependentCounts,
  deleteBeneficiary: deleteBeneficiary,
  getMyHubBeneficiaries: getMyHubBeneficiaries,
  getBeneficiaryFormOptions: getBeneficiaryFormOptions,
  lookupBeneficiary: lookupBeneficiary,
  getBeneficiaryRegistrationBands: getBeneficiaryRegistrationBands,
  getMyBeneficiaryRegistrationBands: getMyBeneficiaryRegistrationBands,
  getHubUsageDashboard: getHubUsageDashboard,
  getActivityOptions: getActivityOptions,
  getVisitorTypeOptions: getVisitorTypeOptions,
  getMyHubActivitySessions: getMyHubActivitySessions,
  getActivitySessionAttendees: getActivitySessionAttendees,
  openActivitySession: openActivitySession,
  closeActivitySession: closeActivitySession,
  forceCloseActivitySession: forceCloseActivitySession,
  getActivitySessionsForAdmin: getActivitySessionsForAdmin,
  getMyHubFeedback: getMyHubFeedback,
  getMyHubDataQualityQueue: getMyHubDataQualityQueue,
  resolveDataQualityIssue: resolveDataQualityIssue,
  getMyHubVisits: getMyHubVisits,
  getAllVisits: getAllVisits,
  getMyHubComputers: getMyHubComputers,
  getMyHubComputerSessions: getMyHubComputerSessions,
  getAllComputers: getAllComputers,
  getAllComputerSessions: getAllComputerSessions,
  recordManualSession: recordManualSession,
  recordVisit: recordVisit,
  endSession: endSession,

  // Batch 2 (Hub Manager daily pages + shared topnav) — MyProfileJS,
  // MyDevicesJS, ManagerProjectsJS, ProjectDetailJS, NotificationsJS,
  // DeviceRequestsJS
  getMyManagerProfile: getMyManagerProfile,
  updateMyManagerProfile: updateMyManagerProfile,
  updateMyManagerPhoto: updateMyManagerPhoto,
  requestManagerEmailChange: requestManagerEmailChange,
  getPendingDeviceRequestsForMyHub: getPendingDeviceRequestsForMyHub,
  getMyHubSyncDevices: getMyHubSyncDevices,
  setMyHubDeviceActive: setMyHubDeviceActive,
  getQuotaOptions: getQuotaOptions,
  getMyProjects: getMyProjects,
  getQuotaDateRange: getQuotaDateRange,
  addProject: addProject,
  setProjectStatus: setProjectStatus,
  deleteProject: deleteProject,
  getDeviceRequestDetail: getDeviceRequestDetail,
  approveDeviceRequest: approveDeviceRequest,
  rejectDeviceRequest: rejectDeviceRequest,

  // Batch 3 (Admin setup pages) — CountriesJS, HubsJS, ManagersJS,
  // QuotasJS, ProjectsJS, AuditLogJS
  getAuditLog: getAuditLog,
  getCountries: getCountries,
  getCountryOptions: getCountryOptions,
  addCountry: addCountry,
  updateCountry: updateCountry,
  deleteCountry: deleteCountry,
  getAllHubsHealthSummary: getAllHubsHealthSummary,
  getHubDetailOverview: getHubDetailOverview,
  getHubs: getHubs,
  addHub: addHub,
  updateHub: updateHub,
  deleteHub: deleteHub,
  getManagers: getManagers,
  addManager: addManager,
  updateManager: updateManager,
  changeManagerEmail: changeManagerEmail,
  deleteManager: deleteManager,
  resendManagerCredentials: resendManagerCredentials,
  getQuotas: getQuotas,
  previewQuotaDateRange: previewQuotaDateRange,
  addQuota: addQuota,
  updateQuota: updateQuota,
  deleteQuota: deleteQuota,
  getProjectYearOptions: getProjectYearOptions,
  getAllProjects: getAllProjects,

  // Batch 4 (Finance module) — FinanceDashboardJS, FinanceAccountsJS,
  // FinanceExpensesJS, MyFinanceJS, MyExpensesJS, FinanceReportsJS,
  // FinanceConfigJS
  getFinancialDashboard: getFinancialDashboard,
  getMyHubFinancialSummary: getMyHubFinancialSummary,
  getProjectOptions: getProjectOptions,
  getFinancialAccountOptions: getFinancialAccountOptions,
  getFinancialAccounts: getFinancialAccounts,
  addFinancialAccount: addFinancialAccount,
  updateFinancialAccount: updateFinancialAccount,
  getFundingTransactions: getFundingTransactions,
  recordFundingTransaction: recordFundingTransaction,
  confirmFundingTransaction: confirmFundingTransaction,
  cancelFundingTransaction: cancelFundingTransaction,
  getBalanceAdjustments: getBalanceAdjustments,
  createBalanceAdjustment: createBalanceAdjustment,
  approveBalanceAdjustment: approveBalanceAdjustment,
  rejectBalanceAdjustment: rejectBalanceAdjustment,
  getBankStatements: getBankStatements,
  previewBankStatementCsv: previewBankStatementCsv,
  importBankStatement: importBankStatement,
  getBankTransactions: getBankTransactions,
  getReconciliations: getReconciliations,
  previewReconciliation: previewReconciliation,
  createReconciliation: createReconciliation,
  resolveReconciliation: resolveReconciliation,
  autoMatchBankTransactions: autoMatchBankTransactions,
  getMatchCandidates: getMatchCandidates,
  manualMatchBankTransaction: manualMatchBankTransaction,
  unmatchBankTransaction: unmatchBankTransaction,
  ignoreBankTransaction: ignoreBankTransaction,
  getFinanceCategories: getFinanceCategories,
  getFinanceCategoryOptions: getFinanceCategoryOptions,
  addFinanceCategory: addFinanceCategory,
  updateFinanceCategory: updateFinanceCategory,
  getFinanceStaff: getFinanceStaff,
  getFinanceStaffOptions: getFinanceStaffOptions,
  addFinanceStaff: addFinanceStaff,
  updateFinanceStaff: updateFinanceStaff,
  // Missed in the original Batch 4 sweep — dispatched via fnByKind[...]
  // object lookup in FinanceConfigJS.html, not a literal runServer('...')
  // string, so the literal-string grep didn't catch it.
  deleteFinanceCategory: deleteFinanceCategory,
  deleteFinanceStaff: deleteFinanceStaff,
  getExchangeRates: getExchangeRates,
  setExchangeRate: setExchangeRate,
  getMonthlyFinancialReport: getMonthlyFinancialReport,
  getProjectFinancialReport: getProjectFinancialReport,
  getHubFinancialReport: getHubFinancialReport,
  getCategoryReport: getCategoryReport,
  getExpenses: getExpenses,
  getMyHubExpenses: getMyHubExpenses,
  createExpense: createExpense,
  resubmitExpense: resubmitExpense,
  getReimbursements: getReimbursements,
  getMyHubReimbursements: getMyHubReimbursements,
  createReimbursement: createReimbursement,
  resubmitReimbursement: resubmitReimbursement,
  approveReimbursement: approveReimbursement,
  getInvoices: getInvoices,
  getStipendInvoices: getStipendInvoices,
  getMyHubInvoices: getMyHubInvoices,
  createInvoice: createInvoice,
  resubmitInvoice: resubmitInvoice,
  markInvoiceUnderReview: markInvoiceUnderReview,
  getSalaries: getSalaries,
  createSalary: createSalary,
  approveSalary: approveSalary,
  paySalary: paySalary,
  cancelSalary: cancelSalary,

  // Batch 5 (Inventory) — AdminInventoryJS, InventorySummaryJS,
  // InventoryJS, LaptopsJS
  // NOTE: getAdminInventoryList/getAdminLaptopsGrouped/getAdminLaptopsList
  // and getMyLaptops/getMyLaptopsGrouped are picked dynamically via a
  // ternary in the JS (`var fn = ...; runServer(fn, ...)`), not a literal
  // string — a plain grep for runServer('fnName' misses these. Verify with
  // `grep "var fn = "` when auditing a batch's RPC surface, not just the
  // literal-string grep.
  getAdminInventoryList: getAdminInventoryList,
  getAdminLaptopsList: getAdminLaptopsList,
  getAdminLaptopsGrouped: getAdminLaptopsGrouped,
  getMyLaptops: getMyLaptops,
  getMyLaptopsGrouped: getMyLaptopsGrouped,
  getGlobalInventoryOverview: getGlobalInventoryOverview,
  getInventoryExportData: getInventoryExportData,
  getInventorySummaryDashboard: getInventorySummaryDashboard,
  getInventoryFormOptions: getInventoryFormOptions,
  getMyInventorySummary: getMyInventorySummary,
  getMyInventory: getMyInventory,
  addInventoryItem: addInventoryItem,
  updateInventoryItem: updateInventoryItem,
  deleteInventoryItem: deleteInventoryItem,
  getLaptopFormOptions: getLaptopFormOptions,
  getMyLaptopFilterValues: getMyLaptopFilterValues,
  getMyLaptopsSummary: getMyLaptopsSummary,
  suggestNextLaptopOrderNumber: suggestNextLaptopOrderNumber,
  addLaptop: addLaptop,
  updateLaptop: updateLaptop,
  deleteLaptop: deleteLaptop,
  previewLaptopImport: previewLaptopImport,
  confirmLaptopImport: confirmLaptopImport,

  // Batch 6 (final batch — Usage Overview, Usage Settings, Sync Devices)
  getGlobalUsageDashboard: getGlobalUsageDashboard,
  getAllFeedback: getAllFeedback,
  getAIInsights: getAIInsights,
  generateHubInsight: generateHubInsight,
  generateGlobalInsight: generateGlobalInsight,
  getAllDataQualityIssues: getAllDataQualityIssues,
  markInsightReviewed: markInsightReviewed,
  getTrainingCourses: getTrainingCourses,
  addTrainingCourse: addTrainingCourse,
  updateTrainingCourse: updateTrainingCourse,
  deleteTrainingCourse: deleteTrainingCourse,
  getActivities: getActivities,
  addActivity: addActivity,
  updateActivity: updateActivity,
  deleteActivity: deleteActivity,
  getVisitorTypes: getVisitorTypes,
  addVisitorType: addVisitorType,
  updateVisitorType: updateVisitorType,
  deleteVisitorType: deleteVisitorType,
  getAgeBands: getAgeBands,
  addAgeBand: addAgeBand,
  updateAgeBand: updateAgeBand,
  deleteAgeBand: deleteAgeBand,
  getHubSchedules: getHubSchedules,
  setHubSchedule: setHubSchedule,
  provisionSyncDevice: provisionSyncDevice,
  getSyncDevices: getSyncDevices,
  setSyncDeviceActive: setSyncDeviceActive
};

/** doPost target when body.action === 'rpc'. body is already-parsed JSON: {fn, args}. */
function handleRpcRequest_(body) {
  try {
    var fn = RPC_ALLOWLIST[body.fn];
    if (typeof fn !== 'function') throw new Error('Unknown or disallowed function: ' + body.fn);
    var result = fn.apply(null, body.args || []);
    return jsonResponse_({ status: 'ok', result: result });
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message });
  }
}
