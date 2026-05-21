// Маркетинговая аналитика — отчёты которые не требуют правок BSL.
// 4 реализованных + 7 pending-stubs c пометкой «нужен новый endpoint в 1С».
//
// Реализованные:
//   1) zombie-products    — план > 0, факт < 10%. Только наша БД.
//   2) discount-cannibalization — сколько маржи съедают скидки (ПредоставленныеСкидки).
//   3) rfm-simple         — RFM по картам из ПродажиПоДисконтнямКартам за N мес.
//   4) holiday-yoy        — корреляция праздник → всплеск выручки YoY.
//
// Pending (нужна правка BSL Hellstaff'ом — полный доступ к ИнформационныеКарты):
//   - birthdays-upcoming  — ДР клиентов на N дней вперёд
//   - geo-districts       — выручка по микрорайонам Иркутска
//   - family-segment      — клиенты с детьми
//   - birthday-campaign   — эффективность ДР-скидки vs обычный чек
// Pending (нужны атрибуты Номенклатуры в pull):
//   - marginal-segment    — товары с флагом Маржинальный
//   - brand-analysis      — НоменклатурныеГруппы.Бренд
// Pending (нужен состав ЧекККМ.Товары):
//   - market-basket       — что покупают вместе с тортом

const { callRegister, parseRu, parseRuDate, prevMonth, rangeMonths, nowYM, makeCache } = require('./upp-client');
const { getUpcomingEvents } = require('./calendar-irk');

const cache = makeCache(5 * 60 * 1000);

// ─── 1) Zombie products — plan > 0, fact < N% ──────────────────────────────
// Магазин-уровень: суммируем план и факт по товару во всей сети за период.
// «Зомби» если факт / план < threshold (default 10%) И план значимый (>= 1000₽).
function buildZombieProducts(db, period, opts = {}) {
  const threshold = opts.threshold ?? 0.10;
  const minPlan = opts.minPlan ?? 1000;
  const productNames = new Map((db.products || []).map(p => [p.id, p.name || p.id]));
  const productCats = new Map((db.products || []).map(p => [p.id, p.category || '—']));

  const planByProduct = new Map();
  const factByProduct = new Map();
  for (const row of db.plans || []) {
    if (row.period !== period) continue;
    if (row.productId === '__total__' || row.productId === 'undefined') continue;
    planByProduct.set(row.productId, (planByProduct.get(row.productId) || 0) + Number(row.amount || 0));
  }
  for (const row of db.sales || []) {
    if (row.period !== period) continue;
    const pid = row.productId || row.product_id;
    if (!pid || pid === '__total__') continue;
    factByProduct.set(pid, (factByProduct.get(pid) || 0) + Number(row.amount || 0));
  }

  const zombies = [];
  for (const [pid, plan] of planByProduct) {
    if (plan < minPlan) continue;
    const fact = factByProduct.get(pid) || 0;
    const pct = plan > 0 ? fact / plan : 0;
    if (pct >= threshold) continue;
    zombies.push({
      productId: pid,
      productName: productNames.get(pid) || pid,
      category: productCats.get(pid),
      plan: Math.round(plan),
      fact: Math.round(fact),
      percent: Number((pct * 100).toFixed(1)),
      gap: Math.round(plan - fact)
    });
  }
  zombies.sort((a, b) => b.gap - a.gap);
  return {
    period,
    threshold,
    minPlan,
    total: zombies.length,
    totalGap: zombies.reduce((s, z) => s + z.gap, 0),
    items: zombies.slice(0, 50)
  };
}

