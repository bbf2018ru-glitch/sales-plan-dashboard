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

// ── Доп.отчёт: ABC по группам товаров ─────────────────────────────────
// Применяет A/B/C класс не к отдельным товарам, а к группам — даёт картину
// какие группы дают 80% выручки.
function abcCategories(byCategoryRows) {
  const sorted = [...byCategoryRows].sort((a, b) => b.fact - a.fact);
  const total = sorted.reduce((s, c) => s + c.fact, 0);
  let cum = 0;
  return sorted.map(c => {
    cum += c.fact;
    const cumPct = total > 0 ? cum / total : 0;
    const cls = cumPct <= 0.80 ? 'A' : cumPct <= 0.95 ? 'B' : 'C';
    return { ...c, cumShare: roundMetric(cumPct * 100), abc: cls };
  });
}

// ── Доп.отчёт: продажи по дням недели ─────────────────────────────────
// Группируем sales по дню недели (пн-вс). Помогает увидеть пиковые дни.
const WEEKDAYS_RU = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

function byWeekday(db, period, opts) {
  const { storeCostScale } = opts;
  const sales = db.sales.filter(r => r.period === period);
  const buckets = WEEKDAYS_RU.map((name, idx) => ({ idx, name, fact: 0, cost: 0, quantity: 0, salesDays: new Set() }));
  for (const row of sales) {
    const d = new Date(row.soldAt);
    if (isNaN(d.getTime())) continue;
    const idx = (d.getDay() + 6) % 7; // 0=пн ... 6=вс
    buckets[idx].fact += toNumber(row.amount);
    buckets[idx].cost += correctedCost(row, storeCostScale);
    buckets[idx].quantity += toNumber(row.quantity);
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    buckets[idx].salesDays.add(dayKey);
  }
  return buckets.map(b => ({
    weekday: b.name,
    weekdayIdx: b.idx,
    fact: roundMetric(b.fact),
    cost: roundMetric(b.cost),
    margin: b.cost > 0 ? roundMetric(b.fact - b.cost) : null,
    marginPct: b.cost > 0 && b.fact > 0 ? percent((b.fact - b.cost) / b.fact) : null,
    quantity: roundMetric(b.quantity),
    daysCount: b.salesDays.size,
    avgPerDay: b.salesDays.size > 0 ? roundMetric(b.fact / b.salesDays.size) : 0
  }));
}

// ── Доп.отчёт: динамика факта по дням месяца ──────────────────────────
function dailyDynamic(db, period, opts) {
  const { storeCostScale } = opts;
  const sales = db.sales.filter(r => r.period === period);
  const buckets = new Map();
  for (const row of sales) {
    const d = new Date(row.soldAt);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!buckets.has(key)) buckets.set(key, { date: key, fact: 0, cost: 0, quantity: 0 });
    const it = buckets.get(key);
    it.fact += toNumber(row.amount);
    it.cost += correctedCost(row, storeCostScale);
    it.quantity += toNumber(row.quantity);
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(it => ({
      date: it.date,
      fact: roundMetric(it.fact),
      cost: roundMetric(it.cost),
      margin: it.cost > 0 ? roundMetric(it.fact - it.cost) : null,
      quantity: roundMetric(it.quantity)
    }));
}

// ── Доп.отчёт: наценка по магазинам (% и абсолют) ──────────────────────
function markupByStore(db, period, opts) {
  const { storeCostScale } = opts;
  const storeMap = new Map(db.stores.map(s => [s.id, s]));
  const sales = db.sales.filter(r => r.period === period);
  const acc = new Map();
  for (const row of sales) {
    if (!acc.has(row.storeId)) acc.set(row.storeId, { storeId: row.storeId, fact: 0, cost: 0 });
    const it = acc.get(row.storeId);
    it.fact += toNumber(row.amount);
    it.cost += correctedCost(row, storeCostScale);
  }
  return Array.from(acc.values())
    .map(it => {
      const s = storeMap.get(it.storeId) || {};
      return {
        storeId: it.storeId,
        storeName: s.name || it.storeId,
        source: s.source || '',
        fact: roundMetric(it.fact),
        cost: roundMetric(it.cost),
        margin: it.cost > 0 ? roundMetric(it.fact - it.cost) : null,
        marginPct: it.cost > 0 && it.fact > 0 ? percent((it.fact - it.cost) / it.fact) : null,
        markupPct: it.cost > 0 ? percent((it.fact - it.cost) / it.cost) : null
      };
    })
    .sort((a, b) => (b.markupPct || 0) - (a.markupPct || 0));
}

