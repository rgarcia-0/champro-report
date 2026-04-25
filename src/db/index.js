// src/db/index.js — PostgreSQL pool + query helpers

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => console.error('DB pool error:', err.message));

const query = (text, params) => pool.query(text, params);

// ── Orders ─────────────────────────────────────────────────────────────────

async function getAllOrders() {
  const result = await query(`
    SELECT
      order_num, status, id_type, type, due_date, sets, pieces,
      path, designer, qc, sent_date, sku, design,
      ext_status, ext_by, ext_date, ext_line, ext_reason, ext_comment,
      cpa_status, last_cpa_check, created_at, updated_at
    FROM orders
    ORDER BY
      CASE WHEN ext_status = 'Active' THEN 0 ELSE 1 END,
      due_date ASC NULLS LAST,
      order_num ASC
  `);
  return result.rows;
}

async function getOrderStats() {
  const result = await query(`
    SELECT
      COUNT(*)                                                                    AS total,
      COUNT(*) FILTER (WHERE status ILIKE '%0300%' OR status ILIKE '%artwork sent%') AS sent,
      COUNT(*) FILTER (WHERE status ILIKE '%0270%' OR status ILIKE '%approved%'
                         AND status NOT ILIKE '%0300%')                           AS approved,
      COUNT(*) FILTER (WHERE status ILIKE '%0250%' OR status ILIKE '%revision%')   AS revision,
      COUNT(*) FILTER (WHERE status ILIKE '%0230%' OR status ILIKE '%pending%')    AS pending,
      COUNT(*) FILTER (WHERE status ILIKE '%0200%' OR status ILIKE '%creating%')   AS creating,
      COUNT(*) FILTER (WHERE status ILIKE '%0100%' OR status ILIKE '%factory%')    AS factory,
      COUNT(*) FILTER (WHERE status ILIKE '%1800%' OR status ILIKE '%cancel%')     AS cancelled,
      COUNT(*) FILTER (WHERE ext_status = 'Active')                               AS ext_active,
      COUNT(*) FILTER (WHERE ext_status = 'Resolved')                             AS ext_resolved,
      COALESCE(SUM(sets), 0)                                                      AS total_sets,
      COALESCE(SUM(pieces), 0)                                                    AS total_pieces
    FROM orders
  `);
  return result.rows[0];
}

async function upsertOrderFromSheet(o) {
  await query(`
    INSERT INTO orders
      (order_num, status, id_type, type, due_date, sets, pieces,
       path, designer, qc, sent_date, sku, design,
       ext_status, ext_by, ext_date, ext_line, ext_reason, ext_comment,
       cpa_status, last_cpa_check)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT (order_num) DO UPDATE SET
      status      = EXCLUDED.status,
      id_type     = EXCLUDED.id_type,
      type        = EXCLUDED.type,
      due_date    = EXCLUDED.due_date,
      sets        = EXCLUDED.sets,
      pieces      = EXCLUDED.pieces,
      path        = EXCLUDED.path,
      designer    = EXCLUDED.designer,
      qc          = EXCLUDED.qc,
      sent_date   = CASE
                      WHEN orders.sent_date IS NOT NULL THEN orders.sent_date
                      ELSE EXCLUDED.sent_date
                    END,
      sku         = COALESCE(NULLIF(EXCLUDED.sku,''), orders.sku),
      design      = COALESCE(NULLIF(EXCLUDED.design,''), orders.design),
      ext_status  = EXCLUDED.ext_status,
      ext_by      = EXCLUDED.ext_by,
      ext_date    = EXCLUDED.ext_date,
      ext_line    = EXCLUDED.ext_line,
      ext_reason  = EXCLUDED.ext_reason,
      ext_comment = EXCLUDED.ext_comment,
      cpa_status  = COALESCE(NULLIF(EXCLUDED.cpa_status,''), orders.cpa_status),
      last_cpa_check = EXCLUDED.last_cpa_check,
      updated_at  = NOW()
  `, [
    o.order_num, o.status, o.id_type, o.type, o.due_date||null,
    o.sets||0, o.pieces||0, o.path||null, o.designer, o.qc||null,
    o.sent_date||null, o.sku||null, o.design||null,
    o.ext_status||'None', o.ext_by||null, o.ext_date||null,
    o.ext_line||null, o.ext_reason||null, o.ext_comment||null,
    o.cpa_status||null, o.last_cpa_check||null
  ]);
}

async function updateOrderFromCPA(orderNum, data) {
  await query(`
    UPDATE orders SET
      sku            = COALESCE(NULLIF($2,''), sku),
      design         = COALESCE(NULLIF($3,''), design),
      cpa_status     = $4,
      ext_status     = $5,
      ext_by         = $6,
      ext_date       = $7,
      ext_line       = $8,
      ext_reason     = $9,
      ext_comment    = $10,
      last_cpa_check = NOW(),
      updated_at     = NOW()
    WHERE order_num = $1
  `, [orderNum, data.sku||null, data.design||null, data.cpa_status||null,
      data.ext_status||'None', data.ext_by||null, data.ext_date||null,
      data.ext_line||null, data.ext_reason||null, data.ext_comment||null]);
}

async function getOrderByNum(orderNum) {
  const result = await query('SELECT * FROM orders WHERE order_num = $1', [orderNum]);
  return result.rows[0] || null;
}

async function getOrdersNeedingEnrich(limit = 10) {
  const result = await query(`
    SELECT order_num FROM orders
    WHERE
      (sku IS NULL OR sku = '' OR cpa_status IS NULL OR cpa_status = '')
      OR last_cpa_check IS NULL
      OR last_cpa_check < NOW() - INTERVAL '2 hours'
    ORDER BY
      CASE WHEN last_cpa_check IS NULL THEN 0 ELSE 1 END,
      last_cpa_check ASC NULLS FIRST
    LIMIT $1
  `, [limit]);
  return result.rows.map(r => r.order_num);
}

// ── Logs ────────────────────────────────────────────────────────────────────

async function createScraperLog(runType) {
  const r = await query(`INSERT INTO scraper_log (run_type, status) VALUES ($1,'running') RETURNING id`, [runType]);
  return r.rows[0].id;
}

async function finishScraperLog(id, data) {
  await query(`
    UPDATE scraper_log SET status=$2, finished_at=NOW(),
      orders_processed=$3, orders_enriched=$4, error_message=$5, details=$6
    WHERE id=$1
  `, [id, data.status, data.processed||0, data.enriched||0,
      data.error||null, JSON.stringify(data.details||{})]);
}

async function getLastScraperLog() {
  const r = await query(`SELECT * FROM scraper_log ORDER BY started_at DESC LIMIT 1`);
  return r.rows[0] || null;
}

async function createSyncLog() {
  const r = await query(`INSERT INTO sync_log (status) VALUES ('running') RETURNING id`);
  return r.rows[0].id;
}

async function finishSyncLog(id, data) {
  await query(`
    UPDATE sync_log SET status=$2, finished_at=NOW(),
      rows_added=$3, rows_updated=$4, error_message=$5
    WHERE id=$1
  `, [id, data.status, data.added||0, data.updated||0, data.error||null]);
}

async function getLastSyncLog() {
  const r = await query(`SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 1`);
  return r.rows[0] || null;
}

module.exports = {
  query, pool,
  getAllOrders, getOrderStats, getOrderByNum,
  upsertOrderFromSheet, updateOrderFromCPA, getOrdersNeedingEnrich,
  createScraperLog, finishScraperLog, getLastScraperLog,
  createSyncLog, finishSyncLog, getLastSyncLog
};
