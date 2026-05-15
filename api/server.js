const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadProjectEnv } = require('./lib/load-env');
const {
  aggregateDashboard,
  listPeriods,
  monthKey,
  scopeDbForUser,
  storeDetails
} = require('./lib/analytics');
const { buildInsights } = require('./lib/insights');
const { buildSalesAnalytics } = require('./lib/sales-analytics');
const { buildCustomerAnalytics } = require('./lib/customer-analytics');
const { buildPromoAnalytics } = require('./lib/promo-analytics');
const {
  getCustomersRetention,
  getSalesKg,
  getChequeCategories,
  getPromoDynamics,
  getProductionKg
} = require('./lib/extended-analytics');
const { startMorningReport, buildReportText } = require('./lib/morning-report');
const { createStore } = require('./storage');

loadProjectEnv();

const PORT = Number(process.env.PORT || 3000);
// INGEST_API_KEY обязателен в проде (когда задан DATABASE_URL). В dev-режиме
// (in-memory storage) допускаем фоллбэк 'dev-insecure' для локальной отладки.
const IS_PROD = !!process.env.DATABASE_URL;
const API_KEY = process.env.INGEST_API_KEY || (IS_PROD ? null : 'dev-insecure');
if (IS_PROD && !process.env.INGEST_API_KEY) {
  console.error('[FATAL] INGEST_API_KEY обязателен в проде (DATABASE_URL задан). Установите ключ через env и обновите константу ApiKey в BSL-модуле 1С.');
  process.exit(1);
}
if (!IS_PROD && !process.env.INGEST_API_KEY) {
  console.warn('[dev] INGEST_API_KEY не задан — используется фоллбэк "dev-insecure". Для прода обязательно задайте env.');
}
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');
const SAMPLE_DB_PATH = path.join(__dirname, '..', 'data', 'sample-db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const WEB_DIR = path.join(__dirname, '..', 'web');
const DASHBOARD_PIN = process.env.DASHBOARD_PIN || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const GROQ_KEY = process.env.GROQ_KEY || process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const groqConfig = GROQ_KEY ? { apiKey: GROQ_KEY, model: GROQ_MODEL } : null;

const UPP_PULL_URL = process.env.UPP_PULL_URL || '';
const UPP_PULL_USER = process.env.UPP_PULL_USER || '';
const UPP_PULL_PASSWORD = process.env.UPP_PULL_PASSWORD || '';
const UPP_PULL_INTERVAL_MIN = Number(process.env.UPP_PULL_INTERVAL_MIN || 0);
const uppPullConfig = {
  url: UPP_PULL_URL,
  username: UPP_PULL_USER,
  password: UPP_PULL_PASSWORD,
  currentPeriod: () => monthKey()
};

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

async function resolveUser(req) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const token = req.headers['x-user-token'] || url.searchParams.get('userToken') || '';
  if (!token) return null;
  try {
    return await store.getUserByToken(String(token));
  } catch (_) {
    return null;
  }
}

