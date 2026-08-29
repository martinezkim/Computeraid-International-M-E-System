/**
 * ============================================================
 * INVOICES.GS — Invoice creation + approval workflow (Phase 17)
 * ============================================================
 * Status workflow: Submitted -> Under Review -> (Approved | Rejected
 * | Returned). A Returned invoice can be edited and resubmitted
 * (back to Submitted). Cancelled is reachable any time before payment
 * and is the ONLY way a mistaken invoice is retired — never deleted.
 *
 * PaymentStatus is a SEPARATE axis from Status — an invoice can be
 * Approved and still Unpaid. Raising an invoice deducts nothing from
 * any balance; approving moves it into "Committed" (see
 * FinanceBalance.gs's approvedUnpaidForAccount_); only PaymentStatus
 * = Paid moves it into actual paid expenditure. This file never
 * touches a balance directly — FinanceBalance.gs computes everything
 * by reading Status/PaymentStatus on read.
 * ============================================================
 */

var INVOICES_TABLE = 'Invoices';
var INVOICE_PAYMENT_METHODS = ['Bank Transfer', 'Mobile Money', 'Cash', 'Cheque', 'Other'];

// A "stipend" invoice (a Hub Manager invoicing for their own stipend, not
// a third-party supplier) is filed under the Admin's Salaries tab instead
// of the plain Invoices tab — see getStipendInvoices below and
// FinanceExpensesJS.html's fetchSalaries(). Either signal is enough:
// the reserved category (distinct from 'Salaries' itself, which
// assertNotSalaryCategory_ blocks Invoices from ever using), or the tag.
var FINANCE_STIPEND_CATEGORY_NAME = 'Stipend/Salaries';
var INVOICE_TAGS = ['Monthly Stipends'];

function isStipendInvoice_(invoice) {
  return invoice.ExpenseCategory === FINANCE_STIPEND_CATEGORY_NAME || invoice.InvoiceTag === 'Monthly Stipends';
}

/**
 * Admin: every invoice, org-wide, optionally filtered. `options.pendingOnly`
 * scopes to the Awaiting Approval tab. Excludes stipend invoices by
 * default (see isStipendInvoice_) — those are filed under the Salaries
 * tab instead (getStipendInvoices); pass `options.includeStipends` to see
 * everything.
 */
function getInvoices(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var accountNames = {};
    DB.getAll(FINANCIAL_ACCOUNTS_TABLE).forEach(function (a) { accountNames[a.AccountID] = a.AccountName; });

    var all = applyHubScope_(DB.getAll(INVOICES_TABLE), resolveAdminHubScope_(identity), 'HubID');
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');
    if (!options.includeStipends) all = all.filter(function (i) { return !isStipendInvoice_(i); });
    if (options.hubId) all = all.filter(function (i) { return i.HubID === options.hubId; });
    if (options.status) all = all.filter(function (i) { return i.Status === options.status; });
    if (options.pendingOnly) all = all.filter(function (i) { return FINANCE_PENDING_STATUSES.indexOf(i.Status) !== -1; });

    all = all.map(function (i) {
      return withField_(i, {
        HubName: hubNames[i.HubID] || i.HubID,
        AccountName: accountNames[i.AccountID] || i.AccountID
      });
    });

    return paginateAndFilter(all, {
      search: options.search,
      searchColumns: SCHEMA[INVOICES_TABLE].searchableColumns,
      sortBy: options.sortBy || 'DateSubmitted',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/**
 * Admin: stipend invoices only (see isStipendInvoice_) — org-wide, same
 * shape/pagination as getInvoices. Merged into the Admin's Salaries tab
 * (FinanceExpensesJS.html's fetchSalaries) alongside real payroll Salary
 * rows, so a Hub Manager's own stipend invoice is easy to find there —
 * it's still a genuine Invoice underneath (same InvoiceID, same
 * approve/reject/pay workflow via approveInvoice/payInvoice/etc.), just
 * filed for display under Salaries instead of the plain Invoices list.
 */
function getStipendInvoices(sessionToken, options) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    options = options || {};

    var hubNames = hubNameLookup_();
    var accountNames = {};
    DB.getAll(FINANCIAL_ACCOUNTS_TABLE).forEach(function (a) { accountNames[a.AccountID] = a.AccountName; });

    var all = applyHubScope_(DB.getAll(INVOICES_TABLE), resolveAdminHubScope_(identity), 'HubID').filter(isStipendInvoice_);
    all = applyHubScope_(all, resolveCountryFilterScope_(options.countryId), 'HubID');
    if (options.hubId) all = all.filter(function (i) { return i.HubID === options.hubId; });

    all = all.map(function (i) {
      return withField_(i, {
        HubName: hubNames[i.HubID] || i.HubID,
        AccountName: accountNames[i.AccountID] || i.AccountID
      });
    });

    return paginateAndFilter(all, {
      sortBy: 'DateSubmitted',
      sortDir: 'desc',
      page: 1,
      pageSize: 100000
    }).records;
  });
}

