const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadProjectEnv } = require('./lib/load-env');
const {
  aggregateDashboard,
  aggregateMarketing,
  buildMarketingAnalysis,
  buildProductForecast,
  buildStoreProductMatrix,
  listPeriods,
  monthKey,
  storeDetails
} = require('./lib/analytics');
const { createStore } = require('./storage');

loadProjectEnv();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.INGEST_API_KEY || '85307b26064e3764b0b19ce3223353057b0fe754b31f0f3a';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');
const SAMPLE_DB_PATH = path.join(__dirname, '..', 'data', 'sample-db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const WEB_DIR = path.join(__dirname, '..', 'web');
const DASHBOARD_PIN = process.env.DASHBOARD_PIN || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const store = createStore({
  databaseUrl: DATABASE_URL,
  dbPath: DB_PATH,
  sampleDbPath: SAMPLE_DB_PATH
});

const clients = new Set();

// ── Session management ────────────────────────────────────────────────────────
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions.entries()) {
    if (now > expiry) sessions.delete(token);
  }
}, 3600 * 1000);

function createSession() {
  const token = crypto.randomUUID();
  sessions.set(token, Date.now() + 8 * 3600 * 1000);
  return token;
}

function checkSession(req) {
  if (!DASHBOARD_PIN) return true;
  const token = req.headers['x-session-token'] || '';
  const expiry = sessions.get(token);
  return !!(expiry && Date.now() <= expiry);
}

// ── Telegram alerts ───────────────────────────────────────────────────────────
function sendTelegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const payload = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  }, (res) => { res.resume(); });
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

async function checkAndAlertStores(db, period) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const summary = aggregateDashboard(db, period);
    const lagging = summary.stores.filter(s => s.plan > 0 && s.percent < 80);
    if (!lagging.length) return;
    const lines = lagging
      .sort((a, b) => a.percent - b.percent)
      .slice(0, 10)
      .map(s => `• ${s.storeName}: <b>${s.percent}%</b>`)
      .join('\n');
    sendTelegramAlert(
      `⚠️ <b>Мария — Продажи ${period}</b>\n` +
      `${lagging.length} ${lagging.length === 1 ? 'точка ниже' : lagging.length < 5 ? 'точки ниже' : 'точек ниже'} 80% плана:\n${lines}\n\n` +
      `Требуется вмешательство!`
    );
  } catch (_) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Session-Token'
  });
  res.end(JSON.stringify(payload));
}