async function getScopedDb(req) {
  const db = await store.getDb();
  const user = await resolveUser(req);
  return { db: scopeDbForUser(db, user), user };
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
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Session-Token, X-User-Token'
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
    // КРИТИЧНО: собираем chunks как Buffer и декодируем UTF-8 один раз
    // в конце. Раньше делали raw += chunk — это вызывает chunk.toString()
    // на каждом куске. Когда chunk разрезает многобайтный UTF-8 символ
    // (например 'Ц' = 0xD0 0xA6) на границе — оба байта превращаются в
    // replacement-символы (U+FFFD '�'). На пакетах 1С 5-50 МБ это давало
    // битые storeId в БД (например '��Б0000012' вместо 'ЦБ0000012').
    // Лимит 50 МБ — пакет с диагностикой 1С (метаданные 2172 объектов +
    // sample) может быть до 20 МБ. Раньше был 1 МБ → BSL Попытка/Исключение
    // тихо глотала ошибку, диагностика не попадала на дашборд.
    const MAX = 50_000_000;
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > MAX) { reject(new Error('Payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (total === 0) { resolve({}); return; }
      const raw = Buffer.concat(chunks).toString('utf8');
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
      '.ico': 'image/x-icon',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif'
    }[ext] || 'application/octet-stream';
    // HTML не кэшируем — иначе после деплоя пользователь видит старый
    // index.html с устаревшими ?v= параметрами для css/js.
    // Статика (js/css/svg) грузится по URL с ?v=, который меняется при
    // правках — она может кэшироваться браузером свободно.
    const headers = { 'Content-Type': contentType };
    if (ext === '.html' || pathname === '/') {
      headers['Cache-Control'] = 'no-cache, must-revalidate';
    } else {
      headers['Cache-Control'] = 'public, max-age=300';
    }
    res.writeHead(200, headers);
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
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Session-Token, X-User-Token'
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
      const { db } = await getScopedDb(req);
      const period = monthKey(parsedUrl.searchParams.get('period'));
      const trendWindow = Number(parsedUrl.searchParams.get('trend_window')) || 12;
      sendJson(res, 200, aggregateDashboard(db, period, { trendWindow }));
      return;
    }

    if (pathname === '/api/dashboard/store' && req.method === 'GET') {
      const { db, user } = await getScopedDb(req);
      const period = monthKey(parsedUrl.searchParams.get('period'));
      const storeId = String(parsedUrl.searchParams.get('storeId') || '');
      if (!storeId) { sendJson(res, 400, { error: 'storeId is required' }); return; }
      if (user && user.role === 'manager' && !(user.stores || []).includes(storeId)) {
        sendJson(res, 403, { error: 'Нет доступа к этой точке' });
        return;
      }
      sendJson(res, 200, storeDetails(db, period, storeId));
      return;
    }

    // ── Утренний отчёт — ручной запуск (для проверки) ────────────────────────
    if (pathname === '/api/morning-report/preview' && req.method === 'GET') {
      const text = await buildReportText(store);
      sendJson(res, 200, { text });
      return;
    }

    if (pathname === '/api/morning-report/send' && req.method === 'POST') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 403, { error: 'Доступ только для администратора' });
        return;
      }
      if (!morningReportHandle?.sendNow) {
        sendJson(res, 400, { error: 'Утренний отчёт не активирован — выставьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID' });
        return;
      }
      const ok = await morningReportHandle.sendNow();
      sendJson(res, 200, { ok });
      return;
    }

    // ── Промо-аналитика (скидки, купоны, сертификаты) ─────────────────────
    if (pathname === '/api/analytics/promo' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      try {
        const data = await buildPromoAnalytics({ from, to });
        sendJson(res, 200, data);
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // ── Клиентская аналитика (бонусы, карты) — тянет из 1С напрямую ───────
    if (pathname === '/api/analytics/customers' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      try {
        const data = await buildCustomerAnalytics({ from, to });
        sendJson(res, 200, data);
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // ── Расширенная аналитика (бывший таб «В разработке») ──────────────────
    if (pathname === '/api/analytics/customers-retention' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      try {
        sendJson(res, 200, await getCustomersRetention({ from, to }));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    if (pathname === '/api/analytics/sales-kg' && req.method === 'GET') {
      const { db } = await getScopedDb(req);
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      try {
        sendJson(res, 200, await getSalesKg(db, { from, to }));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    if (pathname === '/api/analytics/cheque-categories' && req.method === 'GET') {
      const { db } = await getScopedDb(req);
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      sendJson(res, 200, getChequeCategories(db, { from, to }));
      return;
    }

    if (pathname === '/api/analytics/promo-dynamics' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      try {
        sendJson(res, 200, await getPromoDynamics({ from, to }));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    if (pathname === '/api/analytics/production-kg' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      try {
        sendJson(res, 200, await getProductionKg({ from, to }));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // ── Аналитика продаж — расширенные отчёты по каналам/категориям/неделям ──
    if (pathname === '/api/analytics/sales' && req.method === 'GET') {
      const { db } = await getScopedDb(req);
      const period = monthKey(parsedUrl.searchParams.get('period'));
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      sendJson(res, 200, buildSalesAnalytics(db, period, { from, to }));
      return;
    }

    // ── Insights ──────────────────────────────────────────────────────────────
    if (pathname === '/api/insights' && req.method === 'GET') {
      const { db } = await getScopedDb(req);
      const period = monthKey(parsedUrl.searchParams.get('period'));
      const summary = aggregateDashboard(db, period);
      const useLlm = parsedUrl.searchParams.get('llm') !== '0';
      const result = await buildInsights(summary, db, period, {
        groq: useLlm ? groqConfig : null,
      });
      sendJson(res, 200, result);
      return;
    }

    // ── Metadata ──────────────────────────────────────────────────────────────
    if (pathname === '/api/metadata' && req.method === 'GET') {
      const { db, user } = await getScopedDb(req);
      sendJson(res, 200, {
        periods: listPeriods(db),
        stores: db.stores,
        products: db.products,
        pinRequired: !!DASHBOARD_PIN,
        hasTelegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
        currentUser: user ? { id: user.id, name: user.name, role: user.role, stores: user.stores } : null
      });
      return;
    }

    // ── User management (admin-only) ──────────────────────────────────────────
    if (pathname === '/api/users' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 403, { error: 'Доступ только для администратора' });
        return;
      }
      sendJson(res, 200, { users: await store.listUsers() });
      return;
    }

    if (pathname === '/api/users' && req.method === 'POST') {
      // Bootstrap: если в БД нет пользователей, разрешаем создать первого admin
      // через X-API-Key (тот же ingest-ключ из BSL). После создания этот путь
      // больше не работает — дальше нужен X-User-Token админа.
      const existingUsers = await store.listUsers();
      const isBootstrap = existingUsers.length === 0
        && req.headers['x-api-key'] === API_KEY;

      if (!isBootstrap) {
        const actor = await resolveUser(req);
        if (!actor || actor.role !== 'admin') {
          sendJson(res, 403, { error: 'Доступ только для администратора' });
          return;
        }
      }

      const body = await parseBody(req);
      if (!body.id || !body.name) {
        sendJson(res, 400, { error: 'id и name обязательны' });
        return;
      }
      // При bootstrap первый пользователь всегда admin
      if (isBootstrap) body.role = 'admin';

      const saved = await store.upsertUser(body);
      sendJson(res, 200, { ok: true, user: saved, bootstrap: isBootstrap });
      return;
    }

    // ── UPP pull (admin) ──────────────────────────────────────────────────────
    if (pathname === '/api/upp/pull' && req.method === 'POST') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 403, { error: 'Доступ только для администратора' });
        return;
      }
      if (!UPP_PULL_URL) {
        sendJson(res, 400, { error: 'UPP_PULL_URL не настроен' });
        return;
      }
      const body = await parseBody(req);
      const period = monthKey(body.period || parsedUrl.searchParams.get('period'));
      try {
        const { fetchUppPackage } = require('./lib/upp-pull');
        const payload = await fetchUppPackage({ ...uppPullConfig, period });
        const run = await store.ingestUppPayload(payload);
        const db = await store.getDb();
        const summary = aggregateDashboard(db, run.period);
        sendEvent('plans_updated', { period: run.period, totals: summary.totals });
        sendEvent('sales_updated', { period: run.period, totals: summary.totals });
        sendJson(res, 200, { ok: true, run });
      } catch (error) {
        sendJson(res, 500, { error: error.message || 'UPP pull failed' });
      }
      return;
    }

    // ── Проверка связи с 1С HTTP-сервисом ─────────────────────────────────────
    if (pathname === '/api/admin/upp-health' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      if (!UPP_PULL_URL) { sendJson(res, 400, { error: 'UPP_PULL_URL не настроен в env' }); return; }
      try {
        // Подменяем path с /pull на /health для health-check
        const healthUrl = UPP_PULL_URL.replace(/\/pull(\?.*)?$/, '/health');
        const { fetchUppPackage } = require('./lib/upp-pull');
        const result = await fetchUppPackage({ ...uppPullConfig, url: healthUrl, period: '' });
        sendJson(res, 200, { ok: true, url: healthUrl, response: result });
      } catch (error) {
        sendJson(res, 500, { error: error.message || 'UPP health failed' });
      }
      return;
    }

    // ── Массовая историческая загрузка через pull ─────────────────────────────
    if (pathname === '/api/admin/upp-pull-history' && req.method === 'POST') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      if (!UPP_PULL_URL) { sendJson(res, 400, { error: 'UPP_PULL_URL не настроен' }); return; }
      const body = await parseBody(req);
      const months = Math.min(Math.max(Number(body.months || 24), 1), 36);
      const skipExisting = body.skipExisting !== false;

      try {
        const { fetchUppPackage } = require('./lib/upp-pull');
        const existingPeriods = new Set();
        if (skipExisting) {
          const db = await store.getDb();
          db.sales.forEach(s => existingPeriods.add(s.period));
        }
        const results = [];
        const now = new Date();
        for (let i = months; i >= 1; i -= 1) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          if (skipExisting && existingPeriods.has(period)) {
            results.push({ period, status: 'skipped', reason: 'already in db' });
            continue;
          }
          try {
            const payload = await fetchUppPackage({ ...uppPullConfig, period });
            const run = await store.ingestUppPayload(payload);
            results.push({ period, status: run.status, salesCount: run.stats?.sales || 0 });
          } catch (err) {
            results.push({ period, status: 'failed', error: err.message });
          }
        }
        sendJson(res, 200, {
          ok: true,
          totalMonths: months,
          successCount: results.filter(r => r.status === 'success').length,
          skippedCount: results.filter(r => r.status === 'skipped').length,
          failedCount: results.filter(r => r.status === 'failed').length,
          results
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message || 'pull-history failed' });
      }
      return;
    }

    const userIdMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userIdMatch && req.method === 'DELETE') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 403, { error: 'Доступ только для администратора' });
        return;
      }
      const ok = await store.deleteUser(userIdMatch[1]);
      sendJson(res, 200, { ok });
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

    if (pathname === '/api/ingest/upp' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      const body = await parseBody(req);
      try {
        const run = await store.ingestUppPayload(body);
        const db = await store.getDb();
        const summary = aggregateDashboard(db, run.period);
        sendEvent('plans_updated', { period: run.period, totals: summary.totals });
        sendEvent('sales_updated', { period: run.period, totals: summary.totals });
        sendJson(res, 200, { ok: true, run });
        checkAndAlertStores(db, run.period);
      } catch (error) {
        const failedRun = await store.recordIngestFailure(body, error);
        sendJson(res, 500, { error: error.message || 'UPP import failed', run: failedRun });
      }
      return;
    }

    // ── Подбор COST_CAP_RATIO (admin) — пересчёт margin с переопределённым ratio
    // без перезапуска сервиса. Используется чтобы подобрать значение,
    // которое потом ставится в env-переменную COST_CAP_RATIO постоянно.
    if (pathname === '/api/admin/test-cap' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 401, { error: 'Admin required' });
        return;
      }
      const ratio = parsedUrl.searchParams.get('ratio');
      const markupsStr = parsedUrl.searchParams.get('markups');
      const period = monthKey(parsedUrl.searchParams.get('period'));
      const db = await store.getDb();
      const opts = { costCapRatio: ratio };
      if (markupsStr) {
        try { opts.storeMarkups = JSON.parse(markupsStr); } catch (_) {}
      }
      const summary = aggregateDashboard(db, period, opts);
      sendJson(res, 200, {
        period,
        ratioUsed: Number(ratio) || 1.0,
        markupsUsed: opts.storeMarkups || null,
        totals: summary.totals,
        stores: summary.stores.map(s => ({ storeId: s.storeId, storeName: s.storeName, fact: s.fact, cost: s.cost, margin: s.margin, marginPct: s.marginPct }))
      });
      return;
    }

    // ── Снимок БД для миграции (admin) — экспорт всего в один JSON ────────
    if (pathname === '/api/admin/export-snapshot' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 401, { error: 'Admin required' });
        return;
      }
      try {
        const db = await store.getDb();
        const snapshot = {
          version: 1,
          exportedAt: new Date().toISOString(),
          stores: db.stores,
          products: db.products,
          plans: db.plans,
          sales: db.sales,
          chequeStats: db.chequeStats || [],
          comments: db.comments || [],
          users: db.users || []
        };
        sendJson(res, 200, snapshot);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // ── Импорт снимка (admin) — для миграции на новый хостинг ─────────────
    if (pathname === '/api/admin/import-snapshot' && req.method === 'POST') {
      const user = await resolveUser(req);
      const apiKey = req.headers['x-api-key'];
      if (!(user && user.role === 'admin') && !(apiKey && apiKey === API_KEY)) {
        sendJson(res, 401, { error: 'Admin token or X-API-Key required' });
        return;
      }
      try {
        const body = await parseBody(req);
        if (!body.stores || !body.sales) {
          sendJson(res, 400, { error: 'invalid snapshot (need stores+sales)' });
          return;
        }
        const counts = { stores: 0, products: 0, plans: 0, sales: 0, cheques: 0 };
        // Залить через стандартный ingestUppPayload — он сам сделает upsert
        // и распределит по периодам. Группируем sales по period.
        const byPeriod = new Map();
        for (const s of body.sales) {
          if (!byPeriod.has(s.period)) byPeriod.set(s.period, []);
          byPeriod.get(s.period).push(s);
        }
        for (const [period, sales] of byPeriod) {
          const plans = (body.plans || []).filter(p => p.period === period);
          const cheques = (body.chequeStats || []).filter(c => c.period === period);
          const payload = {
            sourceSystem: '1c-upp',
            sourceObject: 'snapshot-import',
            packageId: `snapshot-${period}-${Date.now()}`,
            period,
            stores: body.stores,
            products: body.products,
            plans,
            sales,
            cheques: cheques.map(c => ({
              storeId: c.storeId,
              chequeCount: c.chequeCount,
              withCardCount: c.withCardCount,
              factSum: c.factSum,
              discountSum: 0,
              paymentGift: c.paymentGift,
              paymentBonus: c.paymentBonus
            }))
          };
          await store.ingestUppPayload(payload);
          counts.sales += sales.length;
          counts.plans += plans.length;
          counts.cheques += cheques.length;
        }
        counts.stores = body.stores.length;
        counts.products = (body.products || []).length;
        sendJson(res, 200, { ok: true, imported: counts, periods: byPeriod.size });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // ── Ручное переименование магазина (admin) ─────────────────────────────
    if (pathname === '/api/admin/store-name' && req.method === 'POST') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 401, { error: 'Admin required' });
        return;
      }
      const body = await parseBody(req);
      if (!body.storeId || !body.name) {
        sendJson(res, 400, { error: 'storeId and name required' });
        return;
      }
      try {
        const r = store.setStoreName ? await store.setStoreName(body.storeId, body.name) : null;
        sendJson(res, 200, { ok: !!r, store: r });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // ── Refresh stores из последнего raw payload (admin) — починка битых имён ─
    if (pathname === '/api/admin/refresh-stores' && req.method === 'POST') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 401, { error: 'Admin required' });
        return;
      }
      try {
        const result = store.refreshStoresFromPayload
          ? await store.refreshStoresFromPayload()
          : { updated: 0, note: 'JSON store: not supported' };
        sendJson(res, 200, { ok: true, ...result });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // ── Wipe demo seed-data (admin) — удаляет фейковые stores из sample-db.json ──
    // Реальные магазины из 1С имеют source='retail'/'corporate'/'mixed' и не
    // пострадают. Удаляются только stores с source='' (это и есть seed-данные).
    if (pathname === '/api/admin/wipe-demo' && req.method === 'POST') {
      const user = await resolveUser(req);
      const apiKey = req.headers['x-api-key'];
      // Авторизация: либо admin-токен, либо ingest-api-key (для bootstrap, когда
      // админ-юзер ещё не создан после миграции БД).
      const isAdmin = user && user.role === 'admin';
      const isApiKey = apiKey && apiKey === API_KEY;
      if (!isAdmin && !isApiKey) {
        sendJson(res, 401, { error: 'Admin token or X-API-Key required' });
        return;
      }
      try {
        const stats = store.wipeDemoData
          ? await store.wipeDemoData()
          : { stores: 0, plans: 0, sales: 0, note: 'JSON store: skip' };
        sendJson(res, 200, { ok: true, deleted: stats });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }

    // ── Raw payload inspection (admin) — для диагностики что шлёт 1С ──────────
    if (pathname === '/api/admin/last-raw-payload' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 401, { error: 'Admin required' });
        return;
      }
      const period = parsedUrl.searchParams.get('period') || monthKey();
      try {
        let payload = null;
        if (process.env.DATABASE_URL && store.getRawPayload) {
          payload = await store.getRawPayload(period);
        } else {
          const db = await store.getDb();
          payload = (db.rawUppPayloads || []).filter(p => p.period === period)[0];
        }
        if (!payload) { sendJson(res, 404, { error: 'no payload' }); return; }
        // Возвращаем сэмпл — первые продажи и магазины, чтобы не отдавать целиком 5+ MB
        const data = typeof payload.payload_json === 'string' ? JSON.parse(payload.payload_json) : (payload.payload_json || payload);
        const summary = {
          packageId: payload.package_id || data.packageId,
          period: payload.period || data.period,
          createdAt: payload.created_at,
          rootKeys: Object.keys(data),
          storesCount: (data.stores || []).length,
          firstStore: (data.stores || [])[0],
          plansCount: (data.plans || []).length,
          firstPlan: (data.plans || [])[0],
          salesCount: (data.sales || []).length,
          firstSale: (data.sales || [])[0],
          salesWithCost: (data.sales || []).filter(s => s.cost > 0).length,
          storesWithSource: (data.stores || []).filter(s => s.source).length
        };
        sendJson(res, 200, summary);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // ── 1С Live probe — проксирует к работающим endpoint'ам HTTP-сервиса 1С ─
    // Используется для одноразового исследования структуры. Только GET.
    if (pathname === '/api/admin/probe-1c' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const path = parsedUrl.searchParams.get('path'); // напр. "object?kind=Справочник&name=Номенклатура"
      if (!path) { sendJson(res, 400, { error: 'path required (e.g. object?kind=Справочник&name=Номенклатура)' }); return; }
      if (!UPP_PULL_URL) { sendJson(res, 503, { error: 'UPP_PULL_URL не настроен' }); return; }
      try {
        const { fetchUppPackage } = require('./lib/upp-pull');
        const base = UPP_PULL_URL.replace(/\/pull(\?.*)?$/, '');
        const result = await fetchUppPackage({
          url: `${base}/${path}`,
          username: UPP_PULL_USER,
          password: UPP_PULL_PASSWORD,
          period: ''
        });
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // ── 1С Diagnostic / Explorer ──────────────────────────────────────────────
    if (pathname === '/api/ingest/upp-diagnostic' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      const body = await parseBody(req);
      console.log(`[upp-diagnostic] received: config=${body.configurationName} v=${body.configurationVersion} objects=${(body.objects || []).length}`);
      try {
        const saved = await store.saveUppDiagnostic({
          configName: body.configurationName || '',
          configVersion: body.configurationVersion || '',
          payload: body
        });
        console.log(`[upp-diagnostic] saved id=${saved.id} bytes=${saved.sizeBytes}`);
        sendJson(res, 200, { ok: true, ...saved });
      } catch (error) {
        console.error('[upp-diagnostic] save failed:', error.message);
        sendJson(res, 500, { error: error.message || 'Diagnostic save failed' });
      }
      return;
    }

    if (pathname === '/api/upp-explorer/latest' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 401, { error: 'Admin required' });
        return;
      }
      // Лёгкий путь — только meta + индекс объектов БЕЗ sample-данных
      // (раньше тянули весь payload в память Node, при больших дампах падало OOM)
      const idx = store.getLatestUppDiagnosticIndex
        ? await store.getLatestUppDiagnosticIndex()
        : await store.getLatestUppDiagnostic();
      if (!idx) {
        sendJson(res, 200, { hasData: false });
        return;
      }
      const objects = idx.objects || (idx.payload?.objects || []).map(o => ({
        kind: o.kind, name: o.name, synonym: o.synonym
      }));
      sendJson(res, 200, {
        hasData: true,
        receivedAt: idx.receivedAt,
        configName: idx.configName,
        configVersion: idx.configVersion,
        sizeBytes: idx.sizeBytes,
        objectsCount: objects.length,
        objects
      });
      return;
    }

    if (pathname === '/api/upp-explorer/object' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') {
        sendJson(res, 401, { error: 'Admin required' });
        return;
      }
      const kind = parsedUrl.searchParams.get('kind');
      const name = parsedUrl.searchParams.get('name');
      if (!kind || !name) {
        sendJson(res, 400, { error: 'kind and name required' });
        return;
      }
      // Тянем ТОЛЬКО нужный объект — не загружаем весь payload в память
      let obj = null;
      if (store.getUppDiagnosticObject) {
        obj = await store.getUppDiagnosticObject(kind, name);
      } else {
        const dump = await store.getLatestUppDiagnostic();
        obj = (dump?.payload?.objects || []).find(o => o.kind === kind && o.name === name);
      }
      if (!obj) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      sendJson(res, 200, obj);
      return;
    }

    // ── Static ────────────────────────────────────────────────────────────────
    serveStatic(res, pathname);

  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
});