// ─── 2) Discount cannibalization ────────────────────────────────────────────
// Сколько маржи мы теряем на скидках. Через РегистрНакопления.ПредоставленныеСкидки —
// там каждая строка с суммой скидки и УсловиеСкидки (тип акции).
async function buildDiscountCannibalization(fromYM, toYM, opts = {}) {
  const months = rangeMonths(fromYM, toYM);
  const byCondition = new Map();   // УсловиеСкидки -> сумма
  const byMonth = new Map();       // ym -> сумма
  const byReceiver = new Map();    // получатель скидки (Контрагент/Сотрудник) -> сумма
  let totalDiscount = 0;
  let totalRows = 0;
  let truncatedMonths = 0;

  for (const ym of months) {
    const data = await callRegister('ПредоставленныеСкидки', ym, ym, 999);
    const rows = data.rows || [];
    totalRows += rows.length;
    if (rows.length >= 999) truncatedMonths += 1;
    let monthTotal = 0;
    for (const r of rows) {
      const sum = parseRu(r['СуммаСкидки']);
      const cond = (r['УсловиеСкидки'] || '—').trim() || '—';
      const recv = (r['ПолучательСкидки'] || '—').trim() || '—';
      byCondition.set(cond, (byCondition.get(cond) || 0) + sum);
      byReceiver.set(recv, (byReceiver.get(recv) || 0) + sum);
      monthTotal += sum;
    }
    byMonth.set(ym, monthTotal);
    totalDiscount += monthTotal;
  }

  // Сравниваем с выручкой сети за тот же период (totals из аналитики/sales).
  // Не у нас здесь, поэтому возвращаем сырые суммы. Frontend может разделить
  // на свой totals.fact чтобы получить % каннибализации.

  return {
    period: { from: fromYM, to: toYM },
    totals: {
      totalDiscount: Number(totalDiscount.toFixed(2)),
      totalRows,
      months: months.length,
      truncatedMonths
    },
    byCondition: Array.from(byCondition.entries())
      .map(([condition, amount]) => ({ condition, amount: Number(amount.toFixed(2)) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 20),
    byMonth: Array.from(byMonth.entries())
      .map(([ym, amount]) => ({ period: ym, amount: Number(amount.toFixed(2)) })),
    topReceivers: Array.from(byReceiver.entries())
      .filter(([name]) => name && name !== '—')
      .map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 15),
    truncationWarning: truncatedMonths > 0
      ? `${truncatedMonths} мес. из ${months.length} обрезаны лимитом 999 строк — реальные суммы могут быть выше.`
      : null
  };
}

// ─── 3) RFM (упрощённый) по картам ──────────────────────────────────────────
// Recency-Frequency-Monetary через РегистрНакопления.ПродажиПоДисконтнымКартам.
// Поскольку у нас нет полного доступа к ИнформационныеКарты, идентифицируем
// клиента по полю ВладелецДисконтнойКарты (имя). Это работает грубо: один
// человек с несколькими картами будет считаться несколькими, но для топ-100
// сегмента это допустимо.
async function buildRfmSimple(fromYM, toYM) {
  const months = rangeMonths(fromYM, toYM);
  const owners = new Map(); // ownerName -> { recencyYM, frequency, monetary }
  const today = nowYM();

  for (const ym of months) {
    const data = await callRegister('ПродажиПоДисконтнымКартам', ym, ym, 999);
    const rows = data.rows || [];
    for (const r of rows) {
      const owner = (r['ВладелецДисконтнойКарты'] || '').trim();
      if (!owner) continue;
      const amount = parseRu(r['Сумма']);
      if (!owners.has(owner)) {
        owners.set(owner, { name: owner, recencyYM: ym, frequency: 0, monetary: 0 });
      }
      const o = owners.get(owner);
      o.frequency += 1;
      o.monetary += amount;
      // recencyYM — самый поздний месяц активности
      if (ym > o.recencyYM) o.recencyYM = ym;
    }
  }

  // Сегментация: 5 ведер по каждой оси (квинтили)
  const list = Array.from(owners.values());
  if (list.length === 0) {
    return {
      period: { from: fromYM, to: toYM },
      segments: [],
      total: 0,
      note: 'Нет данных по дисконтным картам за период'
    };
  }

  // Recency: чем меньше N месяцев между recencyYM и today, тем выше score
  const monthsBetween = (a, b) => {
    const [yA, mA] = a.split('-').map(Number);
    const [yB, mB] = b.split('-').map(Number);
    return (yB - yA) * 12 + (mB - mA);
  };
  for (const o of list) {
    o.recencyMonths = monthsBetween(o.recencyYM, today);
  }

  const quantile = (arr, q) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return sorted[base] + (sorted[base + 1] !== undefined ? rest * (sorted[base + 1] - sorted[base]) : 0);
  };
  const rArr = list.map(o => o.recencyMonths);
  const fArr = list.map(o => o.frequency);
  const mArr = list.map(o => o.monetary);
  const rQ = [0.2, 0.4, 0.6, 0.8].map(q => quantile(rArr, q));
  const fQ = [0.2, 0.4, 0.6, 0.8].map(q => quantile(fArr, q));
  const mQ = [0.2, 0.4, 0.6, 0.8].map(q => quantile(mArr, q));

  const scoreFromQuintile = (v, qs, reverse = false) => {
    let score = 1;
    for (const q of qs) if (v >= q) score += 1;
    return reverse ? 6 - score : score; // 1..5
  };
  for (const o of list) {
    o.R = scoreFromQuintile(o.recencyMonths, rQ, true); // меньше recency = выше
    o.F = scoreFromQuintile(o.frequency, fQ);
    o.M = scoreFromQuintile(o.monetary, mQ);
    // Семантический сегмент
    if (o.R >= 4 && o.F >= 4 && o.M >= 4) o.segment = 'VIP';
    else if (o.R >= 4 && o.F >= 3) o.segment = 'Постоянные';
    else if (o.R >= 4 && o.F <= 2) o.segment = 'Новые';
    else if (o.R <= 2 && o.M >= 4) o.segment = 'Уходящие VIP';
    else if (o.R <= 2) o.segment = 'Спящие';
    else o.segment = 'Прочие';
  }

  // Группируем по сегменту
  const bySegment = new Map();
  for (const o of list) {
    if (!bySegment.has(o.segment)) bySegment.set(o.segment, { segment: o.segment, count: 0, monetary: 0, frequency: 0 });
    const s = bySegment.get(o.segment);
    s.count += 1;
    s.monetary += o.monetary;
    s.frequency += o.frequency;
  }

  return {
    period: { from: fromYM, to: toYM },
    total: list.length,
    segments: Array.from(bySegment.values())
      .map(s => ({
        ...s,
        monetary: Number(s.monetary.toFixed(2)),
        avgMonetary: Number((s.monetary / s.count).toFixed(2))
      }))
      .sort((a, b) => b.monetary - a.monetary),
    topVIP: list
      .filter(o => o.segment === 'VIP')
      .sort((a, b) => b.monetary - a.monetary)
      .slice(0, 20)
      .map(o => ({ name: o.name, monetary: Number(o.monetary.toFixed(2)), frequency: o.frequency, R: o.R, F: o.F, M: o.M })),
    topSleeping: list
      .filter(o => o.segment === 'Спящие' || o.segment === 'Уходящие VIP')
      .sort((a, b) => b.monetary - a.monetary)
      .slice(0, 20)
      .map(o => ({ name: o.name, monetary: Number(o.monetary.toFixed(2)), recencyMonths: o.recencyMonths, R: o.R, M: o.M, segment: o.segment }))
  };
}