/** Hub Manager: invoices submitted against their own hub only. */
function getMyHubInvoices(sessionToken, options) {
  return safeExecute(function () {
    var manager = requireManagerSession_(sessionToken);
    options = options || {};

    var accountNames = {};
    DB.getAll(FINANCIAL_ACCOUNTS_TABLE).forEach(function (a) { accountNames[a.AccountID] = a.AccountName; });

    var mine = DB.getAll(INVOICES_TABLE).filter(function (i) { return i.HubID === manager.hubId; });
    mine = mine.map(function (i) { return withField_(i, { AccountName: accountNames[i.AccountID] || i.AccountID }); });

    return paginateAndFilter(mine, {
      search: options.search,
      searchColumns: SCHEMA[INVOICES_TABLE].searchableColumns,
      sortBy: options.sortBy || 'DateSubmitted',
      sortDir: options.sortDir || 'desc',
      page: options.page || 1,
      pageSize: options.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE
    });
  });
}

/** Any authenticated user creates AND submits an invoice in one step — there is no separate save-as-draft UI in this MVP. */
function createInvoice(sessionToken, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var hubId = identity.role === 'HubManager' ? identity.hubId : (data.HubID || '');
    var error = validateInvoiceInput(data, identity);
    if (error) throw new Error(error);

    var lineItems = parseInvoiceLineItems_(data);
    if (!lineItems.length) throw new Error('Add at least one invoice line item.');
    var totals = computeInvoiceTotals_(lineItems, data.Discount, data.TaxRate);

    // The Hub Manager IS the payee on a generated invoice (they invoice
    // Computer Aid for their stipend/office costs), so their own name is
    // the "supplier"; an Admin creating one still supplies a name.
    var supplierName = identity.role === 'HubManager' ? identity.fullName : String(data.SupplierName || '').trim();

    var record = DB.insert(INVOICES_TABLE, {
      InvoiceNumber: (data.InvoiceNumber || '').trim(),
      InvoiceDate: data.InvoiceDate,
      DateSubmitted: new Date(),
      SupplierName: supplierName,
      SupplierContact: (data.SupplierContact || '').trim(),
      SupplierInvoiceRef: (data.SupplierInvoiceRef || '').trim(),
      ProjectID: data.ProjectID || '',
      HubID: hubId,
      ExpenseCategory: data.ExpenseCategory,
      BudgetLineID: data.BudgetLineID || '',
      Description: (data.Description || '').trim(),
      Amount: totals.subtotal,
      TaxAmount: totals.taxAmount,
      TotalAmount: totals.total,
      Currency: data.Currency,
      PaymentMethod: data.PaymentMethod || '',
      AccountID: data.AccountID,
      InvoiceDocumentID: '',
      Status: 'Submitted',
      SubmittedByEmail: identity.email,
      SubmittedByRole: identity.role,
      PaymentStatus: 'Unpaid',
      Notes: (data.Notes || '').trim(),
      LineItemsJSON: JSON.stringify(lineItems),
      Discount: totals.discount,
      TaxRate: totals.taxRate,
      InvoiceTag: (data.InvoiceTag || '').trim()
    });

    // Generate the branded PDF and attach it. Never let a PDF/storage
    // hiccup (e.g. FINANCE_DRIVE_FOLDER_ID unset) block the submission —
    // the invoice still exists and can be regenerated on resubmit.
    var docId = generateAndAttachInvoicePdf_(identity, record);
    if (docId) record = DB.update(INVOICES_TABLE, record.InvoiceID, { InvoiceDocumentID: docId });

    logAudit_(identity, 'Submit', INVOICES_TABLE, record.InvoiceID, '(record)', '', record.SupplierName + ' ' + record.TotalAmount, record.HubID);
    notify_({
      type: 'InvoiceSubmitted', severity: 'info',
      message: 'Invoice from ' + record.SupplierName + ' (' + record.TotalAmount + ' ' + record.Currency + ') submitted for approval.',
      targetRole: 'Admin', targetAccessLevels: FINANCE_ACCESS_LEVELS, relatedTable: INVOICES_TABLE, relatedRecordId: record.InvoiceID
    });
    return record;
  });
}