// ── Отчёт C2: возвраты (sales с отрицательной amount) ─────────────────
// BSL шлёт возвраты как отдельные sales со знаком минус (через ОБЪЕДИНИТЬ
// ВСЕ для ВидОперации = Возврат). Считаем абсолютные суммы.
function returns(db, period, opts) {
  const { storeCostScale } = opts;
  const storeMap = new Map(db.stores.map(s => [s.id, s]));
  const productMap = new Map(db.products.map(p => [p.id, p]));
  const sales = db.sales.filter(r => r.period === period && toNumber(r.amount) < 0);

  let total = 0;
  let totalQty = 0;
  const byStore = new Map();
  const byProduct = new Map();

  for (const row of sales) {
    const amt = Math.abs(toNumber(row.amount));
    const qty = Math.abs(toNumber(row.quantity));
    total += amt;
    totalQty += qty;

    if (!byStore.has(row.storeId)) byStore.set(row.storeId, { storeId: row.storeId, amount: 0, quantity: 0 });
    const bs = byStore.get(row.storeId);
    bs.amount += amt;
    bs.quantity += qty;

    if (!byProduct.has(row.productId)) byProduct.set(row.productId, { productId: row.productId, amount: 0, quantity: 0 });
    const bp = byProduct.get(row.productId);
    bp.amount += amt;
    bp.quantity += qty;
  }

  return {
    totalAmount: roundMetric(total),
    totalQuantity: roundMetric(totalQty),
    rowsCount: sales.length,
    byStore: Array.from(byStore.values())
      .map(it => ({ ...it, storeName: storeMap.get(it.storeId)?.name || it.storeId, amount: roundMetric(it.amount), quantity: roundMetric(it.quantity) }))
      .sort((a, b) => b.amount - a.amount),
    byProduct: Array.from(byProduct.values())
      .map(it => ({ ...it, productName: productMap.get(it.productId)?.name || it.productId, amount: roundMetric(it.amount), quantity: roundMetric(it.quantity) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 30)
  };
}

// ── Отчёт: продажи по часам суток ─────────────────────────────────────
// Из soldAt timestamp группируем по часу (0-23). Иркутск UTC+8.
const IRK_TZ_HOURS = 8;
function byHour(db, period, opts) {
  const { storeCostScale } = opts;
  const sales = db.sales.filter(r => r.period === period && toNumber(r.amount) > 0);
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, fact: 0, cost: 0, quantity: 0, txCount: 0 }));
  for (const row of sales) {
    const d = new Date(row.soldAt);
    if (isNaN(d.getTime())) continue;
    // Корректировка UTC → Иркутск (UTC+8)
    const utcH = d.getUTCHours();
    const irkH = (utcH + IRK_TZ_HOURS) % 24;
    buckets[irkH].fact += toNumber(row.amount);
    buckets[irkH].cost += correctedCost(row, storeCostScale);
    buckets[irkH].quantity += toNumber(row.quantity);
    buckets[irkH].txCount += 1;
  }
  return buckets.map(b => ({
    hour: b.hour,
    fact: roundMetric(b.fact),
    cost: roundMetric(b.cost),
    margin: b.cost > 0 ? roundMetric(b.fact - b.cost) : null,
    marginPct: b.cost > 0 && b.fact > 0 ? percent((b.fact - b.cost) / b.fact) : null,
    quantity: roundMetric(b.quantity),
    txCount: b.txCount
  }));
}

// ── Отчёт: топ-маржинальные товары ────────────────────────────────────
// Сортировка abc-данных по margin DESC. Берём top-30.
function topMarginProducts(abcRows, limit = 30) {
  return [...abcRows]
    .filter(r => r.margin !== null && r.margin > 0)
    .sort((a, b) => b.margin - a.margin)
    .slice(0, limit);
}

// ── Heatmap: день недели × час ────────────────────────────────────────
// Матрица 7x24 — где средняя выручка в этот час недели максимальна.
function heatmapDayHour(db, period, opts) {
  const sales = db.sales.filter(r => r.period === period && toNumber(r.amount) > 0);
  // 7 дней × 24 часа
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ fact: 0, count: 0 })));
  for (const row of sales) {
    const d = new Date(row.soldAt);
    if (isNaN(d.getTime())) continue;
    const dayIdx = (d.getUTCDay() + 6) % 7; // 0=пн ... 6=вс
    const irkH = (d.getUTCHours() + IRK_TZ_HOURS) % 24;
    grid[dayIdx][irkH].fact += toNumber(row.amount);
    grid[dayIdx][irkH].count += 1;
  }
  // Превращаем в плоский список для удобства фронта
  const cells = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      cells.push({ day: d, hour: h, fact: roundMetric(grid[d][h].fact), count: grid[d][h].count });
    }
  }
  return cells;
}

// ── Фильтрация по диапазону дат ───────────────────────────────────────────
// Если задан from/to (ISO даты вида '2026-05-01'), отфильтровываем sales
// по soldAt в этом диапазоне. Возвращаем модифицированный db.
function filterDbByDateRange(db, from, to) {
  if (!from && !to) return db;
  const fromT = from ? new Date(from + 'T00:00:00+08:00').getTime() : -Infinity;
  const toT = to ? new Date(to + 'T23:59:59+08:00').getTime() : Infinity;
  return {
    ...db,
    sales: db.sales.filter(r => {
      const t = new Date(r.soldAt).getTime();
      if (isNaN(t)) return true; // строки без даты оставляем (не отсекаем)
      return t >= fromT && t <= toT;
    })
  };
}

