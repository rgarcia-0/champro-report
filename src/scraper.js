// src/scraper.js
// Puppeteer-based CPA scraper — handles login, cookies, external detection
// Much more reliable than Apps Script URL fetch:
//   - Real browser = no bandwidth quota
//   - Handles JavaScript-rendered pages
//   - Manages cookies natively like a real user

require('dotenv').config();
const puppeteer = require('puppeteer');
const cheerio   = require('cheerio');
const db        = require('./db');

const CPA_BASE      = process.env.CPA_BASE_URL || 'https://cp.champrosports.com';
const CPA_LOGIN     = `${CPA_BASE}/LogMein.aspx`;
const CPA_ORDER_URL = `${CPA_BASE}/Profile.aspx?LinesHistory=UnChecked&Source=Plines&Command=SalesOrderDetails&SO=`;
const CPA_HIST_URL  = `${CPA_BASE}/Profile.aspx?LinesHistory=Checked&Source=Plines&Command=SalesOrderDetails&SO=`;

const CPA_USER = process.env.CPA_USER;
const CPA_PASS = process.env.CPA_PASS;

const DELAY_BETWEEN_ORDERS = 3000; // ms between order fetches
const BATCH_SIZE           = 20;   // orders per scraper run

// ─────────────────────────────────────────────────────────────────────────────
// Browser management
// ─────────────────────────────────────────────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',   // Required for Render free tier
      '--disable-gpu'
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN — handles the CPA's unstable login flow natively
// ─────────────────────────────────────────────────────────────────────────────
async function login(page) {
  const MAX_ATTEMPTS = 5;
  const MAX_STEPS    = 20;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[Scraper] Login attempt ${attempt}/${MAX_ATTEMPTS}`);

    try {
      await page.goto(CPA_LOGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(1500);

      for (let step = 0; step < MAX_STEPS; step++) {
        const html   = await page.content();
        const screen = detectScreen(html);

        console.log(`[Scraper] Step ${step + 1}: screen=${screen}`);

        if (screen === 'authenticated') {
          console.log(`[Scraper] Login successful at step ${step + 1}`);
          return true;
        }

        if (screen === 'login') {
          // Fill in credentials
          await page.waitForSelector('#UserNameText', { timeout: 5000 }).catch(() => {});
          await page.evaluate(() => {
            document.getElementById('UserNameText').value = '';
            document.getElementById('Password').value     = '';
          });
          await page.type('#UserNameText', CPA_USER, { delay: 60 });
          await delay(300);
          await page.type('#Password',     CPA_PASS, { delay: 60 });
          await delay(300);

          // Click submit
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
            page.click('#ButtonLogIn').catch(() => page.evaluate(() => { document.querySelector('input[type=submit]').click(); }))
          ]);
          await delay(2000);
          continue;
        }

        if (screen === 'relogin') {
          // Click the Re-Login button or link
          const clicked = await page.evaluate(() => {
            const btn = document.querySelector('#ButtonReLogIn') ||
                        document.querySelector('a[href*="logmein"]') ||
                        document.querySelector('input[type=submit]');
            if (btn) { btn.click(); return true; }
            return false;
          });

          if (!clicked) {
            await page.goto(CPA_LOGIN, { waitUntil: 'domcontentloaded', timeout: 20000 });
          }
          await delay(2000);
          continue;
        }

        // Unknown — wait and check again
        await delay(2000);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }

      console.warn(`[Scraper] Login state machine exhausted on attempt ${attempt}`);

    } catch (err) {
      console.error(`[Scraper] Login attempt ${attempt} error: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        const wait = attempt * 5000;
        console.log(`[Scraper] Waiting ${wait / 1000}s before retry...`);
        await delay(wait);
        await page.goto(CPA_LOGIN, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      }
    }
  }

  throw new Error('CPA login failed after all attempts');
}

