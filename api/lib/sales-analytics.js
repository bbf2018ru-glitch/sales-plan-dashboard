// Расширенная аналитика продаж — вычисления для вкладки «Аналитика продаж».
// Использует те же sales/plans что и main aggregateDashboard, но группирует
// по каналам (source магазина), категориям товаров, неделям и т.д.
//
// Не дублирует существующие KPI с главной страницы — только разрезы,
// которых нет в /api/dashboard/summary.

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function roundMetric(value) {
  return Number(Number(value || 0).toFixed(2));
}

function percent(value) {
  return Number((value * 100).toFixed(1));
}

// Per-store scale (та же логика что в analytics.js — приводим cost к target
// через markup из STORE_MARKUPS_JSON чтобы маржа совпадала с отчётом 1С).
function getStoreMarkups() {
  try {
    const obj = JSON.parse(process.env.STORE_MARKUPS_JSON || '{}');
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[String(k)] = n;
    }
    return out;
  } catch (_) { return {}; }
}

function buildStoreCostScale(sales, markups) {
  if (!markups || Object.keys(markups).length === 0) return new Map();
  const raw = new Map();
  for (const row of sales) {
    const cur = raw.get(row.storeId) || { fact: 0, cost: 0 };
    cur.fact += toNumber(row.amount);
    cur.cost += toNumber(row.cost);
    raw.set(row.storeId, cur);
  }
  const scales = new Map();
  for (const [sid, { fact, cost }] of raw) {
    const m = markups[sid];
    if (!m || cost <= 0) continue;
    const targetCost = fact / (1 + m / 100);
    const s = targetCost / cost;
    scales.set(sid, s < 1 ? s : 1);
  }
  return scales;
}

function correctedCost(row, storeCostScale) {
  const scale = storeCostScale.get(row.storeId);
  return scale !== undefined ? toNumber(row.cost) * scale : toNumber(row.cost);
}

// ── Отчёт A1: план/факт по каналам продаж ─────────────────────────────────
// Группируем магазины по source (retail/corporate/mixed) и считаем
// суммарный план, факт, маржу. Так руководитель видит сколько даёт каждый
// канал.
function byChannel(db, period, opts) {
  const { storeCostScale } = opts;
  const storeSource = new Map(db.stores.map(s => [s.id, s.source || 'unknown']));
  const sales = db.sales.filter(r => r.period === period);
  const plans = db.plans.filter(r => r.period === period);

  const acc = new Map();
  const ensure = (src) => {
    if (!acc.has(src)) acc.set(src, { source: src, fact: 0, cost: 0, plan: 0, quantity: 0, stores: new Set() });
    return acc.get(src);
  };

  for (const row of plans) {
    const src = storeSource.get(row.storeId) || 'unknown';
    ensure(src).plan += toNumber(row.amount);
  }
  for (const row of sales) {
    const src = storeSource.get(row.storeId) || 'unknown';
    const it = ensure(src);
    it.fact += toNumber(row.amount);
    it.cost += correctedCost(row, storeCostScale);
    it.quantity += toNumber(row.quantity);
    it.stores.add(row.storeId);
  }

  return Array.from(acc.values()).map(it => ({
    source: it.source,
    storesCount: it.stores.size,
    plan: roundMetric(it.plan),
    fact: roundMetric(it.fact),
    cost: roundMetric(it.cost),
    margin: it.cost > 0 ? roundMetric(it.fact - it.cost) : null,
    marginPct: it.cost > 0 && it.fact > 0 ? percent((it.fact - it.cost) / it.fact) : null,
    quantity: roundMetric(it.quantity),
    completion: it.plan > 0 ? percent(it.fact / it.plan) : 0
  })).sort((a, b) => b.fact - a.fact);
}