/** Edits + resubmits a Returned invoice — only the original submitter or an Admin, and only while it's still Returned. */
function resubmitInvoice(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(INVOICES_TABLE, id);
    if (!existing) throw new Error('Invoice not found.');
    if (existing.Status !== 'Returned') throw new Error('Only a Returned invoice can be resubmitted.');
    if (identity.role !== 'Admin' && identity.email !== existing.SubmittedByEmail) {
      throw new Error('Only the person who submitted this invoice (or an Admin) can resubmit it.');
    }

    var error = validateInvoiceInput(data, identity);
    if (error) throw new Error(error);

    var lineItems = parseInvoiceLineItems_(data);
    if (!lineItems.length) throw new Error('Add at least one invoice line item.');
    var totals = computeInvoiceTotals_(lineItems, data.Discount, data.TaxRate);
    var supplierName = identity.role === 'HubManager' ? identity.fullName : String(data.SupplierName || '').trim();

    var record = DB.update(INVOICES_TABLE, id, {
      InvoiceNumber: (data.InvoiceNumber || '').trim(),
      InvoiceDate: data.InvoiceDate,
      DateSubmitted: new Date(),
      SupplierName: supplierName,
      SupplierContact: (data.SupplierContact || '').trim(),
      SupplierInvoiceRef: (data.SupplierInvoiceRef || '').trim(),
      ProjectID: data.ProjectID || '',
      ExpenseCategory: data.ExpenseCategory,
      BudgetLineID: data.BudgetLineID || '',
      Description: (data.Description || '').trim(),
      Amount: totals.subtotal,
      TaxAmount: totals.taxAmount,
      TotalAmount: totals.total,
      Currency: data.Currency,
      PaymentMethod: data.PaymentMethod || '',
      AccountID: data.AccountID,
      Status: 'Submitted',
      RejectionReason: '',
      Notes: (data.Notes || '').trim(),
      LineItemsJSON: JSON.stringify(lineItems),
      Discount: totals.discount,
      TaxRate: totals.taxRate,
      InvoiceTag: (data.InvoiceTag || '').trim()
    });

    // Regenerate the branded PDF from the corrected details.
    var docId = generateAndAttachInvoicePdf_(identity, record);
    if (docId) record = DB.update(INVOICES_TABLE, id, { InvoiceDocumentID: docId });

    logAudit_(identity, 'Resubmit', INVOICES_TABLE, id, 'Status', 'Returned', 'Submitted', record.HubID);
    return record;
  });
}

