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
const { askAiChat, buildSuggestions } = require('./lib/ai-chat');
const { getMarketTrends } = require('./lib/market-trends');
const marketing = require('./lib/marketing-analytics');
const marketingChannels = require('./lib/marketing-channels');
const { buildSalesAnalytics } = require('./lib/sales-analytics');
const { buildCustomerAnalytics } = require('./lib/customer-analytics');
const { buildPromoAnalytics } = require('./lib/promo-analytics');
const {
  getCustomersRetention,
  getNewCustomersMonthly,
  warmNewCustomersMonthly,
  getPromoCodesMonthly,
  warmPromoCodesMonthly,
  getCakeOfMonthSeries,
  getSalesKg,
  getChequeCategories,
  getPromoDynamics,
  getProductionKg,
  getTopCustomersByRevenue,
  getUdsPromoCodes,
  getPromoByAction
} = require('./lib/extended-analytics');
const { startMorningReport, buildReportText } = require('./lib/morning-report');
const { startCriticalAlerts } = require('./lib/critical-alerts');
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

// ── Прогрев кэша «Маркетинг по каналам» (1С за месяц + YoY) ───────────────
// Сервер крутится 24/7 → данные обновляются сами, без ПК.
function warmMarketing() {
  marketingChannels.warm()
    .then(ok => console.log('[marketing-channels] warm', ok ? 'ok' : 'fail', new Date().toISOString()))
    .catch(e => console.log('[marketing-channels] warm error', e.message));
}
setTimeout(warmMarketing, 15000);                 // через 15с после старта
setInterval(warmMarketing, 6 * 60 * 60 * 1000);   // каждые 6 часов

// Расширенная серия (17 месяцев) — прогревается медленно (~30 мин), запускается отдельно.
// Один раз через минуту после старта, чтобы не блокировать главный warm. Затем — раз в сутки.
function warmExtended() {
  marketingChannels.warmExtendedSeries()
    .then(r => console.log('[marketing-channels] warm-ext result', JSON.stringify(r)))
    .catch(e => console.log('[marketing-channels] warm-ext error', e.message));
}
setTimeout(warmExtended, 60000);
setInterval(warmExtended, 24 * 60 * 60 * 1000);

// Помесячный «новые карты лояльности» — ~29 запросов к 1С последовательно (тоже медленный).
function warmNewCustomers() {
  warmNewCustomersMonthly()
    .then(r => console.log('[new-customers] warm result', JSON.stringify(r)))
    .catch(e => console.log('[new-customers] warm error', e.message));
}
setTimeout(warmNewCustomers, 90000);
setInterval(warmNewCustomers, 24 * 60 * 60 * 1000);

// UDS-промокоды помесячно — 17 запросов callDocument('ЧекККМ').
function warmPromoCodes() {
  warmPromoCodesMonthly()
    .then(r => console.log('[promo-monthly] warm result', JSON.stringify(r)))
    .catch(e => console.log('[promo-monthly] warm error', e.message));
}
setTimeout(warmPromoCodes, 120000);
setInterval(warmPromoCodes, 24 * 60 * 60 * 1000);