// ─── 4) Holiday × YoY ───────────────────────────────────────────────────────
// Корреляция «праздник → всплеск выручки». Для каждого праздника впереди
// смотрим что было год назад в окрестности (±3 дня), сравниваем с baseline.
function buildHolidayYoy(db, windowDays = 60) {
  const events = getUpcomingEvents(windowDays);
  const sales = db.sales || [];
  if (!sales.length) return { events: [], note: 'Нет sales в БД' };

  // Группируем выручку по дням (YYYY-MM-DD из soldAt)
  const byDay = new Map(); // 'YYYY-MM-DD' -> сумма
  for (const s of sales) {
    const soldAt = s.soldAt || s.sold_at;
    if (!soldAt) continue;
    const d = new Date(soldAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + Number(s.amount || 0));
  }

  // Среднее по всем дням как baseline
  const allDays = Array.from(byDay.values());
  const avgDay = allDays.length ? allDays.reduce((s, x) => s + x, 0) / allDays.length : 0;

  const out = [];
  for (const e of events) {
    // Дата праздника текущего года
    const [yy, mm, dd] = e.date.split('-').map(Number);
    // Год назад — та же дата −1 год
    const lastYearDate = new Date(Date.UTC(yy - 1, mm - 1, dd));
    // Окно ±3 дня
    const days3 = [-3, -2, -1, 0, 1, 2, 3];
    let lastYearSum = 0, lastYearCount = 0;
    for (const dlt of days3) {
      const d = new Date(lastYearDate);
      d.setUTCDate(d.getUTCDate() + dlt);
      const key = d.toISOString().slice(0, 10);
      if (byDay.has(key)) {
        lastYearSum += byDay.get(key);
        lastYearCount += 1;
      }
    }
    const lastYearAvg = lastYearCount > 0 ? lastYearSum / lastYearCount : null;
    const liftPct = lastYearAvg && avgDay > 0
      ? Number((((lastYearAvg / avgDay) - 1) * 100).toFixed(1))
      : null;
    out.push({
      date: e.date,
      daysFromNow: e.daysFromNow,
      name: e.name,
      impact: e.impact,
      lastYearAvgRevenue: lastYearAvg !== null ? Number(lastYearAvg.toFixed(0)) : null,
      lastYearDaysCount: lastYearCount,
      baselineAvg: Number(avgDay.toFixed(0)),
      liftPct,
      note: e.note || null
    });
  }
  return {
    windowDays,
    baseline: { avgRevenuePerDay: Number(avgDay.toFixed(0)), daysObserved: allDays.length },
    events: out.filter(x => x.lastYearAvgRevenue !== null || x.impact !== 'low')
  };
}