/** Admin only — purely informational status showing someone has started looking at it. */
function markInvoiceUnderReview(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(INVOICES_TABLE, id);
    if (!existing) throw new Error('Invoice not found.');
    if (existing.Status !== 'Submitted') throw new Error('Only a Submitted invoice can be marked Under Review.');

    var record = DB.update(INVOICES_TABLE, id, { Status: 'Under Review', ReviewedByEmail: identity.email });
    logAudit_(identity, 'Review', INVOICES_TABLE, id, 'Status', 'Submitted', 'Under Review', record.HubID);
    return record;
  });
}

/** Admin only, and never the person who submitted it — the point an invoice's amount moves into "Committed". */
function approveInvoice(sessionToken, id) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(INVOICES_TABLE, id);
    if (!existing) throw new Error('Invoice not found.');
    if (['Submitted', 'Under Review'].indexOf(existing.Status) === -1) {
      throw new Error('Only a Submitted or Under Review invoice can be approved.');
    }
    assertNotSelfApproval_(existing.SubmittedByEmail, identity);

    var record = DB.update(INVOICES_TABLE, id, {
      Status: 'Approved',
      ApprovedByEmail: identity.email,
      ApprovalDate: new Date()
    });
    logAudit_(identity, 'Approve', INVOICES_TABLE, id, 'Status', existing.Status, 'Approved', record.HubID);
    notify_({
      type: 'InvoiceApproved', severity: 'info',
      message: 'Your invoice from ' + record.SupplierName + ' (' + record.TotalAmount + ' ' + record.Currency + ') was approved.',
      targetEmail: record.SubmittedByEmail, relatedTable: INVOICES_TABLE, relatedRecordId: id
    });
    return record;
  });
}

function rejectInvoice(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(INVOICES_TABLE, id);
    if (!existing) throw new Error('Invoice not found.');
    if (['Submitted', 'Under Review'].indexOf(existing.Status) === -1) {
      throw new Error('Only a Submitted or Under Review invoice can be rejected.');
    }
    if (!reason || !reason.trim()) throw new Error('A reason is required to reject an invoice.');

    var record = DB.update(INVOICES_TABLE, id, {
      Status: 'Rejected',
      ApprovedByEmail: identity.email,
      ApprovalDate: new Date(),
      RejectionReason: reason.trim()
    });
    logAudit_(identity, 'Reject', INVOICES_TABLE, id, 'Status', existing.Status, 'Rejected', record.HubID);
    notify_({
      type: 'InvoiceRejected', severity: 'warning',
      message: 'Your invoice from ' + record.SupplierName + ' was rejected: ' + reason.trim(),
      targetEmail: record.SubmittedByEmail, relatedTable: INVOICES_TABLE, relatedRecordId: id
    });
    return record;
  });
}

/** Sends an invoice back to the submitter for correction rather than outright rejecting it. */
function returnInvoiceForCorrection(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(INVOICES_TABLE, id);
    if (!existing) throw new Error('Invoice not found.');
    if (['Submitted', 'Under Review'].indexOf(existing.Status) === -1) {
      throw new Error('Only a Submitted or Under Review invoice can be returned for correction.');
    }
    if (!reason || !reason.trim()) throw new Error('A reason is required to return an invoice for correction.');

    var record = DB.update(INVOICES_TABLE, id, {
      Status: 'Returned',
      ReviewedByEmail: identity.email,
      RejectionReason: reason.trim()
    });
    logAudit_(identity, 'Return', INVOICES_TABLE, id, 'Status', existing.Status, 'Returned', record.HubID);
    notify_({
      type: 'InvoiceReturned', severity: 'warning',
      message: 'Your invoice from ' + record.SupplierName + ' was returned for correction: ' + reason.trim(),
      targetEmail: record.SubmittedByEmail, relatedTable: INVOICES_TABLE, relatedRecordId: id
    });
    return record;
  });
}

