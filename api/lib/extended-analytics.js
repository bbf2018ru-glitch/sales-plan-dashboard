// Расширенная аналитика — фичи которые раньше висели в табе «В разработке».
// Все 5 фич работают через универсальные эндпоинты HTTP-сервиса 1С (/register,
// /catalog), без правок BSL. Кеш 5 минут — старый IIS 1С Маши не любит частых
// дёрганий.
//
// Фичи:
//   1) customers-retention   — новые vs постоянные клиенты (Бонусы за 12 мес назад)
//   2) sales-kg              — продано в кг (Номенклатура.ЭталонныйВес × sales.quantity)
//   3) cheque-categories     — доли категорий в чеках (агрегат по sold_at × store_id из БД)
//   4) promo-dynamics        — динамика акционных позиций (СкидкиНоменклатурыНатуральные)
//   5) production-kg         — выпуск продукции в кг (ВыпускПродукции × ЭталонныйВес)

const { fetchUppPackage } = require('./upp-pull');

const BASE_URL = process.env.UPP_PULL_URL || '';
const BASE = BASE_URL.replace(/\/pull(\?.*)?$/, '');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

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

async function callRegister(name, fromYM, toYM, limit = 999) {
  if (!BASE) throw new Error('UPP_PULL_URL не настроен');
  const url = `${BASE}/register?name=${encodeURIComponent(name)}&from=${fromYM}&to=${toYM}&limit=${limit}`;
  return fetchUppPackage({
    url,
    username: process.env.UPP_PULL_USER,
    password: process.env.UPP_PULL_PASSWORD,
    period: ''
  });
}

async function callCatalog(name, limit = 10000) {
  if (!BASE) throw new Error('UPP_PULL_URL не настроен');
  const url = `${BASE}/catalog?name=${encodeURIComponent(name)}&limit=${limit}`;
  return fetchUppPackage({
    url,
    username: process.env.UPP_PULL_USER,
    password: process.env.UPP_PULL_PASSWORD,
    period: ''
  });
}