// ─── 5) Store clusters ──────────────────────────────────────────────────────
// k-means по 3 признакам (выполнение %, маржинальность %, средний чек).
// Без библиотеки — реализация k-means на ~50 строк. k=4 фиксировано
// (Лидеры / Маржинальные / Массовые / Отстающие).
function buildStoreClusters(db, period) {
  // 1. Собираем фичи по каждому магазину
  const stores = db.stores || [];
  const plans = db.plans || [];
  const sales = db.sales || [];
  const byStore = new Map();
  for (const s of stores) {
    byStore.set(s.id, {
      storeId: s.id,
      storeName: s.name,
      plan: 0, fact: 0, cost: 0, quantity: 0, chequeCount: 0
    });
  }
  for (const p of plans) {
    if (p.period !== period) continue;
    if (byStore.has(p.storeId)) byStore.get(p.storeId).plan += Number(p.amount || 0);
  }
  for (const s of sales) {
    if (s.period !== period) continue;
    const sid = s.storeId || s.store_id;
    if (!byStore.has(sid)) continue;
    const x = byStore.get(sid);
    x.fact += Number(s.amount || 0);
    x.cost += Number(s.cost || 0);
    x.quantity += Number(s.quantity || 0);
  }
  // Фильтр: только магазины с планом > 0 (без виртуальных и закрытых)
  const points = Array.from(byStore.values())
    .filter(x => x.plan > 0 && x.fact > 0)
    .map(x => ({
      ...x,
      pctCompletion: (x.fact / x.plan) * 100,
      marginPct: x.fact > 0 ? ((x.fact - x.cost) / x.fact) * 100 : 0,
      avgCheck: x.quantity > 0 ? x.fact / x.quantity : 0
    }));
  if (points.length < 4) return { period, total: points.length, clusters: [], note: 'Слишком мало точек для кластеризации' };

  // 2. Нормализация: каждая фича в [0..1]
  const featNames = ['pctCompletion', 'marginPct', 'avgCheck'];
  const ranges = featNames.map(f => {
    const vs = points.map(p => p[f]);
    return { f, min: Math.min(...vs), max: Math.max(...vs) };
  });
  const normalize = (p) => featNames.map((f, i) => {
    const r = ranges[i];
    return r.max > r.min ? (p[f] - r.min) / (r.max - r.min) : 0.5;
  });
  for (const p of points) p._norm = normalize(p);

  // 3. k-means++ init (k=4)
  const k = Math.min(4, points.length);
  const centroids = [points[0]._norm.slice()];
  while (centroids.length < k) {
    // Точка с максимальным минимальным расстоянием до существующих центров
    let best = null, bestDist = -1;
    for (const p of points) {
      const minDist = Math.min(...centroids.map(c => Math.hypot(...c.map((v, i) => v - p._norm[i]))));
      if (minDist > bestDist) { bestDist = minDist; best = p; }
    }
    centroids.push(best._norm.slice());
  }

  // 4. Итерации
  for (let iter = 0; iter < 30; iter++) {
    for (const p of points) {
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < k; i++) {
        const d = Math.hypot(...centroids[i].map((v, j) => v - p._norm[j]));
        if (d < bestDist) { bestDist = d; best = i; }
      }
      p._cluster = best;
    }
    // Пересчёт центров
    const changed = centroids.map((c, i) => {
      const cps = points.filter(p => p._cluster === i);
      if (!cps.length) return c;
      return c.map((_, j) => cps.reduce((s, p) => s + p._norm[j], 0) / cps.length);
    });
    const delta = centroids.map((c, i) => Math.hypot(...c.map((v, j) => v - changed[i][j]))).reduce((s, x) => s + x, 0);
    centroids.splice(0, k, ...changed);
    if (delta < 1e-4) break;
  }

  // 5. Семантические имена кластеров — по характеристикам центра
  const labelFor = (c) => {
    const [pct, margin, check] = c;
    if (pct > 0.7 && margin > 0.6) return { name: 'Лидеры', tone: 'good' };
    if (margin > 0.7) return { name: 'Маржинальные', tone: 'good' };
    if (check < 0.4 && pct > 0.5) return { name: 'Массовые (низкий чек, высокий объём)', tone: 'neutral' };
    if (pct < 0.5) return { name: 'Отстающие', tone: 'bad' };
    return { name: 'Средние', tone: 'neutral' };
  };

  const clusters = centroids.map((c, i) => {
    const label = labelFor(c);
    const cps = points.filter(p => p._cluster === i);
    if (!cps.length) return null;
    const avg = (arr, key) => arr.reduce((s, x) => s + x[key], 0) / arr.length;
    return {
      idx: i,
      name: label.name,
      tone: label.tone,
      count: cps.length,
      avg: {
        pctCompletion: Number(avg(cps, 'pctCompletion').toFixed(1)),
        marginPct: Number(avg(cps, 'marginPct').toFixed(1)),
        avgCheck: Number(avg(cps, 'avgCheck').toFixed(0))
      },
      stores: cps.map(p => ({
        storeId: p.storeId,
        storeName: p.storeName,
        pctCompletion: Number(p.pctCompletion.toFixed(1)),
        marginPct: Number(p.marginPct.toFixed(1)),
        avgCheck: Number(p.avgCheck.toFixed(0)),
        fact: Math.round(p.fact)
      })).sort((a, b) => b.fact - a.fact)
    };
  }).filter(Boolean).sort((a, b) => b.count - a.count);

  return { period, total: points.length, clusters };
}