// ── Сравнительный круговой отчёт по магазинам (C3 из xlsx) ─────────────
// Радар-чарт: для каждого магазина 5 метрик в нормализованном виде (0-100%):
//   1. План/факт (% выполнения)
//   2. Маржинальность (margin% / max_margin% по сети)
//   3. Доля в выручке сети (fact / total_fact)
//   4. Средняя сумма строки sales (≈ средний чек по позиции)
//   5. Наценка % / max_markup
// Это даёт компактную картину "сила vs слабость" по каждому магазину.
function comparisonRadar(db, period, opts) {
  const { storeCostScale } = opts;
  const storeMap = new Map(db.stores.map(s => [s.id, s]));
  const sales = db.sales.filter(r => r.period === period && toNumber(r.amount) > 0);
  const plans = db.plans.filter(r => r.period === period);

  const acc = new Map();
  for (const row of plans) {
    if (!acc.has(row.storeId)) acc.set(row.storeId, { storeId: row.storeId, fact: 0, cost: 0, plan: 0, rowCount: 0 });
    acc.get(row.storeId).plan += toNumber(row.amount);
  }
  for (const row of sales) {
    if (!acc.has(row.storeId)) acc.set(row.storeId, { storeId: row.storeId, fact: 0, cost: 0, plan: 0, rowCount: 0 });
    const it = acc.get(row.storeId);
    it.fact += toNumber(row.amount);
    it.cost += correctedCost(row, storeCostScale);
    it.rowCount += 1;
  }

  const items = Array.from(acc.values())
    .filter(it => it.fact > 0)
    .map(it => {
      const s = storeMap.get(it.storeId) || {};
      const marginPct = it.cost > 0 ? (it.fact - it.cost) / it.fact * 100 : 0;
      const markupPct = it.cost > 0 ? (it.fact - it.cost) / it.cost * 100 : 0;
      const completion = it.plan > 0 ? it.fact / it.plan * 100 : 0;
      const avgRow = it.rowCount > 0 ? it.fact / it.rowCount : 0;
      return {
        storeId: it.storeId,
        storeName: s.name || it.storeId,
        fact: roundMetric(it.fact),
        plan: roundMetric(it.plan),
        completion: roundMetric(completion),
        marginPct: roundMetric(marginPct),
        markupPct: roundMetric(markupPct),
        avgRow: roundMetric(avgRow),
        rowCount: it.rowCount
      };
    });

  if (!items.length) return { stores: [], metrics: [] };

  // Нормализация: для каждой метрики max → 100, остальные пропорционально.
  const maxC = Math.max(...items.map(i => i.completion), 1);
  const maxM = Math.max(...items.map(i => i.marginPct), 1);
  const maxK = Math.max(...items.map(i => i.markupPct), 1);
  const maxA = Math.max(...items.map(i => i.avgRow), 1);
  const totalFact = items.reduce((s, i) => s + i.fact, 0);

  return {
    metrics: ['Выполнение плана', 'Маржа %', 'Наценка %', 'Ср. сумма продажи', 'Доля в сети'],
    stores: items.map(it => ({
      storeId: it.storeId,
      storeName: it.storeName,
      raw: { completion: it.completion, marginPct: it.marginPct, markupPct: it.markupPct, avgRow: it.avgRow, fact: it.fact, plan: it.plan },
      // Нормализованные значения 0-100 для радара
      normalized: [
        Math.min(it.completion, 100),
        Math.min(it.marginPct, 100),
        roundMetric(it.markupPct / maxK * 100),
        roundMetric(it.avgRow / maxA * 100),
        roundMetric(it.fact / totalFact * 100)
      ]
    })).sort((a, b) => b.raw.fact - a.raw.fact)
  };
}

// ── Главный entry ─────────────────────────────────────────────────────────
function buildSalesAnalytics(db, period, opts = {}) {
  const fromDate = opts.from || null;
  const toDate = opts.to || null;
  const filtered = filterDbByDateRange(db, fromDate, toDate);

  const markups = getStoreMarkups();
  const sales = filtered.sales.filter(r => r.period === period);
  const storeCostScale = buildStoreCostScale(sales, markups);
  const innerOpts = { storeCostScale };
  const cats = byCategory(filtered, period, innerOpts);
  const abcRows = abc(filtered, period, innerOpts);
  return {
    period,
    range: fromDate || toDate ? { from: fromDate, to: toDate } : null,
    byChannel: byChannel(filtered, period, innerOpts),
    byCategory: cats,
    byCategoryAbc: abcCategories(cats),
    abc: abcRows,
    topMargin: topMarginProducts(abcRows, 30),
    weekly: weeklyRevenue(filtered, period, innerOpts),
    byWeekday: byWeekday(filtered, period, innerOpts),
    byHour: byHour(filtered, period, innerOpts),
    daily: dailyDynamic(filtered, period, innerOpts),
    byStoreMarkup: markupByStore(filtered, period, innerOpts),
    returns: returns(filtered, period, innerOpts),
    heatmap: heatmapDayHour(filtered, period, innerOpts),
    comparison: comparisonRadar(filtered, period, innerOpts)
  };
}

module.exports = { buildSalesAnalytics };