let morningReportHandle = null;

server.listen(PORT, async () => {
  await store.init();
  console.log(`Sales Plan Dashboard running at http://localhost:${PORT}`);
  console.log(`Storage: ${DATABASE_URL ? 'PostgreSQL' : 'JSON file'}`);
  console.log(`PIN protection: ${DASHBOARD_PIN ? 'enabled' : 'disabled'}`);
  console.log(`Telegram alerts: ${TELEGRAM_BOT_TOKEN ? 'enabled' : 'disabled'}`);
  console.log(`Groq AI insights: ${groqConfig ? `enabled (${GROQ_MODEL})` : 'disabled (rule-based only)'}`);
  console.log(`UPP pull: ${UPP_PULL_URL ? `${UPP_PULL_URL} (${UPP_PULL_INTERVAL_MIN > 0 ? `every ${UPP_PULL_INTERVAL_MIN} min` : 'manual'})` : 'disabled'}`);

  morningReportHandle = startMorningReport({
    store,
    botToken: TELEGRAM_BOT_TOKEN,
    chatId: TELEGRAM_CHAT_ID,
  });

  if (UPP_PULL_URL && UPP_PULL_INTERVAL_MIN > 0) {
    const { startPullScheduler } = require('./lib/upp-pull');
    startPullScheduler({
      config: uppPullConfig,
      store,
      intervalMs: UPP_PULL_INTERVAL_MIN * 60 * 1000,
      onResult: (run) => {
        console.log(`[upp-pull] ${run.status}: package=${run.packageId} period=${run.period}`);
        if (run.status === 'success') {
          (async () => {
            const db = await store.getDb();
            const summary = aggregateDashboard(db, run.period);
            sendEvent('plans_updated', { period: run.period, totals: summary.totals });
            sendEvent('sales_updated', { period: run.period, totals: summary.totals });
          })().catch(() => {});
        }
      },
      onError: (error) => {
        console.error(`[upp-pull] ${error.message}`);
        store.recordIngestFailure({ sourceSystem: '1c-upp', sourceObject: 'pull' }, error).catch(() => {});
      }
    });
  }
});