// ─── 6) Cohort retention ────────────────────────────────────────────────────
// Когорта = клиенты которые впервые активировали карту в месяце N. Смотрим
// какой % из них активен в N+1, N+2, ... мес. Используем РегистрНакопления.Бонусы
// (как customers-retention, но split по first-month).
async function buildCohortRetention(monthsBack = 6) {
  // Берём N последних завершённых месяцев + текущий
  const today = nowYM();
  let from = today;
  for (let i = 0; i < monthsBack; i++) from = prevMonth(from);
  const months = rangeMonths(from, today);

  // 1. Собираем card -> { firstMonth, activeMonths: Set }
  const cards = new Map();
  for (const ym of months) {
    try {
      const data = await callRegister('Бонусы', ym, ym, 999);
      for (const r of data.rows || []) {
        const card = (r['БонуснаяКарта'] || '').trim();
        if (!card) continue;
        if (!cards.has(card)) cards.set(card, { card, firstMonth: ym, activeMonths: new Set() });
        const c = cards.get(card);
        c.activeMonths.add(ym);
        if (ym < c.firstMonth) c.firstMonth = ym;
      }
    } catch { /* skip month if 1C 5xx */ }
  }

  // 2. Группируем по firstMonth → строим retention curve
  const cohorts = new Map();
  for (const c of cards.values()) {
    if (!cohorts.has(c.firstMonth)) cohorts.set(c.firstMonth, { firstMonth: c.firstMonth, total: 0, retained: new Map() });
    const k = cohorts.get(c.firstMonth);
    k.total += 1;
    // По месяцам после first
    const firstIdx = months.indexOf(c.firstMonth);
    if (firstIdx < 0) continue;
    for (let i = 0; i < months.length - firstIdx; i++) {
      const ym = months[firstIdx + i];
      if (c.activeMonths.has(ym)) {
        k.retained.set(i, (k.retained.get(i) || 0) + 1);
      }
    }
  }

  return {
    monthsBack,
    months,
    cohorts: Array.from(cohorts.values())
      .map(k => ({
        firstMonth: k.firstMonth,
        total: k.total,
        retention: Array.from(k.retained.entries())
          .map(([offset, count]) => ({
            offset,
            count,
            pct: Number(((count / k.total) * 100).toFixed(1))
          }))
          .sort((a, b) => a.offset - b.offset)
      }))
      .sort((a, b) => a.firstMonth.localeCompare(b.firstMonth))
  };
}