// ── Отчёт A8/A19: ABC + доля по категориям товаров ────────────────────────
// Для каждой category из products считаем выручку, себестоимость, маржу.
// ABC: A — товары составляющие 80% выручки, B — следующие 15%, C — последние 5%.
function byCategory(db, period, opts) {
  const { storeCostScale } = opts;
  const productCategory = new Map(db.products.map(p => [p.id, p.category || 'Без категории']));
  const sales = db.sales.filter(r => r.period === period);

  const acc = new Map();
  for (const row of sales) {
    const cat = productCategory.get(row.productId) || 'Без категории';
    if (!acc.has(cat)) acc.set(cat, { category: cat, fact: 0, cost: 0, quantity: 0, productCount: new Set() });
    const it = acc.get(cat);
    it.fact += toNumber(row.amount);
    it.cost += correctedCost(row, storeCostScale);
    it.quantity += toNumber(row.quantity);
    it.productCount.add(row.productId);
  }

  const total = Array.from(acc.values()).reduce((s, it) => s + it.fact, 0);
  return Array.from(acc.values())
    .map(it => ({
      category: it.category,
      fact: roundMetric(it.fact),
      cost: roundMetric(it.cost),
      margin: it.cost > 0 ? roundMetric(it.fact - it.cost) : null,
      marginPct: it.cost > 0 && it.fact > 0 ? percent((it.fact - it.cost) / it.fact) : null,
      markupPct: it.cost > 0 ? percent((it.fact - it.cost) / it.cost) : null,
      quantity: roundMetric(it.quantity),
      products: it.productCount.size,
      share: total > 0 ? percent(it.fact / total) : 0
    }))
    .sort((a, b) => b.fact - a.fact);
}

// ── Отчёт A8 (детальный): ABC анализ ассортимента ────────────────────────
// Каждый товар получает класс A/B/C по доле в выручке.
function abc(db, period, opts) {
  const { storeCostScale } = opts;
  const productMap = new Map(db.products.map(p => [p.id, p]));
  const sales = db.sales.filter(r => r.period === period);
  const acc = new Map();
  for (const row of sales) {
    if (!acc.has(row.productId)) acc.set(row.productId, { productId: row.productId, fact: 0, cost: 0, quantity: 0 });
    const it = acc.get(row.productId);
    it.fact += toNumber(row.amount);
    it.cost += correctedCost(row, storeCostScale);
    it.quantity += toNumber(row.quantity);
  }
  const total = Array.from(acc.values()).reduce((s, it) => s + it.fact, 0);
  const sorted = Array.from(acc.values()).sort((a, b) => b.fact - a.fact);
  let cum = 0;
  return sorted.map(it => {
    const product = productMap.get(it.productId) || {};
    cum += it.fact;
    const cumPct = total > 0 ? cum / total : 0;
    const cls = cumPct <= 0.80 ? 'A' : cumPct <= 0.95 ? 'B' : 'C';
    return {
      productId: it.productId,
      productName: product.name || it.productId,
      category: product.category || '',
      fact: roundMetric(it.fact),
      cost: roundMetric(it.cost),
      margin: it.cost > 0 ? roundMetric(it.fact - it.cost) : null,
      marginPct: it.cost > 0 && it.fact > 0 ? percent((it.fact - it.cost) / it.fact) : null,
      quantity: roundMetric(it.quantity),
      share: total > 0 ? percent(it.fact / total) : 0,
      cumShare: roundMetric(cumPct * 100),
      abc: cls
    };
  });
}

// ── Отчёт A22: выручка по неделям ─────────────────────────────────────────
// Группируем sales по неделе (понедельник-воскресенье). Берём soldAt.
function weeklyRevenue(db, period, opts) {
  const { storeCostScale } = opts;
  const sales = db.sales.filter(r => r.period === period);
  // Неделя ISO: понедельник 00:00 — воскресенье 23:59
  const buckets = new Map();
  for (const row of sales) {
    const d = new Date(row.soldAt);
    if (isNaN(d.getTime())) continue;
    // Сдвигаем к понедельнику
    const dayOfWeek = (d.getDay() + 6) % 7; // 0=пн ... 6=вс
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dayOfWeek);
    const key = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`;
    if (!buckets.has(key)) buckets.set(key, { weekStart: key, fact: 0, cost: 0, quantity: 0 });
    const it = buckets.get(key);
    it.fact += toNumber(row.amount);
    it.cost += correctedCost(row, storeCostScale);
    it.quantity += toNumber(row.quantity);
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map(it => ({
      weekStart: it.weekStart,
      fact: roundMetric(it.fact),
      cost: roundMetric(it.cost),
      margin: it.cost > 0 ? roundMetric(it.fact - it.cost) : null,
      quantity: roundMetric(it.quantity)
    }));
}

// ── Главный entry ─────────────────────────────────────────────────────────
function buildSalesAnalytics(db, period) {
  const markups = getStoreMarkups();
  const sales = db.sales.filter(r => r.period === period);
  const storeCostScale = buildStoreCostScale(sales, markups);
  const opts = { storeCostScale };
  return {
    period,
    byChannel: byChannel(db, period, opts),
    byCategory: byCategory(db, period, opts),
    abc: abc(db, period, opts),
    weekly: weeklyRevenue(db, period, opts)
  };
}

module.exports = { buildSalesAnalytics };