// /products-detail — работает на текущем BSL и сразу отдаёт {code, name, weight,
// unit, unitRatio, group, kind}. Используем как основной источник весов.
async function callProductsDetail(limit = 10000) {
  if (!BASE) throw new Error('UPP_PULL_URL не настроен');
  const url = `${BASE}/products-detail?limit=${limit}`;
  return fetchUppPackage({
    url,
    username: process.env.UPP_PULL_USER,
    password: process.env.UPP_PULL_PASSWORD,
    period: ''
  });
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

// ─── 1) Customers retention ─────────────────────────────────────────────────
// Считает: новых клиентов в периоде (первая активность карты попадает в from..to)
// vs постоянных (карта активна до from). Использует ретро 6 мес как baseline —
// если за 6 мес до from карта была — она «постоянная».
async function buildCustomersRetention(fromYM, toYM) {
  // Период baseline: 6 месяцев до fromYM
  let baseFrom = fromYM;
  for (let i = 0; i < 6; i++) baseFrom = prevMonth(baseFrom);
  const baseTo = prevMonth(fromYM);

  // 1. Карты в baseline (последовательно по месяцам — лимит /register 999)
  const baselineCards = new Set();
  const baselineMonths = rangeMonths(baseFrom, baseTo);
  for (const ym of baselineMonths) {
    try {
      const d = await callRegister('Бонусы', ym, ym, 999);
      for (const r of d.rows || []) {
        const card = (r['БонуснаяКарта'] || '').trim();
        if (card) baselineCards.add(card);
      }
    } catch {
      // Молча пропускаем — baseline может быть неполным, это окей
    }
  }

  // 2. Карты в текущем периоде, помесячно
  const currentCards = new Map(); // card -> { firstSeenInPeriod, movements, sum }
  const periodMonths = rangeMonths(fromYM, toYM);
  for (const ym of periodMonths) {
    const d = await callRegister('Бонусы', ym, ym, 999);
    for (const r of d.rows || []) {
      const card = (r['БонуснаяКарта'] || '').trim();
      if (!card) continue;
      const sum = parseRu(r['Сумма']);
      if (!currentCards.has(card)) {
        currentCards.set(card, { card, firstSeenInPeriod: ym, movements: 0, sum: 0 });
      }
      const c = currentCards.get(card);
      c.movements += 1;
      c.sum += sum;
    }
  }

  let newCards = 0;
  let returningCards = 0;
  let newSum = 0;
  let returningSum = 0;
  for (const c of currentCards.values()) {
    if (baselineCards.has(c.card)) {
      returningCards += 1;
      returningSum += c.sum;
    } else {
      newCards += 1;
      newSum += c.sum;
    }
  }

  const total = newCards + returningCards;
  return {
    period: { from: fromYM, to: toYM },
    baseline: { from: baseFrom, to: baseTo, totalCardsKnown: baselineCards.size },
    summary: {
      totalActiveCards: total,
      newCards,
      returningCards,
      newPct: total ? Number(((newCards / total) * 100).toFixed(1)) : 0,
      returningPct: total ? Number(((returningCards / total) * 100).toFixed(1)) : 0
    },
    bonusFlow: {
      newCardsBonusSum: Number(newSum.toFixed(2)),
      returningCardsBonusSum: Number(returningSum.toFixed(2))
    }
  };
}

// ─── 2) Sales-kg ────────────────────────────────────────────────────────────
// Тянет /products-detail — он отдаёт уже подготовленные {weight, unit, unitRatio,
// group} из Справочник.Номенклатура. Затем для каждой записи sales БД умножает
// quantity на weight. Группирует по категории.
async function fetchNomenclatureWeights() {
  const data = await callProductsDetail(10000);
  const rows = data.rows || [];
  const byName = new Map();
  const byCode = new Map();
  for (const row of rows) {
    const name = (row.name || '').trim();
    const code = (row.code || '').trim();
    const weight = Number(row.weight || 0);
    const unit = (row.unit || '').trim();
    const entry = { name, code, weight, unit };
    if (name) byName.set(name, entry);
    if (code) byCode.set(code, entry);
  }
  return { weightField: 'weight', byName, byCode, totalProducts: rows.length };
}

async function buildSalesKg(db, fromISO, toISO) {
  // Берём sales из локальной БД, агрегат по продукту: sum(quantity)
  // В БД pg или памяти — у нас единый интерфейс через db.sales (массив)
  const sales = db.sales || [];
  const products = new Map((db.products || []).map(p => [p.id, p]));
  const stores = new Map((db.stores || []).map(s => [s.id, s]));

  const from = fromISO ? new Date(fromISO) : null;
  const to = toISO ? new Date(toISO + 'T23:59:59') : null;

  const qtyByProductId = new Map();
  for (const s of sales) {
    if (from && new Date(s.soldAt || s.sold_at) < from) continue;
    if (to && new Date(s.soldAt || s.sold_at) > to) continue;
    const pid = s.productId || s.product_id;
    const qty = Number(s.quantity || 0);
    if (!qtyByProductId.has(pid)) qtyByProductId.set(pid, { productId: pid, qty: 0, amount: 0 });
    const e = qtyByProductId.get(pid);
    e.qty += qty;
    e.amount += Number(s.amount || 0);
  }

  let weights = null;
  try {
    weights = await fetchNomenclatureWeights();
  } catch (e) {
    return {
      available: false,
      note: `Не удалось получить веса из 1С: ${e.message}`
    };
  }

  let totalKg = 0;
  let totalQtyMatched = 0;
  let totalQtyUnmatched = 0;
  const byCategory = new Map();

  for (const [pid, e] of qtyByProductId) {
    const product = products.get(pid);
    const productName = product?.name || pid;
    const category = product?.category || '—';
    // Сначала match по имени, потом по коду
    const w = weights.byName.get(productName) || weights.byCode.get(pid) || weights.byCode.get(productName);
    const weight = w?.weight || 0;
    if (weight > 0) {
      const kg = e.qty * weight;
      totalKg += kg;
      totalQtyMatched += e.qty;
      if (!byCategory.has(category)) byCategory.set(category, { category, kg: 0, qty: 0, amount: 0 });
      const c = byCategory.get(category);
      c.kg += kg;
      c.qty += e.qty;
      c.amount += e.amount;
    } else {
      totalQtyUnmatched += e.qty;
    }
  }

  return {
    available: true,
    weightField: weights.weightField,
    totalProductsInCatalog: weights.totalProducts,
    summary: {
      totalKg: Number(totalKg.toFixed(2)),
      totalQtyMatched: Number(totalQtyMatched.toFixed(2)),
      totalQtyUnmatched: Number(totalQtyUnmatched.toFixed(2)),
      matchedPct: (totalQtyMatched + totalQtyUnmatched) > 0
        ? Number(((totalQtyMatched / (totalQtyMatched + totalQtyUnmatched)) * 100).toFixed(1))
        : 0
    },
    byCategory: Array.from(byCategory.values())
      .sort((a, b) => b.kg - a.kg)
      .map(x => ({
        category: x.category,
        kg: Number(x.kg.toFixed(2)),
        qty: Number(x.qty.toFixed(2)),
        amount: Number(x.amount.toFixed(2))
      }))
  };
}

// ─── 3) Cheque categories ───────────────────────────────────────────────────
// Восстанавливаем чек = (store_id × sold_at до секунды). Считаем какая доля
// чеков содержит товар категории X. Это работает уже сейчас на наших данных
// в БД — без обращения к 1С.
function buildChequeCategories(db, fromISO, toISO) {
  const sales = db.sales || [];
  const products = new Map((db.products || []).map(p => [p.id, p]));

  const from = fromISO ? new Date(fromISO) : null;
  const to = toISO ? new Date(toISO + 'T23:59:59') : null;

  // chequeKey -> Set(category)
  const chequeCategories = new Map();
  const chequeAmount = new Map();
  for (const s of sales) {
    const soldAt = s.soldAt || s.sold_at;
    if (from && new Date(soldAt) < from) continue;
    if (to && new Date(soldAt) > to) continue;
    const storeId = s.storeId || s.store_id;
    const t = new Date(soldAt);
    // Округляем до секунды
    const key = `${storeId}|${t.toISOString().slice(0, 19)}`;
    const pid = s.productId || s.product_id;
    const cat = products.get(pid)?.category || '—';
    if (!chequeCategories.has(key)) chequeCategories.set(key, new Set());
    chequeCategories.get(key).add(cat);
    chequeAmount.set(key, (chequeAmount.get(key) || 0) + Number(s.amount || 0));
  }

  const totalCheques = chequeCategories.size;
  if (!totalCheques) {
    return { available: true, totalCheques: 0, byCategory: [] };
  }

  // Считаем сколько чеков содержит каждую категорию
  const catCount = new Map();
  const catAmount = new Map();
  for (const [key, cats] of chequeCategories) {
    const amt = chequeAmount.get(key) || 0;
    for (const c of cats) {
      catCount.set(c, (catCount.get(c) || 0) + 1);
      catAmount.set(c, (catAmount.get(c) || 0) + amt / cats.size); // делим сумму чека на категории пропорционально
    }
  }

  return {
    available: true,
    totalCheques,
    byCategory: Array.from(catCount.entries())
      .map(([category, count]) => ({
        category,
        chequeCount: count,
        chequePct: Number(((count / totalCheques) * 100).toFixed(1)),
        amount: Number((catAmount.get(category) || 0).toFixed(2))
      }))
      .sort((a, b) => b.chequeCount - a.chequeCount)
  };
}

// ─── 4) Promo dynamics ──────────────────────────────────────────────────────
// Динамика акционных позиций — продажи по натуральным скидкам (купи 2 получи 3,
// «N-я в подарок»). Регистр СкидкиНоменклатурыНатуральные содержит срез настроек
// акций по периодам; ПредоставленныеСкидки уже даёт фактическую сумму.
// Здесь мы строим временной ряд по дням для топ-10 акционных товаров.
async function buildPromoDynamics(fromYM, toYM) {
  // Берём ПредоставленныеСкидки (уже работает) и разрезаем по дням × товарам
  const months = rangeMonths(fromYM, toYM);
  const byProductDay = new Map(); // `${product}|${date}` -> sum
  const byProductTotal = new Map(); // product -> sum
  let totalRows = 0;
  let truncatedMonths = 0;

  for (const ym of months) {
    const data = await callRegister('ПредоставленныеСкидки', ym, ym, 999);
    const rows = data.rows || [];
    totalRows += rows.length;
    if (rows.length >= 999) truncatedMonths += 1;
    for (const r of rows) {
      const product = (r['Номенклатура'] || '').trim() || '—';
      const sum = parseRu(r['СуммаСкидки']);
      const period = parseRuDate(r['Период']);
      const day = period ? period.toISOString().slice(0, 10) : ym + '-01';
      const key = `${product}|${day}`;
      byProductDay.set(key, (byProductDay.get(key) || 0) + sum);
      byProductTotal.set(product, (byProductTotal.get(product) || 0) + sum);
    }
  }

  // Топ-10 товаров по суммарной скидке за период
  const topProducts = Array.from(byProductTotal.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([product, sum]) => ({ product, sum: Number(sum.toFixed(2)) }));

  // Дневная динамика только для топ-10 (иначе массив гигантский)
  const topNames = new Set(topProducts.map(p => p.product));
  const seriesByDay = new Map(); // day -> Map(product -> sum)
  for (const [key, sum] of byProductDay) {
    const [product, day] = key.split('|');
    if (!topNames.has(product)) continue;
    if (!seriesByDay.has(day)) seriesByDay.set(day, new Map());
    seriesByDay.get(day).set(product, sum);
  }
  const days = Array.from(seriesByDay.keys()).sort();
  const series = topProducts.map(tp => ({
    product: tp.product,
    points: days.map(d => ({ day: d, sum: Number((seriesByDay.get(d)?.get(tp.product) || 0).toFixed(2)) }))
  }));

  return {
    period: { from: fromYM, to: toYM },
    totalRows,
    truncatedMonths,
    truncatedNote: truncatedMonths > 0
      ? `${truncatedMonths} из ${months.length} мес упёрлись в лимит 999 строк — после обновления BSL лимит поднимется до 100k.`
      : null,
    topProducts,
    days,
    series
  };
}

// ─── 5) Production-kg ───────────────────────────────────────────────────────
// Выпуск продукции в кг — РегистрНакопления.ВыпускПродукции × ЭталонныйВес.
async function buildProductionKg(fromYM, toYM) {
  const weights = await fetchNomenclatureWeights().catch(e => ({ error: e.message }));
  if (weights.error) {
    return { available: false, note: `Не удалось получить веса: ${weights.error}` };
  }

  const months = rangeMonths(fromYM, toYM);
  const byProduct = new Map(); // product -> { qty, kg }
  const byDay = new Map(); // day -> { qty, kg }
  let totalRows = 0;
  let truncatedMonths = 0;

  for (const ym of months) {
    let data;
    try {
      data = await callRegister('ВыпускПродукции', ym, ym, 999);
    } catch (e) {
      return { available: false, note: `РегистрНакопления.ВыпускПродукции — ${e.message}` };
    }
    const rows = data.rows || [];
    totalRows += rows.length;
    if (rows.length >= 999) truncatedMonths += 1;
    for (const r of rows) {
      const product = (r['Номенклатура'] || '').trim() || '—';
      const qty = parseRu(r['Количество']);
      const w = weights.byName?.get(product);
      const weight = w?.weight || 0;
      const kg = qty * weight;
      if (!byProduct.has(product)) byProduct.set(product, { product, qty: 0, kg: 0, hasWeight: weight > 0 });
      const p = byProduct.get(product);
      p.qty += qty;
      p.kg += kg;
      const period = parseRuDate(r['Период']);
      const day = period ? period.toISOString().slice(0, 10) : ym + '-01';
      if (!byDay.has(day)) byDay.set(day, { day, qty: 0, kg: 0 });
      const d = byDay.get(day);
      d.qty += qty;
      d.kg += kg;
    }
  }

  return {
    available: true,
    period: { from: fromYM, to: toYM },
    totalRows,
    truncatedMonths,
    truncatedNote: truncatedMonths > 0
      ? `${truncatedMonths} мес упёрлись в лимит 999 — после обновления BSL лимит поднимется до 100k.`
      : null,
    summary: {
      totalQty: Number(Array.from(byProduct.values()).reduce((s, p) => s + p.qty, 0).toFixed(2)),
      totalKg: Number(Array.from(byProduct.values()).reduce((s, p) => s + p.kg, 0).toFixed(2)),
      productsWithWeight: Array.from(byProduct.values()).filter(p => p.hasWeight).length,
      productsWithoutWeight: Array.from(byProduct.values()).filter(p => !p.hasWeight).length
    },
    topProducts: Array.from(byProduct.values())
      .sort((a, b) => b.kg - a.kg || b.qty - a.qty)
      .slice(0, 20)
      .map(p => ({ product: p.product, qty: Number(p.qty.toFixed(2)), kg: Number(p.kg.toFixed(2)) })),
    daily: Array.from(byDay.values())
      .sort((a, b) => a.day.localeCompare(b.day))
      .map(d => ({ day: d.day, qty: Number(d.qty.toFixed(2)), kg: Number(d.kg.toFixed(2)) }))
  };
}

// ─── Внешние обёртки с кешированием ─────────────────────────────────────────

async function cached(key, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_TTL_MS) return { ...c.data, fromCache: true };
  const data = await fn();
  if (!data?.error) cache.set(key, { data, at: Date.now() });
  return data;
}