// ─── Pending stubs (для прозрачности что в плане) ──────────────────────────
function buildPendingStub(reason) {
  return { available: false, pending: true, reason };
}
const PENDING_BIRTHDAYS = () => buildPendingStub('Нужен новый BSL endpoint /catalog?name=ИнформационныеКарты с фильтром ДатаРождения BETWEEN now AND now+N. Сейчас /object отдаёт только метаданные + sample 30 записей.');
const PENDING_GEO = () => buildPendingStub('Нужен полный доступ к ИнформационныеКарты.МикрорайонПроживания (см. birthdays).');
const PENDING_FAMILY = () => buildPendingStub('Нужен полный доступ к ИнформационныеКарты.Дети (см. birthdays).');
const PENDING_BIRTHDAY_CAMPAIGN = () => buildPendingStub('Требует совмещения ИнформационныеКарты + ПредоставленныеСкидки.УсловиеСкидки="ДР" (см. birthdays).');
const PENDING_MARGINAL = () => buildPendingStub('Нужны атрибуты товара (Маржинальный, ЗаказнойТорт, Аллерген) в payload /pull — сейчас приходит только id/name/category.');
const PENDING_BRAND = () => buildPendingStub('Нужно НоменклатурныеГруппы.Бренд в /object или включение Брэнда в /pull.');
const PENDING_MARKET_BASKET = () => buildPendingStub('Нужны товары в составе ЧекККМ (ТабличнаяЧасть ЧекККМ.Товары). Сейчас /document отдаёт шапку чека без позиций.');

// ─── Wrappers с кэшем ─────────────────────────────────────────────────────
async function getZombieProducts(db, period, opts) {
  return cache.wrap(`zombie:${period}:${JSON.stringify(opts || {})}`, async () =>
    buildZombieProducts(db, period, opts || {})
  );
}
async function getDiscountCannibalization(fromYM, toYM) {
  return cache.wrap(`canniba:${fromYM}:${toYM}`, async () =>
    buildDiscountCannibalization(fromYM, toYM)
  );
}
async function getRfmSimple(fromYM, toYM) {
  return cache.wrap(`rfm:${fromYM}:${toYM}`, async () =>
    buildRfmSimple(fromYM, toYM)
  );
}
function getHolidayYoy(db, windowDays) {
  return buildHolidayYoy(db, windowDays || 60);
}
function getStoreClusters(db, period) {
  return cache.wrap(`clusters:${period}`, async () => buildStoreClusters(db, period));
}
async function getCohortRetention(monthsBack) {
  return cache.wrap(`cohorts:${monthsBack || 6}`, async () => buildCohortRetention(monthsBack || 6));
}

module.exports = {
  getZombieProducts,
  getDiscountCannibalization,
  getRfmSimple,
  getHolidayYoy,
  getStoreClusters,
  getCohortRetention,
  // Pending — возвращают { available: false, pending: true, reason } для UI
  getBirthdays: PENDING_BIRTHDAYS,
  getGeoDistricts: PENDING_GEO,
  getFamilySegment: PENDING_FAMILY,
  getBirthdayCampaignEffect: PENDING_BIRTHDAY_CAMPAIGN,
  getMarginalSegment: PENDING_MARGINAL,
  getBrandAnalysis: PENDING_BRAND,
  getMarketBasket: PENDING_MARKET_BASKET
};