function sendEvent(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(data);
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) { reject(new Error('Payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function requireApiKey(req, res) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) { sendJson(res, 401, { error: 'Invalid API key' }); return false; }
  return true;
}

function requireSession(req, res) {
  if (!checkSession(req)) { sendJson(res, 401, { error: 'Session required. Enter PIN in dashboard.' }); return false; }
  return true;
}

function serveStatic(res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(WEB_DIR, safePath));
  if (!filePath.startsWith(WEB_DIR)) { notFound(res); return; }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(WEB_DIR, 'index.html'), (fallbackError, fallbackContent) => {
        if (fallbackError) { notFound(res); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallbackContent);
      });
      return;
    }
    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathname = parsedUrl.pathname || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Session-Token'
    });
    res.end();
    return;
  }

  try {

    // ── Auth ──────────────────────────────────────────────────────────────────
    if (pathname === '/api/auth' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!DASHBOARD_PIN) {
        sendJson(res, 200, { ok: true, token: null, pinRequired: false });
        return;
      }
      if (body.pin === DASHBOARD_PIN) {
        sendJson(res, 200, { ok: true, token: createSession(), pinRequired: true });
      } else {
        sendJson(res, 401, { ok: false, error: 'Неверный PIN' });
      }
      return;
    }

    // ── Health ────────────────────────────────────────────────────────────────
    if (pathname === '/api/health' && req.method === 'GET') {
      const db = await store.getDb();
      const ingestRuns = await store.listIngestRuns(1);
      sendJson(res, 200, {
        status: 'ok',
        storage: DATABASE_URL ? 'postgres' : 'json',
        periods: listPeriods(db),
        stores: db.stores.length,
        products: db.products.length,
        marketingRows: db.marketing.length,
        lastIngestRun: ingestRuns[0] || null
      });
      return;
    }

    // ── SSE ───────────────────────────────────────────────────────────────────
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write('\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // ── Dashboard summary ─────────────────────────────────────────────────────
    if (pathname === '/api/dashboard/summary' && req.method === 'GET') {
      const db = await store.getDb();
      const period = monthKey(parsedUrl.searchParams.get('period'));
      sendJson(res, 200, aggregateDashboard(db, period));
      return;
    }

    if (pathname === '/api/dashboard/store' && req.method === 'GET') {
      const db = await store.getDb();
      const period = monthKey(parsedUrl.searchParams.get('period'));
      const storeId = String(parsedUrl.searchParams.get('storeId') || '');
      if (!storeId) { sendJson(res, 400, { error: 'storeId is required' }); return; }
      sendJson(res, 200, storeDetails(db, period, storeId));
      return;
    }

    if (pathname === '/api/dashboard/matrix' && req.method === 'GET') {
      const db = await store.getDb();
      const period = monthKey(parsedUrl.searchParams.get('period'));
      sendJson(res, 200, buildStoreProductMatrix(db, period));
      return;
    }

    if (pathname === '/api/dashboard/marketing' && req.method === 'GET') {
      const db = await store.getDb();
      const period = monthKey(parsedUrl.searchParams.get('period'));
      sendJson(res, 200, aggregateMarketing(db, period));
      return;
    }

    if (pathname === '/api/dashboard/product-forecast' && req.method === 'GET') {
      const db = await store.getDb();
      const period = monthKey(parsedUrl.searchParams.get('period'));
      sendJson(res, 200, buildProductForecast(db, period));
      return;
    }

    // ── Analysis ──────────────────────────────────────────────────────────────
    if (pathname === '/api/analysis/marketing' && req.method === 'POST') {
      const body = await parseBody(req);
      const db = await store.getDb();
      const period = monthKey(body.period || parsedUrl.searchParams.get('period'));
      sendJson(res, 200, buildMarketingAnalysis(db, period));
      return;
    }

    // ── Metadata ──────────────────────────────────────────────────────────────
    if (pathname === '/api/metadata' && req.method === 'GET') {
      const db = await store.getDb();
      sendJson(res, 200, {
        periods: listPeriods(db),
        stores: db.stores,
        products: db.products,
        pinRequired: !!DASHBOARD_PIN,
        hasTelegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
      });
      return;
    }

    // ── Comments ──────────────────────────────────────────────────────────────
    if (pathname === '/api/comments' && req.method === 'GET') {
      const period = parsedUrl.searchParams.get('period') || '';
      const comments = await store.getComments(period);
      sendJson(res, 200, { comments });
      return;
    }

    if (pathname === '/api/comments' && req.method === 'POST') {
      if (!requireSession(req, res)) return;
      const body = await parseBody(req);
      if (!body.period || !body.text || !body.text.trim()) {
        sendJson(res, 400, { error: 'period and text are required' });
        return;
      }
      const comment = await store.addComment(body.period, body.text.trim(), body.author);
      sendEvent('comment_added', { period: body.period, comment });
      sendJson(res, 200, { ok: true, comment });
      return;
    }

    const commentIdMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
    if (commentIdMatch && req.method === 'DELETE') {
      if (!requireSession(req, res)) return;
      const deleted = await store.deleteComment(commentIdMatch[1]);
      sendJson(res, 200, { ok: deleted });
      return;
    }

    // ── Plan edit ─────────────────────────────────────────────────────────────
    if (pathname === '/api/plans/item' && req.method === 'PUT') {
      if (!requireSession(req, res)) return;
      const body = await parseBody(req);
      const { period, storeId, productId, amount } = body;
      if (!period || !storeId || !productId || amount === undefined) {
        sendJson(res, 400, { error: 'period, storeId, productId, amount are required' });
        return;
      }
      const item = await store.editPlanItem(monthKey(period), String(storeId), String(productId), Number(amount));
      const db = await store.getDb();
      const summary = aggregateDashboard(db, item.period);
      sendEvent('plans_updated', { period: item.period, totals: summary.totals });
      sendJson(res, 200, { ok: true, item });
      return;
    }

    // ── Ingest runs ───────────────────────────────────────────────────────────
    if (pathname === '/api/ingest/runs' && req.method === 'GET') {
      const limit = Number(parsedUrl.searchParams.get('limit') || 20);
      const runs = await store.listIngestRuns(Math.min(Math.max(limit, 1), 100));
      sendJson(res, 200, { runs });
      return;
    }

    // ── Ingest endpoints ──────────────────────────────────────────────────────
    if (pathname === '/api/ingest/plans' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      const body = await parseBody(req);
      const { period, count } = await store.replacePlans(body);
      const db = await store.getDb();
      const summary = aggregateDashboard(db, period);
      sendEvent('plans_updated', { period, totals: summary.totals });
      sendJson(res, 200, { ok: true, period, plansCount: count });
      checkAndAlertStores(db, period);
      return;
    }

    if (pathname === '/api/ingest/sales' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      const body = await parseBody(req);
      const { period, count } = await store.appendSales(body);
      const db = await store.getDb();
      const summary = aggregateDashboard(db, period);
      sendEvent('sales_updated', { period, totals: summary.totals });
      sendJson(res, 200, { ok: true, period, salesCount: count });
      checkAndAlertStores(db, period);
      return;
    }

    if (pathname === '/api/ingest/marketing' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      const body = await parseBody(req);
      const { period, count } = await store.replaceMarketing(body);
      const db = await store.getDb();
      const marketing = aggregateMarketing(db, period);
      sendEvent('marketing_updated', { period, totals: marketing.totals });
      sendJson(res, 200, { ok: true, period, metricsCount: count });
      return;
    }

    if (pathname === '/api/ingest/upp' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      const body = await parseBody(req);
      try {
        const run = await store.ingestUppPayload(body);
        const db = await store.getDb();
        const summary = aggregateDashboard(db, run.period);
        const marketing = aggregateMarketing(db, run.period);
        sendEvent('plans_updated', { period: run.period, totals: summary.totals });
        sendEvent('sales_updated', { period: run.period, totals: summary.totals });
        sendEvent('marketing_updated', { period: run.period, totals: marketing.totals });
        sendJson(res, 200, { ok: true, run });
        checkAndAlertStores(db, run.period);
      } catch (error) {
        const failedRun = await store.recordIngestFailure(body, error);
        sendJson(res, 500, { error: error.message || 'UPP import failed', run: failedRun });
      }
      return;
    }

    // ── Static ────────────────────────────────────────────────────────────────
    serveStatic(res, pathname);

  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
});

server.listen(PORT, async () => {
  await store.init();
  console.log(`Sales Plan Dashboard running at http://localhost:${PORT}`);
  console.log(`Storage: ${DATABASE_URL ? 'PostgreSQL' : 'JSON file'}`);
  console.log(`PIN protection: ${DASHBOARD_PIN ? 'enabled' : 'disabled'}`);
  console.log(`Telegram alerts: ${TELEGRAM_BOT_TOKEN ? 'enabled' : 'disabled'}`);
});