// ── AI-chat rate limit (per IP, защита Groq billing) ─────────────────────
// AI-чат открыт без auth (чтобы работал у любого зашедшего на дашборд),
// но Groq биллится за токены — нужна защита от abuse. 20 запросов/час с
// одного IP — нормальному руководителю с головой, ботнету мало.
const AI_CHAT_LIMIT = 20;
const AI_CHAT_WINDOW_MS = 60 * 60 * 1000; // 1 час
const aiChatHits = new Map(); // ip → { count, windowStart }
function checkAiChatLimit(ip) {
  const now = Date.now();
  const rec = aiChatHits.get(ip);
  if (!rec || now - rec.windowStart > AI_CHAT_WINDOW_MS) {
    aiChatHits.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }
  rec.count += 1;
  if (rec.count > AI_CHAT_LIMIT) {
    const retryAfterSec = Math.ceil((rec.windowStart + AI_CHAT_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}
setInterval(() => {
  const cutoff = Date.now() - AI_CHAT_WINDOW_MS;
  for (const [ip, rec] of aiChatHits.entries()) if (rec.windowStart < cutoff) aiChatHits.delete(ip);
}, 10 * 60 * 1000);

// ── PIN brute-force protection ────────────────────────────────────────────
// In-memory IP-based rate limit для /api/auth. 6-цифр PIN = 1М комбинаций,
// без защиты бот переберёт за пару часов. Лимиты:
//   - 5 неудачных попыток за 60 секунд → блок на 15 минут
//   - Успешный PIN сбрасывает счётчик
//   - cleanup: каждые 5 минут удаляем записи старше часа
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 60 * 1000;
const PIN_BLOCK_MS = 15 * 60 * 1000;
const pinAttempts = new Map(); // ip → { count, windowStart, blockedUntil }
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [ip, rec] of pinAttempts.entries()) {
    if ((rec.blockedUntil || 0) < Date.now() && (rec.windowStart || 0) < cutoff) {
      pinAttempts.delete(ip);
    }
  }
}, 5 * 60 * 1000);

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkPinRateLimit(ip) {
  const now = Date.now();
  const rec = pinAttempts.get(ip);
  if (rec?.blockedUntil && rec.blockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((rec.blockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

function recordPinAttempt(ip, success) {
  const now = Date.now();
  if (success) { pinAttempts.delete(ip); return; }
  const rec = pinAttempts.get(ip) || { count: 0, windowStart: now };
  // Окно истекло → сбрасываем счётчик
  if (now - rec.windowStart > PIN_WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count += 1;
  if (rec.count >= PIN_MAX_ATTEMPTS) {
    rec.blockedUntil = now + PIN_BLOCK_MS;
    console.warn(`[auth] IP ${ip} blocked for ${PIN_BLOCK_MS / 60000} min after ${rec.count} failed PIN attempts`);
  }
  pinAttempts.set(ip, rec);
}

function createSession() {
  const token = crypto.randomUUID();
  sessions.set(token, Date.now() + 8 * 3600 * 1000);
  return token;
}

// Минималистичный парсер Cookie: name1=val1; name2=val2
function parseCookies(req) {
  const out = {};
  const raw = req.headers['cookie'] || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

const SESSION_COOKIE = 'maria_session';
const USER_TOKEN_COOKIE = 'maria_user_token';

// Детектим HTTPS через X-Forwarded-Proto (nginx ставит) или прямую TLS-сессию
function isSecureRequest(req) {
  if (req.headers['x-forwarded-proto'] === 'https') return true;
  if (req.connection && req.connection.encrypted) return true;
  return false;
}

function setSessionCookie(res, token, req) {
  // 8 часов, httpOnly, SameSite=Strict — токен недоступен для JS и не утечёт через cross-site.
  // Secure добавляется автоматически если запрос пришёл через HTTPS.
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + (8 * 3600)];
  if (req && isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function setUserTokenCookie(res, userToken, req) {
  // 30 дней — для удобства, чтобы admin не вводил токен каждый день
  const parts = [`${USER_TOKEN_COOKIE}=${encodeURIComponent(userToken)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + (30 * 86400)];
  if (req && isSecureRequest(req)) parts.push('Secure');
  // append к существующим Set-Cookie
  const prev = res.getHeader('Set-Cookie');
  const next = parts.join('; ');
  if (prev) res.setHeader('Set-Cookie', Array.isArray(prev) ? [...prev, next] : [prev, next]);
  else res.setHeader('Set-Cookie', next);
}

function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    `${USER_TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  ]);
}

function checkSession(req) {
  if (!DASHBOARD_PIN) return true;
  return hasActiveSession(req);
}

// Строгая проверка PIN-сессии: возвращает true ТОЛЬКО при наличии валидного
// токена в sessions Map. В отличие от checkSession не считает «PIN не задан»
// эквивалентом «авторизован» — нужно для платных эндпоинтов (Groq), которые
// нельзя открывать в анонимный режим даже когда DASHBOARD_PIN пуст.
function hasActiveSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE] || req.headers['x-session-token'] || '';
  const expiry = sessions.get(token);
  return !!(expiry && Date.now() <= expiry);
}

async function resolveUser(req) {
  const cookies = parseCookies(req);
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  // Приоритет: cookie > заголовок > query (query — для обратной совместимости со старыми ссылками).
  const token = cookies[USER_TOKEN_COOKIE]
    || req.headers['x-user-token']
    || url.searchParams.get('userToken')
    || '';
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
      '.gif': 'image/gif',
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff'
    }[ext] || 'application/octet-stream';
    // HTML не кэшируем — иначе после деплоя пользователь видит старый
    // index.html с устаревшими ?v= параметрами для css/js.
    // Статика (js/css/svg) грузится по URL с ?v=, который меняется при
    // правках — она может кэшироваться браузером свободно.
    // sw.js — без cache: при обновлении SW нужен fresh fetch, иначе
    // зависнет старая версия.
    const headers = { 'Content-Type': contentType };
    if (ext === '.html' || pathname === '/') {
      headers['Cache-Control'] = 'no-cache, must-revalidate';
    } else if (pathname === '/sw.js') {
      headers['Cache-Control'] = 'no-cache, must-revalidate';
      headers['Service-Worker-Allowed'] = '/';
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
      const ip = getClientIp(req);
      const limit = checkPinRateLimit(ip);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec));
        sendJson(res, 429, {
          ok: false,
          error: `Слишком много попыток ввода PIN. Подождите ${Math.ceil(limit.retryAfterSec / 60)} мин.`,
          retryAfterSec: limit.retryAfterSec
        });
        return;
      }
      const body = await parseBody(req);
      if (!DASHBOARD_PIN) {
        // Если в body есть userToken — переложим его в cookie (упрощаем выход из ?userToken=… в URL)
        if (body.userToken) {
          try {
            const u = await store.getUserByToken(String(body.userToken));
            if (u) setUserTokenCookie(res, body.userToken, req);
          } catch (_) {}
        }
        sendJson(res, 200, { ok: true, token: null, pinRequired: false });
        return;
      }
      if (body.pin === DASHBOARD_PIN) {
        recordPinAttempt(ip, true);
        const sessionToken = createSession();
        setSessionCookie(res, sessionToken, req);
        if (body.userToken) {
          try {
            const u = await store.getUserByToken(String(body.userToken));
            if (u) setUserTokenCookie(res, body.userToken, req);
          } catch (_) {}
        }
        // sessionToken в теле оставляем для legacy-клиентов, но новые версии используют cookie
        sendJson(res, 200, { ok: true, token: sessionToken, pinRequired: true });
      } else {
        recordPinAttempt(ip, false);
        sendJson(res, 401, { ok: false, error: 'Неверный PIN' });
      }
      return;
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      clearAuthCookies(res);
      sendJson(res, 200, { ok: true });
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
      const summary = aggregateDashboard(db, period, { trendWindow });
      // Сравнение с прошлым месяцем — лёгкий блок без полного аггрегата
      if (parsedUrl.searchParams.get('compare') !== '0') {
        try {
          const [y, m] = period.split('-').map(Number);
          const prevDate = new Date(Date.UTC(y, m - 2, 1));
          const prevPeriod = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`;
          const prev = aggregateDashboard(db, prevPeriod, { trendWindow: 1 });
          summary.prevPeriod = {
            period: prevPeriod,
            totals: prev.totals,
            storesPercent: Object.fromEntries((prev.stores || []).map(s => [s.storeId, s.percent]))
          };
        } catch (_) {}
      }
      sendJson(res, 200, summary);
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

    // Drill-down по товару: в каких магазинах продаётся за период
    if (pathname === '/api/dashboard/product' && req.method === 'GET') {
      const { db } = await getScopedDb(req);
      const period = monthKey(parsedUrl.searchParams.get('period'));
      const productId = String(parsedUrl.searchParams.get('productId') || '');
      if (!productId) { sendJson(res, 400, { error: 'productId required' }); return; }
      const product = (db.products || []).find(p => p.id === productId);
      const storesById = new Map((db.stores || []).map(s => [s.id, s]));
      const byStore = new Map();
      for (const s of db.sales || []) {
        if (s.period !== period) continue;
        const pid = s.productId || s.product_id;
        if (pid !== productId) continue;
        const sid = s.storeId || s.store_id;
        if (!byStore.has(sid)) byStore.set(sid, { storeId: sid, storeName: storesById.get(sid)?.name || sid, fact: 0, quantity: 0 });
        const e = byStore.get(sid);
        e.fact += Number(s.amount || 0);
        e.quantity += Number(s.quantity || 0);
      }
      const items = Array.from(byStore.values()).sort((a, b) => b.fact - a.fact);
      const totalFact = items.reduce((acc, x) => acc + x.fact, 0);
      sendJson(res, 200, {
        product: product || { id: productId, name: productId, category: '' },
        period,
        totalFact: Number(totalFact.toFixed(2)),
        totalQuantity: items.reduce((acc, x) => acc + x.quantity, 0),
        items: items.map(x => ({
          ...x,
          fact: Number(x.fact.toFixed(2)),
          quantity: Number(x.quantity.toFixed(2)),
          share: totalFact > 0 ? Number(((x.fact / totalFact) * 100).toFixed(1)) : 0
        }))
      });
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

    // Помесячно: новые карты лояльности с янв пред.года по выбранный (?period=YYYY-MM).
    // Используется на вкладке Маркетинг как трендовый график.
    if (pathname === '/api/analytics/new-customers-monthly' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const period = parsedUrl.searchParams.get('period');
      try {
        sendJson(res, 200, await getNewCustomersMonthly({ period }));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // UDS-промокоды детально: код × месяц × uses × revenue. Non-blocking.
    if (pathname === '/api/analytics/promo-codes-monthly' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const period = parsedUrl.searchParams.get('period');
      try {
        sendJson(res, 200, await getPromoCodesMonthly({ period }));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // «Торт месяца» помесячно (автоопределение по всплеску продаж конкретного торта).
    // Не делает новых вызовов в 1С — читает кэш marketing-channels (aggSales).
    if (pathname === '/api/analytics/cake-of-month' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const period = parsedUrl.searchParams.get('period');
      try {
        sendJson(res, 200, await getCakeOfMonthSeries({ period }));
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

    if (pathname === '/api/analytics/promo-by-action' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      try {
        sendJson(res, 200, await getPromoByAction({ from, to }));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    if (pathname === '/api/analytics/uds-promocodes' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      try {
        sendJson(res, 200, await getUdsPromoCodes({ from, to }));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    if (pathname === '/api/analytics/top-customers' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      try {
        sendJson(res, 200, await getTopCustomersByRevenue({ from, to }));
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

    // ── AI-чат: динамические suggestions для начального экрана ──────────────
    if (pathname === '/api/ai-chat/suggestions' && req.method === 'GET') {
      try {
        const { db } = await getScopedDb(req);
        const period = monthKey(parsedUrl.searchParams.get('period'));
        sendJson(res, 200, { suggestions: buildSuggestions(db, period) });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // ── AI-чат: вопрос → ответ Groq на контексте дашборда ─────────────────────
    if (pathname === '/api/ai-chat' && req.method === 'POST') {
      // Auth-guard убран по запросу пользователя — теперь чат доступен любому
      // кто открыл дашборд (PIN-форма всё равно блокирует доступ к UI).
      // Защита от abuse Groq billing — rate-limit 20 запросов/час с одного IP.
      const ip = getClientIp(req);
      const limit = checkAiChatLimit(ip);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec));
        sendJson(res, 429, {
          error: `Лимит AI-чата на этот час исчерпан. Подождите ${Math.ceil(limit.retryAfterSec / 60)} мин.`,
          retryAfterSec: limit.retryAfterSec
        });
        return;
      }
      const { db } = await getScopedDb(req);
      const body = await parseBody(req);
      if (!groqConfig) { sendJson(res, 503, { error: 'GROQ_KEY не настроен на сервере' }); return; }
      try {
        const result = await askAiChat({
          question: body.question,
          history: body.history,
          db,
          period: body.period || monthKey(),
          apiKey: groqConfig.apiKey,
          model: groqConfig.model,
          getNotes: () => store.getComments('', {})
        });
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // ── Маркетинг по каналам: метрики за месяц + YoY (живые данные из 1С) ──
    if (pathname === '/api/marketing/channels' && req.method === 'GET') {
      // Открыт без авторизации — как /api/dashboard/summary. Read-only маркетинг-агрегаты
      // из кэша (прогрев фоном), той же чувствительности, что и уже публичный summary.
      try {
        const period = monthKey(parsedUrl.searchParams.get('period'));
        sendJson(res, 200, await marketingChannels.getChannels(period));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // ── Маркетинговая аналитика — pack 1 (zombie/cannibalization/rfm/holiday-yoy) ──
    if (pathname === '/api/marketing/zombie-products' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      try {
        const { db } = await getScopedDb(req);
        const period = monthKey(parsedUrl.searchParams.get('period'));
        const threshold = Number(parsedUrl.searchParams.get('threshold') || 0.10);
        sendJson(res, 200, await marketing.getZombieProducts(db, period, { threshold }));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }
    if (pathname === '/api/marketing/discount-cannibalization' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      try {
        const from = parsedUrl.searchParams.get('from') || monthKey();
        const to = parsedUrl.searchParams.get('to') || from;
        sendJson(res, 200, await marketing.getDiscountCannibalization(from, to));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }
    if (pathname === '/api/marketing/rfm' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      try {
        const from = parsedUrl.searchParams.get('from') || monthKey();
        const to = parsedUrl.searchParams.get('to') || from;
        sendJson(res, 200, await marketing.getRfmSimple(from, to));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }
    if (pathname === '/api/marketing/holiday-yoy' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      try {
        const { db } = await getScopedDb(req);
        const window = Number(parsedUrl.searchParams.get('window') || 60);
        sendJson(res, 200, marketing.getHolidayYoy(db, window));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }
    if (pathname === '/api/marketing/store-clusters' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      try {
        const { db } = await getScopedDb(req);
        const period = monthKey(parsedUrl.searchParams.get('period'));
        sendJson(res, 200, await marketing.getStoreClusters(db, period));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }
    if (pathname === '/api/marketing/cohort-retention' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      try {
        const monthsBack = Number(parsedUrl.searchParams.get('months') || 6);
        sendJson(res, 200, await marketing.getCohortRetention(monthsBack));
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }
    // Pending-эндпоинты (отдают { available: false, pending: true, reason })
    if (pathname === '/api/marketing/birthdays' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      sendJson(res, 200, marketing.getBirthdays());
      return;
    }
    if (pathname === '/api/marketing/geo-districts' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      sendJson(res, 200, marketing.getGeoDistricts());
      return;
    }
    if (pathname === '/api/marketing/family-segment' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      sendJson(res, 200, marketing.getFamilySegment());
      return;
    }

    // ── Market trends — тренды кондитерского рынка от Groq, кэш 24ч ──────────
    if (pathname === '/api/market-trends' && req.method === 'GET') {
      try {
        if (!groqConfig) {
          // Без Groq отдадим последний кэшированный без принудительной генерации.
          const cached = await store.getLastMarketTrends(0);
          if (!cached) { sendJson(res, 503, { error: 'GROQ_KEY не настроен и кэша нет' }); return; }
          sendJson(res, 200, { ...cached, cached: true });
          return;
        }
        const { db } = await getScopedDb(req);
        const summary = aggregateDashboard(db, monthKey());
        const result = await getMarketTrends({ store, apiKey: groqConfig.apiKey, model: groqConfig.model, summary, force: false });
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }
    if (pathname === '/api/market-trends/refresh' && req.method === 'POST') {
      // Принудительная регенерация — только аутентифицированным
      // (Groq биллится, не открываем анонимам).
      const { db, user } = await getScopedDb(req);
      if (!user && !hasActiveSession(req)) { sendJson(res, 401, { error: 'Auth required' }); return; }
      if (!groqConfig) { sendJson(res, 503, { error: 'GROQ_KEY не настроен' }); return; }
      try {
        const summary = aggregateDashboard(db, monthKey());
        const result = await getMarketTrends({ store, apiKey: groqConfig.apiKey, model: groqConfig.model, summary, force: true });
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // ── Insights ──────────────────────────────────────────────────────────────
    if (pathname === '/api/insights' && req.method === 'GET') {
      const { db, user } = await getScopedDb(req);
      const period = monthKey(parsedUrl.searchParams.get('period'));
      const summary = aggregateDashboard(db, period);
      // LLM-обёртка платная (Groq). Открываем её только авторизованным;
      // правила (rule-based finding'и) — остаются доступны как раньше.
      const requestedLlm = parsedUrl.searchParams.get('llm') !== '0';
      const allowLlm = requestedLlm && (user || hasActiveSession(req));
      const result = await buildInsights(summary, db, period, {
        groq: allowLlm ? groqConfig : null,
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
      const storeId = parsedUrl.searchParams.get('storeId') || null;
      const eventDate = parsedUrl.searchParams.get('eventDate') || null;
      const comments = await store.getComments(period, { storeId, eventDate });
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
      // Валидация event_date — формат YYYY-MM-DD
      let eventDate = null;
      if (body.eventDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.eventDate)) {
          sendJson(res, 400, { error: 'eventDate должен быть YYYY-MM-DD' }); return;
        }
        eventDate = body.eventDate;
      }
      const comment = await store.addComment(body.period, body.text.trim(), body.author, {
        storeId: body.storeId || null,
        eventDate
      });
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

    // Управление UPP pull scheduler (без рестарта Node)
    //   GET  /api/admin/pull-scheduler            — статус
    //   POST /api/admin/pull-scheduler {intervalMin: 15} — старт/смена интервала
    //   POST /api/admin/pull-scheduler {intervalMin: 0}  — стоп
    if (pathname === '/api/admin/pull-scheduler' && req.method === 'GET') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      sendJson(res, 200, {
        running: !!pullSchedulerStop,
        intervalMin: pullSchedulerIntervalMin,
        envIntervalMin: UPP_PULL_INTERVAL_MIN,
        uppUrl: UPP_PULL_URL ? '(set)' : '(empty)'
      });
      return;
    }
    if (pathname === '/api/admin/pull-scheduler' && req.method === 'POST') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      const body = await parseBody(req);
      const intervalMin = Number(body.intervalMin || 0);
      const ok = startPullSchedulerWithInterval(intervalMin);
      sendJson(res, 200, { ok, running: !!pullSchedulerStop, intervalMin: pullSchedulerIntervalMin });
      return;
    }

    // Ручной запуск critical-alerts (для тестирования или принудительного дёргания)
    if (pathname === '/api/admin/alerts/run' && req.method === 'POST') {
      const user = await resolveUser(req);
      if (!user || user.role !== 'admin') { sendJson(res, 401, { error: 'Admin required' }); return; }
      if (!criticalAlertsHandle?.runNow) { sendJson(res, 503, { error: 'Critical alerts not initialized' }); return; }
      try {
        await criticalAlertsHandle.runNow();
        sendJson(res, 200, { ok: true, state: criticalAlertsHandle.state });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
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

    // M2M-прокси для maria-crew (Hostinger вне whitelist 1С).
    // Auth — X-API-Key (INGEST_API_KEY), путь жёстко зафиксирован чтобы прокси
    // не стал universal-reflector.
    if (pathname === '/api/upp/proxy/products-detail' && req.method === 'GET') {
      if (!requireApiKey(req, res)) return;
      if (!UPP_PULL_URL) { sendJson(res, 503, { error: 'UPP_PULL_URL не настроен' }); return; }
      try {
        const { fetchUppPackage } = require('./lib/upp-pull');
        const base = UPP_PULL_URL.replace(/\/pull(\?.*)?$/, '');
        const limit = String(parsedUrl.searchParams.get('limit') || '20000');
        const result = await fetchUppPackage({
          url: `${base}/products-detail?limit=${encodeURIComponent(limit)}`,
          username: UPP_PULL_USER,
          password: UPP_PULL_PASSWORD,
          period: ''
        });
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 502, { error: e.message || 'upstream 1C error' });
      }
      return;
    }

    // M2M-прокси POST для loyalty-gift maria-crew (Hostinger вне whitelist 1С).
    // Auth — X-API-Key. Тело и статус ответа 1С передаются как есть, чтобы
    // клиент мог различать 200/4xx/5xx и парсить ответ независимо.
    if (pathname === '/api/upp/proxy/loyalty-gift' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      if (!UPP_PULL_URL) { sendJson(res, 503, { error: 'UPP_PULL_URL не настроен' }); return; }
      try {
        const body = await parseBody(req);
        const base = UPP_PULL_URL.replace(/\/pull(\?.*)?$/, '');
        const target = new (require('node:url').URL)(`${base}/loyalty-gift`);
        const auth = Buffer.from(`${UPP_PULL_USER}:${UPP_PULL_PASSWORD || ''}`).toString('base64');
        const bodyStr = JSON.stringify(body);
        const http = require('node:http');
        const upstream = await new Promise((resolve, reject) => {
          const r = http.request({
            hostname: target.hostname,
            port: target.port || 80,
            path: target.pathname + (target.search || ''),
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr),
              'Authorization': `Basic ${auth}`,
              'Accept': 'application/json'
            }
          }, (resp) => {
            let raw = '';
            resp.on('data', c => raw += c);
            resp.on('end', () => resolve({
              status: resp.statusCode || 502,
              body: raw,
              contentType: resp.headers['content-type'] || 'application/json; charset=utf-8'
            }));
          });
          r.on('error', reject);
          r.setTimeout(30000, () => r.destroy(new Error('1С POST timeout')));
          r.write(bodyStr);
          r.end();
        });
        res.writeHead(upstream.status, { 'Content-Type': upstream.contentType });
        res.end(upstream.body);
      } catch (e) {
        sendJson(res, 502, { error: e.message || 'upstream POST error' });
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
let criticalAlertsHandle = null;
let pullSchedulerStop = null;
let pullSchedulerIntervalMin = 0;

function startPullSchedulerWithInterval(intervalMin) {
  const { startPullScheduler } = require('./lib/upp-pull');
  if (pullSchedulerStop) { try { pullSchedulerStop(); } catch (_) {} pullSchedulerStop = null; }
  if (!UPP_PULL_URL || !intervalMin || intervalMin <= 0) {
    pullSchedulerIntervalMin = 0;
    return false;
  }
  pullSchedulerStop = startPullScheduler({
    config: uppPullConfig,
    store,
    intervalMs: intervalMin * 60 * 1000,
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
  pullSchedulerIntervalMin = intervalMin;
  console.log(`[upp-pull] scheduler started: every ${intervalMin} min`);
  return true;
}

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

  criticalAlertsHandle = startCriticalAlerts({
    store,
    botToken: TELEGRAM_BOT_TOKEN,
    chatId: TELEGRAM_CHAT_ID
  });

  if (UPP_PULL_URL && UPP_PULL_INTERVAL_MIN > 0) {
    startPullSchedulerWithInterval(UPP_PULL_INTERVAL_MIN);
  }

  // Cron на market-trends: ежедневно в 9:00 Иркутск (UTC+8) тригерим refresh,
  // если кэш старше 18 часов. К моменту захода руководителя утром тренды
  // уже свежие, не приходится ждать ~30 сек на Groq при первом GET.
  if (groqConfig) {
    let lastTrendsRun = 0;
    setInterval(async () => {
      const irkHour = (new Date().getUTCHours() + 8) % 24;
      if (irkHour !== 9) return;
      if (Date.now() - lastTrendsRun < 18 * 3600 * 1000) return;
      try {
        const db = await store.getDb();
        const summary = aggregateDashboard(db, monthKey());
        await getMarketTrends({ store, apiKey: groqConfig.apiKey, model: groqConfig.model, summary, force: true });
        lastTrendsRun = Date.now();
        console.log('[market-trends] daily cron: refreshed at 09:00 Irkutsk');
      } catch (e) {
        console.warn('[market-trends] daily cron failed:', e.message);
      }
    }, 60 * 1000);
    console.log('[market-trends] daily refresh scheduled for 09:00 Irkutsk');
  }
});