/** Admin only — the point an Approved invoice's amount moves out of "Committed" and into actual paid expenditure. */
function payInvoice(sessionToken, id, data) {
  return safeExecute(function () {
    var identity = requireAdminSession_(sessionToken);
    var existing = DB.getById(INVOICES_TABLE, id);
    if (!existing) throw new Error('Invoice not found.');
    if (existing.Status !== 'Approved') throw new Error('Only an Approved invoice can be marked Paid.');
    if (existing.PaymentStatus === 'Paid') throw new Error('This invoice has already been paid.');

    var record = DB.update(INVOICES_TABLE, id, {
      PaymentStatus: 'Paid',
      PaymentDate: (data && data.PaymentDate) || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      PaymentReference: (data && data.PaymentReference || '').trim()
    });
    logAudit_(identity, 'Pay', INVOICES_TABLE, id, 'PaymentStatus', 'Unpaid', 'Paid', record.HubID);
    return record;
  });
}

/**
 * Retires a mistaken invoice — never deleted, only marked Cancelled.
 * An Admin can cancel any unpaid invoice; the original submitter can
 * cancel their own invoice ONLY before it's been Approved (once
 * Approved/Committed, only an Admin should be able to undo that).
 */
function cancelInvoice(sessionToken, id, reason) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var existing = DB.getById(INVOICES_TABLE, id);
    if (!existing) throw new Error('Invoice not found.');
    if (existing.PaymentStatus === 'Paid') {
      throw new Error('This invoice has already been paid — use a Balance Adjustment if a correction is genuinely needed.');
    }
    var isAdmin = identity.role === 'Admin';
    var isOwnUnapproved = identity.email === existing.SubmittedByEmail && existing.Status !== 'Approved';
    if (!isAdmin && !isOwnUnapproved) {
      throw new Error('You do not have permission to cancel this invoice.');
    }
    if (!reason || !reason.trim()) throw new Error('A reason is required to cancel an invoice.');

    var record = DB.update(INVOICES_TABLE, id, { Status: 'Cancelled', RejectionReason: reason.trim() });
    logAudit_(identity, 'Cancel', INVOICES_TABLE, id, 'Status', existing.Status, 'Cancelled', record.HubID);
    return record;
  });
}

function validateInvoiceInput(data, identity) {
  // Amount/SupplierName are no longer client-supplied for a generated
  // invoice: the total is computed from the line items server-side, and a
  // Hub Manager's own name is the payee. An Admin creating one still names
  // a supplier.
  var checks = [
    [Validate.required, data && data.InvoiceDate, 'Invoice date'],
    [Validate.required, data && data.ExpenseCategory, 'Expense category'],
    [Validate.required, data && data.Currency, 'Currency'],
    [Validate.required, data && data.AccountID, 'Account'],
    [Validate.exists, 'FinancialAccounts', data && data.AccountID, 'Account'],
    [Validate.nonNegativeNumber, data && data.Discount, 'Discount'],
    [Validate.nonNegativeNumber, data && data.TaxRate, 'Tax rate']
  ];
  if (identity.role === 'Admin') {
    checks.unshift([Validate.maxLength, data && data.SupplierName, 150, 'Supplier name']);
    checks.unshift([Validate.required, data && data.SupplierName, 'Supplier name']);
  }
  if (identity.role === 'Admin' && data && data.HubID) checks.push([Validate.exists, 'Hubs', data.HubID, 'Hub']);
  if (data && data.ProjectID) checks.push([Validate.exists, 'Projects', data.ProjectID, 'Project']);
  if (data && data.BudgetLineID) checks.push([Validate.exists, 'BudgetLines', data.BudgetLineID, 'Budget line']);
  if (data && data.PaymentMethod) checks.push([Validate.oneOf, data.PaymentMethod, INVOICE_PAYMENT_METHODS, 'Payment method']);
  if (data && data.InvoiceTag) checks.push([Validate.oneOf, data.InvoiceTag, INVOICE_TAGS, 'Tag']);

  var error = Validate.run(checks);
  if (error) return error;
  return assertNotSalaryCategory_(data && data.ExpenseCategory);
}

