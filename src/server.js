// src/server.js
// Express API + static file server

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const path        = require('path');
const db          = require('./db');
const scheduler   = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────────────────────

// Health check (used by Render to verify service is alive)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// GET all orders + stats
app.get('/api/orders', async (req, res) => {
  try {
    const [orders, stats, lastSync, lastScrape] = await Promise.all([
      db.getAllOrders(),
      db.getOrderStats(),
      db.getLastSyncLog(),
      db.getLastScraperLog()
    ]);

    res.json({
      ok:         true,
      orders:     orders,
      stats:      stats,
      lastSync:   lastSync   ? formatLog(lastSync)   : null,
      lastScrape: lastScrape ? formatLog(lastScrape) : null,
      syncRunning:    scheduler.isSyncRunning(),
      scraperRunning: scheduler.isScraperRunning()
    });
  } catch (err) {
    console.error('/api/orders error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET single order
app.get('/api/orders/:orderNum', async (req, res) => {
  try {
    const order = await db.getOrderByNum(req.params.orderNum);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST trigger manual sync
app.post('/api/sync', async (req, res) => {
  if (scheduler.isSyncRunning()) {
    return res.json({ ok: true, running: true, message: 'Sync already in progress' });
  }
  // Start sync async — respond immediately
  res.json({ ok: true, started: true, message: 'Sync started' });
  scheduler.triggerSyncNow().catch(e => console.error('Manual sync error:', e.message));
});

// POST trigger manual scraper
app.post('/api/scrape', async (req, res) => {
  if (scheduler.isScraperRunning()) {
    return res.json({ ok: true, running: true, message: 'Scraper already in progress' });
  }
  const limit = parseInt(req.body?.limit) || 20;
  res.json({ ok: true, started: true, message: `Scraper started (limit: ${limit})` });
  scheduler.triggerScraperNow(limit).catch(e => console.error('Manual scrape error:', e.message));
});

// GET scraper/sync status
app.get('/api/status', async (req, res) => {
  try {
    const [lastSync, lastScrape] = await Promise.all([
      db.getLastSyncLog(),
      db.getLastScraperLog()
    ]);
    res.json({
      ok:             true,
      syncRunning:    scheduler.isSyncRunning(),
      scraperRunning: scheduler.isScraperRunning(),
      lastSync:       lastSync   ? formatLog(lastSync)   : null,
      lastScrape:     lastScrape ? formatLog(lastScrape) : null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Catch-all: serve the SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function formatLog(log) {
  return {
    status:      log.status,
    startedAt:   log.started_at,
    finishedAt:  log.finished_at,
    rowsAdded:   log.rows_added,
    rowsUpdated: log.rows_updated,
    processed:   log.orders_processed,
    enriched:    log.orders_enriched,
    error:       log.error_message
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
async function start() {
  try {
    // Test DB connection
    await db.query('SELECT 1');
    console.log('✓ Database connected.');
  } catch (err) {
    console.error('✗ Database connection failed:', err.message);
    console.error('  Make sure DATABASE_URL is set and the DB is running.');
    console.error('  Run: node src/db/migrate.js');
    process.exit(1);
  }

  // Start scheduled jobs
  scheduler.startAll();

  // Start HTTP server
  app.listen(PORT, () => {
    console.log(`✓ Server running on http://localhost:${PORT}`);
    console.log(`  NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  });

  // Initial sync on startup
  setTimeout(async () => {
    console.log('[Server] Running initial sync...');
    scheduler.triggerSyncNow().catch(e => console.error('Initial sync error:', e.message));
  }, 3000);
}

start();
