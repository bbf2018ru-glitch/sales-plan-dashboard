// Общий клиент для HTTP-сервиса 1С УПП Маши.
// Дедуплицирует boilerplate, который раньше дублировался в
// customer-analytics.js, promo-analytics.js, extended-analytics.js.
//
// ВАЖНО: всё что требует BASE_URL — резолвится в момент вызова, не на require.
// Так env-переменные подхватываются даже если этот модуль импортирован раньше
// чем loadProjectEnv() отработал.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { fetchUppPackage } = require('./upp-pull');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'cache');

// ── Ограничитель одновременных подключений к 1С ──────────────────────────────
// warm-функции маркетинга дёргают compute() с Promise.all (~8-15 запросов разом).
// На рестарте (особенно при частых автодеплоях) этот всплеск тапает прод-1С Маши
// до ECONNREFUSED/EHOSTUNREACH. Кап сглаживает всплеск: не более N подключений
// зараз, остальные ждут очереди. Авто-pull (upp-pull напрямую из планировщика)
// идёт МИМО лимита — его 1 лёгкое соединение в минуту не должно ждать warm.
const MAX_1C = Number(process.env.UPP_MAX_CONCURRENCY) || 3;
let active1c = 0;
const wait1c = [];
function acquire1c() {
  return new Promise((resolve) => {
    if (active1c < MAX_1C) { active1c++; resolve(); }
    else wait1c.push(resolve);
  });
}
function release1c() {
  const next = wait1c.shift();
  if (next) next();        // слот передаётся ждущему, active1c не меняется
  else active1c--;
}
async function withLimit(fn) {
  await acquire1c();
  try { return await fn(); } finally { release1c(); }
}

function base() {
  return (process.env.UPP_PULL_URL || '').replace(/\/pull(\?.*)?$/, '');
}

function authOpts() {
  return {
    username: process.env.UPP_PULL_USER,
    password: process.env.UPP_PULL_PASSWORD,
    period: ''
  };
}

// ─── Парсеры (1С отдаёт числа/даты в русском формате) ────────────────────
function parseRu(num) {
  return parseFloat(String(num || '0').replace(/\s+/g, '').replace(',', '.')) || 0;
}

function parseRuDate(s) {
  // 1C формат: "01.05.2026 6:05:21"
  if (!s) return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/.exec(String(s));
  if (!m) return null;
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
}

// ─── Period helpers ──────────────────────────────────────────────────────
function nowYM() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function rangeMonths(fromYM, toYM) {
  const [yF, mF] = fromYM.split('-').map(Number);
  const [yT, mT] = toYM.split('-').map(Number);
  const out = [];
  let y = yF, m = mF;
  while (y < yT || (y === yT && m <= mT)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// ─── HTTP endpoints 1С HTTP-сервиса ──────────────────────────────────────
// ВАЖНО: лимит 999 — обход бага BSL с разделителем тысяч в Формат(N,"ЧГ=").
// После обновления BSL Маши лимит можно поднять.
async function callRegister(name, fromYM, toYM, limit = 999) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/register?name=${encodeURIComponent(name)}&from=${fromYM}&to=${toYM}&limit=${limit}`;
  return withLimit(() => fetchUppPackage({ url, ...authOpts() }));
}

async function callDocument(name, fromYM, toYM, limit = 999) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/document?name=${encodeURIComponent(name)}&from=${fromYM}&to=${toYM}&limit=${limit}`;
  return withLimit(() => fetchUppPackage({ url, ...authOpts() }));
}

async function callObject(kind, name) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/object?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`;
  return withLimit(() => fetchUppPackage({ url, ...authOpts() }));
}

// /pull — полный пакет за месяц; нужен ради products[] с НоменклатурнаяГруппа
// (розничная категория, которой нет в /products-detail). Тяжёлый — кэшировать.
async function callPull(period) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/pull?period=${encodeURIComponent(period)}`;
  return withLimit(() => fetchUppPackage({ url, ...authOpts() }));
}

// /stores-detail — справочник Склады (code, name, ВидСклада/формат).
async function callStoresDetail(limit = 2000) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/stores-detail?limit=${limit}`;
  return withLimit(() => fetchUppPackage({ url, ...authOpts() }));
}

// /sales-detail — строки чеков (НомерЧека/КартаКод/суммы). Потолка нет (тянет 78k+).
async function callSalesDetail(period, limit = 500000) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/sales-detail?period=${encodeURIComponent(period)}&limit=${limit}`;
  return withLimit(() => fetchUppPackage({ url, ...authOpts() }));
}