/** Normalizes client line items to [{description, unitCost, qtyRate, amount}], dropping fully-empty rows. */
function parseInvoiceLineItems_(data) {
  var items = data && data.LineItems;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (e) { items = []; }
  }
  if (!Array.isArray(items)) items = [];
  return items.map(function (it) {
    return {
      description: String((it && it.description) || '').trim(),
      unitCost: Number(it && it.unitCost) || 0,
      qtyRate: Number(it && it.qtyRate) || 0,
      amount: Number(it && it.amount) || 0
    };
  }).filter(function (it) { return it.description !== '' || it.amount !== 0; });
}

/** Subtotal (sum of line amounts) -> minus discount -> plus tax (a percentage of the discounted subtotal). All rounded to 2dp. */
function computeInvoiceTotals_(lineItems, discount, taxRate) {
  var round2 = function (n) { return Math.round(n * 100) / 100; };
  var subtotal = round2(lineItems.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0));
  var disc = round2(Number(discount) || 0);
  var taxable = Math.max(0, subtotal - disc);
  var rate = Number(taxRate) || 0;
  var taxAmount = round2(taxable * rate / 100);
  return { subtotal: subtotal, discount: disc, taxRate: rate, taxAmount: taxAmount, total: round2(taxable + taxAmount) };
}

/**
 * ============================================================
 * GENERATED INVOICE PDF (Computer Aid branded)
 * ============================================================
 * Renders the invoice to branded HTML, converts it to a PDF via the
 * Utilities blob conversion, stores it in the private finance Drive
 * folder as a FinancialDocuments row, and returns that DocumentID so
 * createInvoice/resubmitInvoice can set InvoiceDocumentID. Returns ''
 * (never throws) if PDF generation or storage fails — a submission must
 * never be blocked by a document hiccup. The client downloads it later
 * through the existing access-checked getFinancialDocument().
 * ============================================================
 */
function generateAndAttachInvoicePdf_(identity, invoice) {
  try {
    var sender, bank;
    if (invoice.SubmittedByRole === 'HubManager') {
      var manager = DB.getById(MANAGERS_TABLE, invoice.SubmittedByEmail);
      var hub = manager ? DB.getById('Hubs', manager.HubID) : null;
      sender = {
        name: manager ? (manager.FirstName + ' ' + manager.LastName).trim() : invoice.SupplierName,
        title: hub ? ('Manager ' + hub.HubName) : 'Hub Manager',
        phone: manager ? (manager.Phone || '') : '',
        email: invoice.SubmittedByEmail,
        address: manager ? (manager.Address || '') : ''
      };
      bank = manager ? {
        accountName: manager.BankAccountName || '',
        accountNumber: manager.BankAccountNumber || '',
        bank: manager.BankName || '',
        bankCode: manager.BankCode || '',
        swift: manager.SwiftCode || '',
        branch: manager.BankBranch || '',
        branchCode: manager.BranchCode || ''
      } : null;
    } else {
      sender = { name: invoice.SupplierName, title: '', phone: invoice.SupplierContact || '', email: '', address: '' };
      bank = null;
    }

    var html = buildInvoiceHtml_(invoice, sender, bank);
    var fileName = 'Invoice_' + (invoice.InvoiceNumber || invoice.InvoiceID) + '.pdf';
    var pdfBlob = Utilities.newBlob(html, 'text/html', 'invoice.html').getAs('application/pdf');
    pdfBlob.setName(fileName);

    var folderId = PropertiesService.getScriptProperties().getProperty(FINANCE_DRIVE_FOLDER_PROPERTY_KEY);
    if (!folderId) return '';
    var file = DriveApp.getFolderById(folderId).createFile(pdfBlob);

    var docRecord = DB.insert(FINANCIAL_DOCUMENTS_TABLE, {
      DriveFileID: file.getId(),
      FileName: fileName,
      MimeType: 'application/pdf',
      LinkedTable: INVOICES_TABLE,
      LinkedRecordID: invoice.InvoiceID,
      DocumentType: 'GeneratedInvoice',
      UploadedByEmail: identity.email,
      DateUploaded: new Date()
    });
    return docRecord.DocumentID;
  } catch (err) {
    return '';
  }
}

