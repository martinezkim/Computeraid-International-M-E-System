/**
 * ============================================================
 * FINANCEDOCUMENTS.GS — Private supporting-document storage (Phase 17)
 * ============================================================
 * DELIBERATELY NOT the beneficiary-photo pattern. Beneficiary photos
 * use DriveApp.setSharing(ANYONE_WITH_LINK, VIEW) + a public thumbnail
 * URL because they're low-sensitivity and need to render as a plain
 * <img src>. Financial documents (receipts, invoices, payroll,
 * funding proof, bank statements) are NOT that — they stay PRIVATE in
 * a single Drive folder (Script Properties: FINANCE_DRIVE_FOLDER_ID,
 * set once by the Admin) and are only ever returned to a client
 * through the access-checked getFinancialDocument() below. The
 * DriveFileID and any Drive URL NEVER reach the client — only a
 * DocumentID (a FinancialDocuments row) does. See
 * FINANCE_MODULE_INSTRUCTIONS.md §8.
 *
 * Upload happens BEFORE the parent record exists (a user attaches a
 * receipt while still filling out an Expense form, for instance), so
 * LinkedTable/LinkedRecordID start blank and get backfilled by
 * claimFinancialDocument_() once the parent record has been inserted.
 * Until claimed, a document is only visible to whoever uploaded it
 * (see assertManagerOwnsLinkedRecord_) — enough to let them preview
 * their own pending attachment before submitting.
 * ============================================================
 */

var FINANCIAL_DOCUMENTS_TABLE = 'FinancialDocuments';
var FINANCE_DRIVE_FOLDER_PROPERTY_KEY = 'FINANCE_DRIVE_FOLDER_ID';

/**
 * Any authenticated user: uploads a file into the private finance
 * folder and returns just its DocumentID + FileName — never a Drive
 * ID or URL. `linkedTable`/`linkedRecordId` are optional at upload
 * time; pass them when editing an EXISTING record (so the document is
 * correctly scoped immediately) and omit them when creating a new
 * record (the create endpoint claims it after inserting — see
 * claimFinancialDocument_).
 */
function uploadFinancialDocument(sessionToken, opts) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    if (!opts || !opts.base64 || !opts.fileName) {
      throw new Error('No file was provided.');
    }
    if (opts.base64.length > 11000000) { // ~8MB of raw bytes, base64-inflated
      throw new Error('File is too large — please attach a file under 8MB.');
    }

    var folderId = PropertiesService.getScriptProperties().getProperty(FINANCE_DRIVE_FOLDER_PROPERTY_KEY);
    if (!folderId) {
      throw new Error('Financial document storage is not configured yet — an Admin needs to set FINANCE_DRIVE_FOLDER_ID in Script Properties.');
    }
    var folder;
    try {
      folder = DriveApp.getFolderById(folderId);
    } catch (err) {
      throw new Error('The configured financial documents folder could not be found. Check FINANCE_DRIVE_FOLDER_ID.');
    }

    var blob = Utilities.newBlob(Utilities.base64Decode(opts.base64), opts.mimeType || 'application/octet-stream', opts.fileName);
    var file = folder.createFile(blob);
    // Deliberately no file.setSharing(...) call — stays private to the folder.

    var record = DB.insert(FINANCIAL_DOCUMENTS_TABLE, {
      DriveFileID: file.getId(),
      FileName: opts.fileName,
      MimeType: opts.mimeType || 'application/octet-stream',
      LinkedTable: opts.linkedTable || '',
      LinkedRecordID: opts.linkedRecordId || '',
      DocumentType: opts.documentType || '',
      UploadedByEmail: identity.email,
      DateUploaded: new Date()
    });
    logAudit_(identity, 'UploadDoc', FINANCIAL_DOCUMENTS_TABLE, record.DocumentID, 'FileName', '', record.FileName, '');
    return { documentId: record.DocumentID, fileName: record.FileName };
  });
}

/**
 * Backfills LinkedTable/LinkedRecordID once a document's parent record
 * has been created. Internal helper (not client-callable) — called by
 * the various finance create-functions (recordFundingTransaction,
 * createBalanceAdjustment, and — from Phase 17 Step 4/5 onward —
 * createInvoice/createExpense/createReimbursement) right after
 * DB.insert(). A no-op if documentId is blank (nothing was attached).
 */
function claimFinancialDocument_(documentId, linkedTable, linkedRecordId) {
  if (!documentId) return;
  var doc = DB.getById(FINANCIAL_DOCUMENTS_TABLE, documentId);
  if (!doc) return;
  DB.update(FINANCIAL_DOCUMENTS_TABLE, documentId, { LinkedTable: linkedTable, LinkedRecordID: linkedRecordId });
}

/**
 * The ONLY path a client ever gets a financial document's bytes
 * through. Admin sees everything; a Hub Manager may only fetch a
 * document they uploaded themselves OR one linked to a record that
 * belongs to their own hub — see assertManagerOwnsLinkedRecord_.
 * Returns the file as base64 (small documents — receipts, invoices —
 * this module is designed for, not multi-MB bank statement PDFs).
 */
function getFinancialDocument(sessionToken, documentId) {
  return safeExecute(function () {
    var identity = requireIdentity_(sessionToken);
    var doc = DB.getById(FINANCIAL_DOCUMENTS_TABLE, documentId);
    if (!doc) throw new Error('Document not found.');

    if (identity.role !== 'Admin') {
      assertManagerOwnsLinkedRecord_(identity, doc);
    }

    var file = DriveApp.getFileById(doc.DriveFileID);
    var blob = file.getBlob();
    return {
      documentId: doc.DocumentID,
      fileName: doc.FileName,
      mimeType: doc.MimeType,
      base64: Utilities.base64Encode(blob.getBytes())
    };
  });
}

/**
 * Throws unless `identity` (a non-Admin) is allowed to see `doc`: either
 * they uploaded it themselves (covers previewing your own not-yet-saved
 * attachment), or it's linked to a record that resolves to their own
 * hub. Invoices/Expenses/Reimbursements/Salaries/FundingTransactions
 * all carry a HubID field this check reads directly. BalanceAdjustments
 * has no HubID (it's Admin-only end to end — see BalanceAdjustments.gs),
 * so a linked-but-not-self-uploaded adjustment document correctly falls
 * through to the "no access" branch below for any non-Admin.
 */
function assertManagerOwnsLinkedRecord_(identity, doc) {
  if (doc.UploadedByEmail === identity.email) return;
  if (!doc.LinkedTable || !doc.LinkedRecordID) {
    throw new Error('You do not have access to this document.');
  }
  var record = DB.getById(doc.LinkedTable, doc.LinkedRecordID);
  if (!record || record.HubID !== identity.hubId) {
    throw new Error('You do not have access to this document.');
  }
}