// /catalog — у Маши РАБОТАЕТ для справочника «Акции» (проверено 27.05.2026),
// несмотря на старое примечание. Лимит можно поднимать.
async function callCatalog(name, limit = 999) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/catalog?name=${encodeURIComponent(name)}&limit=${limit}`;
  return withLimit(() => fetchUppPackage({ url, ...authOpts() }));
}

// /query_post — УНИВЕРСАЛЬНЫЙ read-only исполнитель запросов 1С (ВЫБРАТЬ).
// POST: текст запроса в теле (GET /query_get режет IIS 404.15 на длине). Возвращает
// {rowsCount, columns, rows} (значения — строки). Тяжёлые запросы по ЧекККМ — до ~10с,
// поэтому увеличенный таймаут. Только ВЫБРАТЬ, роль «Только чтение» на стороне 1С.
function callQuery(queryText, { timeoutMs = 100000 } = {}) {
  const b = base();
  if (!b) throw new Error('UPP_PULL_URL не настроен');
  const target = new URL(b + '/query_post');
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const body = Buffer.from(String(queryText), 'utf8');
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length
  };
  const { username, password } = authOpts();
  if (username) headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64');
  return withLimit(() => new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: target.protocol, hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname, method: 'POST', headers
    }, (res) => {
      // Buffer.concat + decode один раз — иначе кириллица на границе чанка бьётся в `�`.
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) { reject(new Error(`UPP /query HTTP ${res.statusCode}: ${raw.slice(0, 300)}`)); return; }
        try { resolve(JSON.parse(raw)); }
        catch (_) { reject(new Error(`UPP /query вернул не-JSON: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('UPP /query timeout')));
    req.write(body); req.end();
  }));
}

// ─── Простой in-memory cache с TTL ──────────────────────────────────────
// С опциональным name — персистентность в data/cache/<name>.json: кэш переживает
// рестарты Node (каждый деплой!), иначе тяжёлые расчёты (SMS-атрибуция ~90с на
// холодную) заново считаются после каждого push. Сохранение — дебаунс 3с,
// загрузка — один раз при создании, просроченные записи отбрасываются.
function makeCache(ttlMs = 5 * 60 * 1000, name = null) {
  const m = new Map();
  const pending = new Map();
  const file = name ? path.join(CACHE_DIR, name.replace(/[^a-z0-9_-]/gi, '_') + '.json') : null;

  if (file) {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      const now = Date.now();
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v.at === 'number' && now - v.at < ttlMs) m.set(k, v);
      }
    } catch (_) { /* нет файла / битый JSON — стартуем пустыми */ }
  }

  let saveTimer = null;
  function scheduleSave() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)));
        fs.renameSync(tmp, file); // атомарно — деплой-рестарт не оставит полузаписанный файл
      } catch (_) { /* диск переполнен/нет прав — кэш остаётся in-memory */ }
    }, 3000);
    if (saveTimer.unref) saveTimer.unref();
  }

  return {
    async wrap(key, fn) {
      const c = m.get(key);
      if (c && Date.now() - c.at < ttlMs) return { ...c.data, fromCache: true };
      // дедуплицируем одновременные запросы одного ключа (важно при фоновом прогреве)
      if (pending.has(key)) return pending.get(key);
      const promise = (async () => {
        try {
          const data = await fn();
          if (data && !data.error) { m.set(key, { data, at: Date.now() }); scheduleSave(); }
          return data;
        } finally { pending.delete(key); }
      })();
      pending.set(key, promise);
      return promise;
    },
    // Синхронный доступ к кэшу — null если нет или TTL вышел.
    // Используется для non-blocking compute (см. monthlySeries в marketing-channels.js).
    getCached(key) {
      const c = m.get(key);
      return c && Date.now() - c.at < ttlMs ? c.data : null;
    },
    isPending(key) { return pending.has(key); },
    clear() {
      m.clear();
      if (file) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  };
}

function hasBase() { return !!base(); }

module.exports = {
  base,
  hasBase,
  parseRu,
  parseRuDate,
  nowYM,
  prevMonth,
  rangeMonths,
  callRegister,
  callDocument,
  callObject,
  callCatalog,
  callSalesDetail,
  callStoresDetail,
  callPull,
  callQuery,
  makeCache
};