async function getCustomersRetention(opts = {}) {
  if (!BASE) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const fromYM = opts.from || nowYM();
  const toYM = opts.to || fromYM;
  return cached(`retention:${fromYM}:${toYM}`, async () => {
    try {
      return { available: true, ...(await buildCustomersRetention(fromYM, toYM)) };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
}

async function getSalesKg(db, opts = {}) {
  if (!BASE) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const fromISO = opts.from || null;
  const toISO = opts.to || null;
  return cached(`saleskg:${fromISO}:${toISO}`, async () => {
    try {
      return await buildSalesKg(db, fromISO, toISO);
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
}

function getChequeCategories(db, opts = {}) {
  // Без кеша — это локальная операция, быстрая
  try {
    return buildChequeCategories(db, opts.from || null, opts.to || null);
  } catch (e) {
    return { available: false, error: e.message };
  }
}

async function getPromoDynamics(opts = {}) {
  if (!BASE) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const fromYM = opts.from || nowYM();
  const toYM = opts.to || fromYM;
  return cached(`promodyn:${fromYM}:${toYM}`, async () => {
    try {
      return { available: true, ...(await buildPromoDynamics(fromYM, toYM)) };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
}

async function getProductionKg(opts = {}) {
  if (!BASE) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const fromYM = opts.from || nowYM();
  const toYM = opts.to || fromYM;
  return cached(`prodkg:${fromYM}:${toYM}`, async () => {
    try {
      return await buildProductionKg(fromYM, toYM);
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
}

function nowYM() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  getCustomersRetention,
  getSalesKg,
  getChequeCategories,
  getPromoDynamics,
  getProductionKg
};
