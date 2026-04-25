require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const path        = require('path');
const fs          = require('fs');
const db          = require('./db');
const scheduler   = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/api/orders', async (req, res) => {
    try {
          const [orders, stats, lastSync, lastScrape] = await Promise.all([
                  db.getAllOrders(),
                  db.getOrderStats(),
                  db.getLastSyncLog(),
                  db.getLastScraperLog()
                ]);
          res.json({
                  ok: true,
                  orders,
                  stats,
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

app.get('/api/orders/:orderNum', async (req, res) => {
    try {
          const order = await db.getOrderByNum(req.params.orderNum);
          if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
          res.json({ ok: true, order });
    } catch (err) {
          res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/sync', async (req, res) => {
    if (scheduler.isSyncRunning()) {
          return res.json({ ok: true, running: true, message: 'Sync already in progress' });
    }
    res.json({ ok: true, started: true, message: 'Sync started' });
    scheduler.triggerSyncNow().catch(e => console.error('Manual sync error:', e.message));
});

app.post('/api/scrape', async (req, res) => {
    if (scheduler.isScraperRunning()) {
          return res.json({ ok: true, running: true, message: 'Scraper already in progress' });
    }
    const limit = parseInt(req.body && req.body.limit) || 20;
    res.json({ ok: true, started: true, message: `Scraper started (limit: ${limit})` });
    scheduler.triggerScraperNow(limit).catch(e => console.error('Manual scrape error:', e.message));
});

app.get('/api/status', async (req, res) => {
    try {
          const [lastSync, lastScrape] = await Promise.all([
                  db.getLastSyncLog(),
                  db.getLastScraperLog()
                ]);
          res.json({
                  ok: true,
                  syncRunning:    scheduler.isSyncRunning(),
                  scraperRunning: scheduler.isScraperRunning(),
                  lastSync:   lastSync   ? formatLog(lastSync)   : null,
                  lastScrape: lastScrape ? formatLog(lastScrape) : null
          });
    } catch (err) {
          res.status(500).json({ ok: false, error: err.message });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

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

async function start() {
    // 1. Connect to DB
  try {
        await db.query('SELECT 1');
        console.log('✓ Database connected.');
  } catch (err) {
        console.error('✗ Database connection failed:', err.message);
        process.exit(1);
  }

  // 2. Auto-run migrations (safe: CREATE IF NOT EXISTS)
  try {
        const sql = fs.readFileSync(path.join(__dirname, 'db', 'migration.sql'), 'utf8');
        await db.query(sql);
        console.log('✓ Database tables ready.');
  } catch (err) {
        console.error('✗ Migration failed:', err.message);
        process.exit(1);
  }

  // 3. Start cron jobs
  scheduler.startAll();

  // 4. Start HTTP server
  app.listen(PORT, () => {
        console.log(`✓ Server running on http://localhost:${PORT}`);
  });

  // 5. Initial sync 5s after start
  setTimeout(() => {
        console.log('[Server] Running initial sync...');
        scheduler.triggerSyncNow().catch(e => console.error('Initial sync error:', e.message));
  }, 5000);
}

start();