/** Formats a number as "100,000" (drops .00) or "1,234.50". */
function fmtInvoiceMoney_(n) {
  var parts = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts[1] === '00' ? parts[0] : parts.join('.');
}

/** 'yyyy-MM-dd' -> "30th March 2026". Falls back to the raw string if unparseable. */
function fmtInvoiceDate_(dateStr) {
  var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr || '');
  var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var day = Number(m[3]);
  var ord = (day % 10 === 1 && day !== 11) ? 'st' : (day % 10 === 2 && day !== 12) ? 'nd' : (day % 10 === 3 && day !== 13) ? 'rd' : 'th';
  return day + ord + ' ' + months[Number(m[2]) - 1] + ' ' + m[1];
}

function escInvoiceHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** Builds the branded invoice HTML (Computer Aid yellow #FECA38), matching the approved mockup layout. */
function buildInvoiceHtml_(invoice, sender, bank) {
  var YELLOW = '#FECA38';
  var lineItems;
  try { lineItems = JSON.parse(invoice.LineItemsJSON || '[]'); } catch (e) { lineItems = []; }
  while (lineItems.length < 4) lineItems.push({ description: '', unitCost: 0, qtyRate: 0, amount: 0 }); // pad to a few blank rows like the mockup

  var cur = escInvoiceHtml_(invoice.Currency || '');
  var org = APP_CONFIG.ORG_BILLING;

  var rowsHtml = lineItems.map(function (it, idx) {
    var shade = idx % 2 === 0 ? '#ffffff' : '#f4f4f4';
    return '<tr style="background:' + shade + ';">' +
      '<td style="padding:10px 12px;color:#333;">' + escInvoiceHtml_(it.description) + '</td>' +
      '<td style="padding:10px 12px;text-align:right;color:#333;">' + (it.unitCost ? fmtInvoiceMoney_(it.unitCost) : '') + '</td>' +
      '<td style="padding:10px 12px;text-align:right;color:#333;">' + (it.qtyRate ? fmtInvoiceMoney_(it.qtyRate) : '') + '</td>' +
      '<td style="padding:10px 12px;text-align:right;color:#333;">' + (it.amount ? fmtInvoiceMoney_(it.amount) : '') + '</td>' +
    '</tr>';
  }).join('');

  var termsRows = [];
  if (bank) {
    if (bank.accountName) termsRows.push('Account name: ' + bank.accountName);
    if (bank.accountNumber) termsRows.push('Account number ' + bank.accountNumber);
    if (bank.bank) termsRows.push('Bank: ' + bank.bank);
    if (bank.bankCode) termsRows.push('Bank code: ' + bank.bankCode);
    if (bank.swift) termsRows.push('Swift code: ' + bank.swift);
    if (bank.branch) termsRows.push('Branch: ' + bank.branch);
    if (bank.branchCode) termsRows.push('Branch code: ' + bank.branchCode);
  }
  var termsHtml = termsRows.length
    ? '<div style="margin-top:60px;"><div style="color:#333;font-weight:600;">TERMS</div>' +
      termsRows.map(function (r) { return '<div style="color:#333;font-size:13px;">' + escInvoiceHtml_(r) + '</div>'; }).join('') + '</div>'
    : '';

  var totalsRow = function (label, value, opts) {
    opts = opts || {};
    return '<tr>' +
      '<td style="padding:4px 12px;text-align:right;color:#888;font-size:12px;letter-spacing:.04em;">' + label + '</td>' +
      '<td style="padding:4px 0 4px 12px;text-align:right;color:' + (opts.strong ? '#111' : '#333') + ';font-weight:' + (opts.strong ? '700' : '600') + ';white-space:nowrap;">' + value + '</td>' +
    '</tr>';
  };

  // NOTE: table-based layout only — the Apps Script HTML->PDF converter
  // does not reliably support flexbox or margin:auto, so alignment is
  // done with tables, width %, align attributes and text-align.
  return '' +
  '<html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#333;}</style></head><body>' +
  '<div style="height:26px;background:' + YELLOW + ';"></div>' +
  '<div style="padding:24px 40px;">' +
    '<div style="text-align:right;font-weight:700;color:#111;">' + escInvoiceHtml_(fmtInvoiceDate_(invoice.InvoiceDate)) + '</div>' +
    '<div style="margin-top:18px;">' +
      '<div style="font-size:20px;font-weight:700;color:#222;">' + escInvoiceHtml_(sender.name) + '</div>' +
      '<div style="font-size:13px;color:#444;margin-top:4px;">' + escInvoiceHtml_(sender.title) +
        (sender.phone ? '&nbsp;&nbsp;&nbsp;&nbsp;' + escInvoiceHtml_(sender.phone) : '') + '</div>' +
      '<div style="font-size:13px;color:#444;">' + escInvoiceHtml_(sender.address) +
        (sender.email ? '&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#2a6fb0;">' + escInvoiceHtml_(sender.email) + '</span>' : '') + '</div>' +
    '</div>' +

    '<div style="margin-top:26px;font-size:11px;color:#999;font-weight:700;letter-spacing:.08em;">BILLED TO</div>' +
    '<div style="font-size:13px;color:#333;">' + escInvoiceHtml_(org.name) + ',<br>' + org.addressLines.map(escInvoiceHtml_).join('<br>') + '</div>' +

    '<div style="text-align:right;font-weight:600;color:#222;margin-top:8px;">Invoice #' + escInvoiceHtml_(invoice.InvoiceNumber || invoice.InvoiceID) + '</div>' +

    '<table width="100%" style="margin-top:6px;border-collapse:collapse;"><tr>' +
      '<td valign="bottom" width="32%" style="font-size:36px;color:#555;font-weight:400;">Invoice</td>' +
      '<td width="68%">' +
        '<table width="100%" style="border-collapse:collapse;font-size:12px;">' +
          '<thead><tr style="background:' + YELLOW + ';color:#fff;">' +
            '<th align="left" style="padding:10px 12px;">DESCRIPTION</th>' +
            '<th align="right" style="padding:10px 12px;">UNIT COST</th>' +
            '<th align="right" style="padding:10px 12px;">QTY/DAY RATE</th>' +
            '<th align="right" style="padding:10px 12px;">AMOUNT (' + cur + ')</th>' +
          '</tr></thead><tbody>' + rowsHtml + '</tbody>' +
        '</table>' +
      '</td>' +
    '</tr></table>' +

    '<table width="100%" style="margin-top:14px;border-collapse:collapse;"><tr>' +
      '<td width="60%"></td>' +
      '<td width="40%">' +
        '<table width="100%" style="border-collapse:collapse;font-size:12px;">' +
          totalsRow('SUBTOTAL', fmtInvoiceMoney_(invoice.Amount)) +
          totalsRow('DISCOUNT', fmtInvoiceMoney_(invoice.Discount)) +
          totalsRow('(TAX RATE)', fmtInvoiceMoney_(invoice.TaxRate)) +
          totalsRow('TAX', fmtInvoiceMoney_(invoice.TaxAmount)) +
        '</table>' +
      '</td>' +
    '</tr></table>' +

    '<div style="border-top:2px solid #ccc;margin-top:10px;padding-top:12px;text-align:right;">' +
      '<div style="color:#888;font-size:12px;letter-spacing:.06em;">INVOICE TOTAL</div>' +
      '<div style="font-size:30px;color:#333;">' + fmtInvoiceMoney_(invoice.TotalAmount) + '</div>' +
    '</div>' +

    termsHtml +
  '</div>' +
  '</body></html>';
}
