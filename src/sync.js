// src/sync.js
// Reads the SAMPLES Google Sheet and syncs orders to PostgreSQL
// Column mapping based on actual sheet structure (sample_sheet_v2.xlsx):
//
//  A (0)  = Status            B (1)  = ID Type        C (2)  = Type
//  D (3)  = Order #           E (4)  = Due Date        F (5)  = Sets
//  G (6)  = Pieces            H (7)  = Path            I (8)  = Designer
//  J (9)  = QC                K (10) = Sent Date       L (11) = SKU
//  M (12) = Design            N (13) = Ext Status      O (14) = Ext By
//  P (15) = Ext Date          Q (16) = Ext Line        R (17) = Ext Reason
//  S (18) = Ext Comment       T (19) = CPA Status      U (20) = Last CPA Check

require('dotenv').config();
const { google } = require('googleapis');
const db         = require('./db');

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'SAMPLES';
const DESIGNER  = 'ransiel garcia';

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env variable not set.');
  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON: ' + e.message); }
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
}

function fmtDate(val) {
  if (!val) return null;
  // Already a JS Date (from googleapis)
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    return val.toISOString().split('T')[0];
  }
  // String like "2026-04-24" or "4/24/2026"
  const s = String(val).trim();
  if (!s || s === 'null') return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

function parseRow(cols) {
  // cols is an array of cell values (0-indexed matching the sheet)
  const get = (i) => (cols[i] !== undefined && cols[i] !== null) ? String(cols[i]).trim() : '';

  const orderNum = get(3);
  // Must look like SO-NNNNNNN
  if (!orderNum || !/^SO-\d+/i.test(orderNum)) return null;

  // Designer filter — must contain "ransiel"
  const designer = get(8);
  if (!designer.toLowerCase().includes('ransiel') &&
      !designer.toLowerCase().includes('garcia')) return null;

  return {
    order_num:   orderNum,
    status:      get(0),
    id_type:     get(1),
    type:        get(2),
    due_date:    fmtDate(cols[4]),
    sets:        parseFloat(get(5)) || 0,
    pieces:      parseFloat(get(6)) || 0,
    path:        get(7),
    designer:    designer,
    qc:          get(9),
    sent_date:   fmtDate(cols[10]),
    sku:         get(11),
    design:      get(12),
    ext_status:  get(13) || 'None',
    ext_by:      get(14),
    ext_date:    get(15),
    ext_line:    get(16),
    ext_reason:  get(17),
    ext_comment: get(18),
    cpa_status:  get(19),
    last_cpa_check: fmtDate(cols[20])
  };
}

async function syncFromSheet() {
  const logId = await db.createSyncLog();
  let added = 0, updated = 0;

  try {
    console.log('[Sync] Starting sync from Google Sheet...');

    const auth   = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range:         `${SHEET_TAB}!A:U`   // A through U = 21 columns
    });

    const rows = response.data.values || [];
    if (rows.length < 2) {
      console.log('[Sync] Sheet is empty or has only headers.');
      await db.finishSyncLog(logId, { status: 'done', added: 0, updated: 0 });
      return { added: 0, updated: 0 };
    }

    const headers = rows[0].map(h => h.trim());
    console.log(`[Sync] ${rows.length - 1} data rows. Headers: ${headers.join(', ')}`);

    // Existing orders in DB
    const existingResult = await db.query('SELECT order_num, sent_date FROM orders');
    const existingMap = {};
    existingResult.rows.forEach(r => { existingMap[r.order_num] = r; });

    for (let i = 1; i < rows.length; i++) {
      const parsed = parseRow(rows[i]);
      if (!parsed) continue;

      const isNew = !existingMap[parsed.order_num];

      // Preserve existing sent_date from DB (it's static once set)
      if (!isNew && existingMap[parsed.order_num].sent_date && !parsed.sent_date) {
        parsed.sent_date = existingMap[parsed.order_num].sent_date;
      }

      // Auto-set sent_date if status is 0300 and not set
      if (!parsed.sent_date && /0300|artwork sent/i.test(parsed.status)) {
        parsed.sent_date = new Date().toISOString().split('T')[0];
      }

      await db.upsertOrderFromSheet(parsed);
      if (isNew) added++; else updated++;
    }

    await db.finishSyncLog(logId, { status: 'done', added, updated });
    console.log(`[Sync] Done. Added: ${added}, Updated: ${updated}`);
    return { added, updated };

  } catch (err) {
    console.error('[Sync] Error:', err.message);
    await db.finishSyncLog(logId, { status: 'error', added, updated, error: err.message });
    throw err;
  }
}

if (require.main === module) {
  syncFromSheet()
    .then(r => { console.log('Sync result:', r); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { syncFromSheet };
