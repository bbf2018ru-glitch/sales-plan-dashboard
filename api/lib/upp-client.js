// Общий клиент для HTTP-сервиса 1С УПП Маши.
// Дедуплицирует boilerplate, который раньше дублировался в
// customer-analytics.js, promo-analytics.js, extended-analytics.js.
//
// ВАЖНО: всё что требует BASE_URL — резолвится в момент вызова, не на require.
// Так env-переменные подхватываются даже если этот модуль импортирован раньше
// чем loadProjectEnv() отработал.

const { fetchUppPackage } = require('./upp-pull');

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
  return fetchUppPackage({ url, ...authOpts() });
}

async function callDocument(name, fromYM, toYM, limit = 999) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/document?name=${encodeURIComponent(name)}&from=${fromYM}&to=${toYM}&limit=${limit}`;
  return fetchUppPackage({ url, ...authOpts() });
}

async function callObject(kind, name) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/object?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`;
  return fetchUppPackage({ url, ...authOpts() });
}

// /pull — полный пакет за месяц; нужен ради products[] с НоменклатурнаяГруппа
// (розничная категория, которой нет в /products-detail). Тяжёлый — кэшировать.
async function callPull(period) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/pull?period=${encodeURIComponent(period)}`;
  return fetchUppPackage({ url, ...authOpts() });
}

// /stores-detail — справочник Склады (code, name, ВидСклада/формат).
async function callStoresDetail(limit = 2000) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/stores-detail?limit=${limit}`;
  return fetchUppPackage({ url, ...authOpts() });
}

// /sales-detail — строки чеков (НомерЧека/КартаКод/суммы). Потолка нет (тянет 78k+).
async function callSalesDetail(period, limit = 500000) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/sales-detail?period=${encodeURIComponent(period)}&limit=${limit}`;
  return fetchUppPackage({ url, ...authOpts() });
}

// /catalog — у Маши РАБОТАЕТ для справочника «Акции» (проверено 27.05.2026),
// несмотря на старое примечание. Лимит можно поднимать.
async function callCatalog(name, limit = 999) {
  if (!base()) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base()}/catalog?name=${encodeURIComponent(name)}&limit=${limit}`;
  return fetchUppPackage({ url, ...authOpts() });
}

// ─── Простой in-memory cache с TTL ──────────────────────────────────────
function makeCache(ttlMs = 5 * 60 * 1000) {
  const m = new Map();
  const pending = new Map();
  return {
    async wrap(key, fn) {
      const c = m.get(key);
      if (c && Date.now() - c.at < ttlMs) return { ...c.data, fromCache: true };
      // дедуплицируем одновременные запросы одного ключа (важно при фоновом прогреве)
      if (pending.has(key)) return pending.get(key);
      const promise = (async () => {
        try {
          const data = await fn();
          if (data && !data.error) m.set(key, { data, at: Date.now() });
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
    clear() { m.clear(); }
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
  makeCache
};