function detectScreen(html) {
  if (!html) return 'unknown';

  // Has password input = login form with credentials
  if (/type=["']password["']/i.test(html)) return 'login';

  // Re-Login: LogMein form but no password field
  const hasSubmit  = /type=["']submit["']/i.test(html);
  const isLogMein  = /action=["'][^"']*LogMein\.aspx/i.test(html);
  const isShort    = html.length < 12000;
  const isChamproTitle = /<title>[^<]*CHAMPRO/i.test(html);

  if (isLogMein  && hasSubmit) return 'relogin';
  if (isShort && isChamproTitle && hasSubmit) return 'relogin';
  if (/id=["']ButtonReLogIn["']/i.test(html)) return 'relogin';

  // Portal content = authenticated
  if (/Profile\.aspx\?.*Command=/i.test(html)) return 'authenticated';
  if (/plines\.aspx|MainMenu/i.test(html))     return 'authenticated';
  if (html.length > 15000 && !isLogMein)        return 'authenticated';

  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER DATA EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────
async function fetchOrderData(page, orderNum) {
  const soParam = orderNum.startsWith('SO-') ? orderNum : 'SO-' + orderNum;
  const url = CPA_ORDER_URL + encodeURIComponent(soParam);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(1200);

  const html = await page.content();

  // Check if session expired
  if (detectScreen(html) !== 'authenticated') {
    throw new Error('SESSION_EXPIRED');
  }

  const $ = cheerio.load(html);

  // ── SKU and Design from Production Lines table ──────────────────────────
  const prodLines = extractProductionLines($);
  let sku = '', design = '';
  if (prodLines.length > 0) {
    sku    = prodLines[0].sku    || '';
    design = prodLines[0].design || '';
  }
  if (!sku || !design) {
    const fb = extractSkuDesignFallback($, soParam);
    if (!sku)    sku    = fb.sku;
    if (!design) design = fb.design;
  }

  // ── Order Status ─────────────────────────────────────────────────────────
  let cpaStatus = '';
  $('select').each((_, el) => {
    const label = $(el).closest('tr').find('td').first().text().trim();
    if (/order\s*status/i.test(label)) {
      cpaStatus = $(el).find('option:selected').text().trim();
    }
  });
  if (!cpaStatus) {
    $('td').each((_, el) => {
      if (/order\s*status/i.test($(el).text())) {
        cpaStatus = $(el).next('td').text().trim();
      }
    });
  }

  // ── External detection from production lines ──────────────────────────────
  const extFromLines = findExternalInLines(prodLines);

  // ── Reprint reasons table ─────────────────────────────────────────────────
  const reprintInfo = extractReprintReasons($);

  // ── Determine final external status ──────────────────────────────────────
  const ext = determineExternalStatus(extFromLines, reprintInfo, cpaStatus);

  // ── Get history only if there's an external ───────────────────────────────
  if ((ext.status !== 'None') && (!ext.by || !ext.date)) {
    try {
      const histUrl = CPA_HIST_URL + encodeURIComponent(soParam);
      await page.goto(histUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await delay(800);

      const histHtml = await page.content();
      if (detectScreen(histHtml) === 'authenticated') {
        const $h = cheerio.load(histHtml);
        const histData = extractDisplayHistory($h);
        if (!ext.by)   ext.by   = histData.extBy;
        if (!ext.date) ext.date = histData.extDate;
      }
    } catch (he) {
      console.warn(`[Scraper] History fetch failed for ${soParam}: ${he.message}`);
    }
  }

  return {
    sku,
    design,
    cpa_status:  cpaStatus,
    ext_status:  ext.status,
    ext_by:      ext.by      || '',
    ext_date:    ext.date    || '',
    ext_line:    ext.line    || '',
    ext_reason:  ext.reason  || '',
    ext_comment: ext.comment || ''
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSERS (Cheerio-based — much cleaner than regex on raw HTML)
// ─────────────────────────────────────────────────────────────────────────────

function extractProductionLines($) {
  const lines = [];

  // Find the "Production Lines" section
  let productionTable = null;
  $('table').each((_, table) => {
    const text = $(table).text();
    if (/production\s*lines/i.test(text) && !productionTable) {
      productionTable = table;
    }
  });

  if (!productionTable) return lines;

  const headers = [];
  $(productionTable).find('tr').first().find('th, td').each((_, th) => {
    headers.push($(th).text().trim().toLowerCase());
  });

  const skuIdx    = headers.findIndex(h => h.includes('product master'));
  const designIdx = headers.findIndex(h => h.includes('design'));
  const setIdx    = headers.findIndex(h => h === 'set');
  const statusIdx = headers.findIndex(h => h === 'status' || h.includes('status'));
  const qtyIdx    = headers.findIndex(h => h === 'qty' || h === 'quantity');

  if (skuIdx === -1) return lines;

  $(productionTable).find('tr').slice(1).each((_, tr) => {
    const cells = [];
    $(tr).find('td').each((_, td) => {
      // If cell has a select, use selected option
      const sel = $(td).find('option:selected');
      cells.push(sel.length ? sel.text().trim() : $(td).text().trim());
    });

    if (cells.length < 2) return;

    const offset = (cells[0] === '+' || cells[0] === '-' || cells[0] === '') ? 1 : 0;
    const sku = (cells[skuIdx + offset] || '').replace(/^[+\-\s]+/, '').trim();
    if (!sku || sku.length < 2 || /product master/i.test(sku)) return;

    lines.push({
      sku,
      design: designIdx !== -1 ? (cells[designIdx + offset] || '').trim() : '',
      set:    setIdx    !== -1 ? (cells[setIdx    + offset] || '').trim() : '',
      status: statusIdx !== -1 ? (cells[statusIdx + offset] || '').trim() : '',
      qty:    qtyIdx    !== -1 ? (cells[qtyIdx    + offset] || '').trim() : ''
    });
  });

  return lines;
}

function extractSkuDesignFallback($, orderNum) {
  const result = { sku: '', design: '' };
  const plain  = $('body').text().replace(/\s+/g, ' ').trim();
  const stripped = orderNum.replace(/^SO-/i, '');

  const allM = plain.match(/\b([A-Z]{1,3}-[A-Z0-9]{2,8})\b/g) || [];
  for (const c of allM) {
    if (/^SO-\d+$/i.test(c)) continue;
    if (c.includes(stripped)) continue;
    result.sku = c;
    break;
  }

  const dM = plain.match(/\b([A-Z]{1,3}-\d{4})\b/g) || [];
  for (const d of dM) {
    if (/^SO-\d+$/i.test(d)) continue;
    result.design = d;
    break;
  }

  return result;
}

function findExternalInLines(prodLines) {
  const info = { hasActive0450: false, hasActive0330: false, activeLineSet: '' };
  for (const line of prodLines) {
    const s = (line.status || '').toLowerCase();
    if (s.includes('0450') || s.includes('external reprint')) {
      info.hasActive0450 = true;
      if (!info.activeLineSet) info.activeLineSet = line.set || '';
    }
    if (s.includes('0330')) {
      info.hasActive0330 = true;
      if (!info.activeLineSet) info.activeLineSet = line.set || '';
    }
  }
  return info;
}

function extractReprintReasons($) {
  const result = { reasons: [] };

  let reprintTable = null;
  $('table').each((_, table) => {
    if (/reprint\s*reason/i.test($(table).text()) && !reprintTable) {
      reprintTable = table;
    }
  });

  if (!reprintTable) return result;

  $(reprintTable).find('tr').slice(1).each((_, tr) => {
    const cells = [];
    $(tr).find('td').each((_, td) => cells.push($(td).text().trim()));

    if (cells.length >= 4) {
      const start = cells[0].toLowerCase() === 'edit' ? 1 : 0;
      result.reasons.push({
        area:    cells[start]     || '',
        reason:  cells[start + 1] || '',
        machine: cells[start + 2] || '',
        comment: cells[start + 3] || ''
      });
    }
  });

  return result;
}

function extractDisplayHistory($) {
  const result = { entries: [], extBy: '', extDate: '' };
  const text   = $('body').text();

  const entryRegex = /([A-Z][a-z]+ [A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/gi;

  let m;
  while ((m = entryRegex.exec(text)) !== null) {
    const person   = m[1].trim();
    const datetime = m[2].trim();
    const snippet  = text.substring(m.index + m[0].length, m.index + m[0].length + 400);

    result.entries.push({ person, datetime, text: snippet });

    if (/0450|external reprint request/i.test(snippet) && !result.extBy) {
      result.extBy   = person;
      result.extDate = datetime;
    }
  }

  return result;
}

function determineExternalStatus(extFromLines, reprintInfo, cpaStatus) {
  const result = { status: 'None', by: '', date: '', line: '', reason: '', comment: '' };
  const cpaLow = (cpaStatus || '').toLowerCase();

  if (extFromLines.hasActive0450 || extFromLines.hasActive0330) {
    result.status = extFromLines.hasActive0330 ? 'Active' : 'Active';
    result.line   = extFromLines.activeLineSet || '';
  } else if (cpaLow.includes('0450') || cpaLow.includes('external reprint')) {
    result.status = 'Active';
  }

  if (result.status === 'None' && reprintInfo.reasons.length > 0) {
    result.status = 'Resolved';
  }

  if (reprintInfo.reasons.length > 0) {
    const r = reprintInfo.reasons[0];
    result.reason  = [r.area, r.reason].filter(Boolean).join(': ');
    result.comment = r.comment || '';
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENRICHMENT FUNCTION
// ─────────────────────────────────────────────────────────────────────────────
async function enrichOrders({ manual = false, limit = BATCH_SIZE } = {}) {
  const logId = await db.createScraperLog(manual ? 'manual' : 'auto');
  let browser, processed = 0, enriched = 0;

  try {
    const orderNums = await db.getOrdersNeedingEnrich(limit);
    if (!orderNums.length) {
      console.log('[Scraper] No orders need enrichment right now.');
      await db.finishScraperLog(logId, { status: 'done', processed: 0, enriched: 0 });
      return { processed: 0, enriched: 0 };
    }

    console.log(`[Scraper] Starting enrichment for ${orderNums.length} orders...`);
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Set realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Login
    await login(page);
    processed++;

    for (const orderNum of orderNums) {
      try {
        await delay(DELAY_BETWEEN_ORDERS);
        console.log(`[Scraper] Fetching ${orderNum}...`);

        let data;
        try {
          data = await fetchOrderData(page, orderNum);
        } catch (e) {
          if (e.message === 'SESSION_EXPIRED') {
            console.log('[Scraper] Session expired. Re-logging in...');
            await login(page);
            data = await fetchOrderData(page, orderNum);
          } else {
            throw e;
          }
        }

        await db.updateOrderFromCPA(orderNum, data);
        enriched++;
        processed++;

        console.log(`[Scraper] ✓ ${orderNum} SKU:${data.sku || '-'} Ext:${data.ext_status}`);

      } catch (orderErr) {
        console.error(`[Scraper] ✗ ${orderNum}: ${orderErr.message}`);
        processed++;
      }
    }

    await db.finishScraperLog(logId, {
      status: 'done', processed, enriched,
      details: { total: orderNums.length, manual }
    });

    console.log(`[Scraper] Done. Enriched: ${enriched}/${orderNums.length}`);
    return { processed, enriched };

  } catch (err) {
    console.error('[Scraper] Fatal error:', err.message);
    await db.finishScraperLog(logId, {
      status: 'error', processed, enriched, error: err.message
    });
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────────
const delay = ms => new Promise(res => setTimeout(res, ms));

// Run directly: node src/scraper.js
if (require.main === module) {
  enrichOrders({ manual: true })
    .then(r => { console.log('Scraper result:', r); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { enrichOrders };
