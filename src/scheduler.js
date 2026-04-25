// src/scheduler.js
// Cron job manager — auto sync and scrape on schedule

require('dotenv').config();
const cron            = require('node-cron');
const { syncFromSheet } = require('./sync');
const { enrichOrders }  = require('./scraper');

let syncRunning   = false;
let scraperRunning = false;

// ─────────────────────────────────────────────────────────────────────────────
// Sync job (every 10 min) — reads Google Sheet → PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────
function startSyncJob() {
  const schedule = process.env.SYNC_SCHEDULE || '*/10 * * * *';
  console.log(`[Scheduler] Sync job: "${schedule}"`);

  cron.schedule(schedule, async () => {
    if (syncRunning) {
      console.log('[Scheduler] Sync already running, skipping.');
      return;
    }
    syncRunning = true;
    try {
      await syncFromSheet();
    } catch (e) {
      console.error('[Scheduler] Sync error:', e.message);
    } finally {
      syncRunning = false;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scraper job (every 2 hours) — enriches orders from CPA
// ─────────────────────────────────────────────────────────────────────────────
function startScraperJob() {
  const schedule = process.env.SCRAPER_SCHEDULE || '0 */2 * * *';
  console.log(`[Scheduler] Scraper job: "${schedule}"`);

  cron.schedule(schedule, async () => {
    if (scraperRunning) {
      console.log('[Scheduler] Scraper already running, skipping.');
      return;
    }
    scraperRunning = true;
    try {
      await enrichOrders({ manual: false });
    } catch (e) {
      console.error('[Scheduler] Scraper error:', e.message);
    } finally {
      scraperRunning = false;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual trigger (called from API)
// ─────────────────────────────────────────────────────────────────────────────
async function triggerSyncNow() {
  if (syncRunning) return { running: true, message: 'Sync already in progress' };
  syncRunning = true;
  try {
    const result = await syncFromSheet();
    return { success: true, ...result };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    syncRunning = false;
  }
}

async function triggerScraperNow(limit = 20) {
  if (scraperRunning) return { running: true, message: 'Scraper already in progress' };
  scraperRunning = true;
  try {
    const result = await enrichOrders({ manual: true, limit });
    return { success: true, ...result };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    scraperRunning = false;
  }
}

function isSyncRunning()    { return syncRunning; }
function isScraperRunning() { return scraperRunning; }

function startAll() {
  startSyncJob();
  startScraperJob();
  console.log('[Scheduler] All jobs started.');
}

module.exports = {
  startAll,
  triggerSyncNow, triggerScraperNow,
  isSyncRunning, isScraperRunning
};
