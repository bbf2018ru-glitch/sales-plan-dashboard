// Маркетинг «по каналам» — живые данные из 1С за месяц + тот же месяц год назад (YoY).
// Источник: HTTP-сервис 1С УПП (sales-detail, register СладкийЧек, catalog Акции).
// Кэш + фоновое обновление в server.js делают данные свежими 24/7 без участия ПК.

const fs = require('fs');
const { callSalesDetail, callRegister, callCatalog, callPull, callStoresDetail, parseRu, parseRuDate, nowYM, makeCache } = require('./upp-client');

// Данные не-1С источников (2ГИС/Директ/Метрика) пишутся скрейперами по cron
// в /opt/marketing-data/*.json. API только читает их (без скрейпинга в рантайме).
const EXT_DIR = process.env.MARKETING_DATA_DIR || '/opt/marketing-data';
function readExternal(file) {
  try { return JSON.parse(fs.readFileSync(EXT_DIR + '/' + file, 'utf8')); }
  catch (_) { return null; }
}

const cache = makeCache(6 * 60 * 60 * 1000);     // 6 часов — основной расчёт
const mapCache = makeCache(24 * 60 * 60 * 1000); // 24 часа — карты товаров/точек
const monthCache = makeCache(24 * 60 * 60 * 1000); // 24 часа — агрегаты per-month (прошлые месяцы не меняются)

// Карта точек: storeCode -> name (по /stores-detail), кэш 24ч.
async function getStoreMap() {
  const res = await mapCache.wrap('stores', async () => {
    const d = await callStoresDetail();
    const rows = (d && d.rows) || [];
    const pick = (p, keys) => { for (const k of keys) { const v = p[k]; if (v != null && String(v).trim()) return String(v).trim(); } return ''; };
    const map = {};
    for (const r of rows) {
      const code = pick(r, ['code', 'Код', 'id']);
      if (!code) continue;
      map[code] = pick(r, ['name', 'Наименование']) || code;
    }
    return { map };
  });
  return (res && res.map) || {};
}

// Карта товаров: productCode -> { name, group(розничная НоменклатурнаяГруппа) }
async function getProductMap(period) {
  const res = await mapCache.wrap('pmap:' + period, async () => {
    const pull = await callPull(period);
    const prods = (pull && pull.products) || [];
    const pick = (p, keys) => { for (const k of keys) { const v = p[k]; if (v != null && String(v).trim()) return String(v).trim(); } return ''; };
    const map = {};
    for (const p of prods) {
      const code = pick(p, ['id', 'code', 'Код', 'Артикул']);
      if (!code) continue;
      map[code] = {
        name: pick(p, ['name', 'Наименование', 'НаименованиеДляСайта', 'НаименованиеПолное']) || code,
        group: pick(p, ['group', 'НоменклатурнаяГруппа', 'Группа', 'category']) || '—'
      };
    }
    return { map };
  });
  return (res && res.map) || {};
}

function prevYearYM(ym) {
  const [y, m] = ym.split('-');
  return `${Number(y) - 1}-${m}`;
}

function deltaPct(cur, prev) {
  if (!prev) return null;            // нет базы (напр. год назад программы не было)
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

// Кэшированная обёртка над агрегатами per-month (24ч). Прошлые месяцы не меняются;
// текущий месяц обновится не дольше чем через сутки.
async function aggSales(period) {
  return monthCache.wrap('agg:' + period, () => _aggSalesUncached(period));
}

// Агрегаты продаж за период из sales-detail (по чекам + по товарам + по точкам, в одном проходе)
async function _aggSalesUncached(period) {
  const d = await callSalesDetail(period);
  const rows = d.rows || [];
  const cheque = new Map(); // chequeNo -> { sum, hasCard, store }
  const products = new Map(); // productCode -> { sum, qty }
  const storeAcc = new Map(); // storeCode -> { revenue, cheques(Set), withCard(Set), bonus }
  let bonus = 0;
  for (const r of rows) {
    const cn = r.chequeNo;
    const sc = String(r.storeCode || '').trim();
    if (cn) {
      if (!cheque.has(cn)) cheque.set(cn, { sum: 0, hasCard: false, store: sc });
      const c = cheque.get(cn);
      c.sum += parseRu(r.sum);
      if (String(r.cardCode || '').trim()) c.hasCard = true;
      if (sc && !c.store) c.store = sc;
    }
    const rowSum = parseRu(r.sum);
    const rowBonus = parseRu(r.payBonus);
    bonus += rowBonus;
    if (sc) {
      if (!storeAcc.has(sc)) storeAcc.set(sc, { revenue: 0, cheques: new Set(), withCard: new Set(), bonus: 0 });
      const s = storeAcc.get(sc);
      s.revenue += rowSum; s.bonus += rowBonus;
      if (cn) { s.cheques.add(cn); if (String(r.cardCode || '').trim()) s.withCard.add(cn); }
    }
    const pc = String(r.productCode || '').trim();
    if (pc) {
      if (!products.has(pc)) products.set(pc, { sum: 0, qty: 0 });
      const p = products.get(pc); p.sum += parseRu(r.sum); p.qty += parseRu(r.qty);
    }
  }
  let revenue = 0, withCard = 0;
  for (const c of cheque.values()) { revenue += c.sum; if (c.hasCard) withCard += 1; }
  const cheques = cheque.size;
  // финализируем byStore: Set'ы -> числа
  const byStore = new Map();
  for (const [sc, s] of storeAcc) {
    const ch = s.cheques.size;
    byStore.set(sc, {
      revenue: Math.round(s.revenue),
      cheques: ch,
      avgCheck: ch ? Math.round(s.revenue / ch) : 0,
      cardPct: ch ? Math.round((s.withCard.size / ch) * 1000) / 10 : 0,
      bonus: Math.round(s.bonus)
    });
  }
  return {
    revenue: Math.round(revenue),
    cheques,
    avgCheck: cheques ? Math.round(revenue / cheques) : 0,
    cardPct: cheques ? Math.round((withCard / cheques) * 1000) / 10 : 0,
    bonus: Math.round(bonus),
    products,
    byStore
  };
}

// Сладкий чек за период: карты, баллы, разбивка по заданиям
async function aggSweet(period) {
  try {
    const d = await callRegister('СладкийЧек', period, period, 10000);
    const rows = d.rows || [];
    const cards = new Set(); let points = 0; const tasks = {};
    for (const r of rows) {
      if (r['БонуснаяКарта']) cards.add(r['БонуснаяКарта']);
      points += parseRu(r['Баллы']);
      const t = r['Задание'] || '?'; tasks[t] = (tasks[t] || 0) + 1;
    }
    return { cards: cards.size, points: Math.round(points), events: rows.length, tasks };
  } catch (e) { return { cards: 0, points: 0, events: 0, tasks: {}, error: e.message }; }
}

// Действующие промокоды (справочник Акции, фильтр по датам)
async function activePromos(asOf) {
  try {
    const d = await callCatalog('Акции', 2000);
    const today = asOf || new Date().toISOString().slice(0, 10);
    const out = [];
    for (const r of d.rows || []) {
      if (r['ЭтоГруппа'] || r['ПометкаУдаления']) continue;
      const start = String(r['ДатаНачала'] || '');
      const end = String(r['ДатаОкончания'] || '');
      if (end && end >= today && (!start || start <= today)) {
        out.push({ name: String(r['Наименование'] || '').trim(), start, end });
      }
    }
    out.sort((a, b) => (a.end < b.end ? -1 : 1));
    return out;
  } catch (e) { return [{ error: e.message }]; }
}

// Список месяцев от Январь прошлого года до выбранного включительно.
// Для 2026-05 даёт 17 точек: 2025-01..2025-12 + 2026-01..2026-05.
// Используется для трендового графика «полная динамика» c YoY-сериями.
function monthsExtendedSeries(period) {
  const [y, m] = period.split('-').map(Number);
  const out = [];
  for (let yy = y - 1; yy <= y; yy++) {
    const lastM = (yy === y) ? m : 12;
    for (let mm = 1; mm <= lastM; mm++) out.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return out;
}

// Облегчённая выжимка из агрегата (для трендового графика — без products/byStore)
function headline(ym, agg) {
  return { ym, revenue: agg.revenue, cheques: agg.cheques, avgCheck: agg.avgCheck, cardPct: agg.cardPct, bonus: agg.bonus };
}

async function compute(period) {
  const py = prevYearYM(period);
  // Расширенное окно: с янв прошлого года по выбранный месяц. Для 2026-05 → 17 точек.
  // YoY-серию фронт построит сам как cur[i-12] — это экономит 17 лишних запросов к 1С.
  const curMonths = monthsExtendedSeries(period);

  // 1С отдаёт один месяц за ~100с. Поэтому 17 точек тянуть синхронно нельзя — TTFB упадёт в 502.
  // Вместо этого собираем серию из того что лежит в кэше СЕЙЧАС, а недостающие месяцы пинаем
  // в фон без await (aggSales кэширован per-month с дедупом одновременных запросов).
  const [cur, prev, sweetCur, sweetPrev, promos, pmap, smap] = await Promise.all([
    aggSales(period), aggSales(py), aggSweet(period), aggSweet(py), activePromos(), getProductMap(period), getStoreMap()
  ]);
  const curSeries = [];
  for (const ym of curMonths) {
    const cached = monthCache.getCached('agg:' + ym);
    if (cached) {
      curSeries.push(headline(ym, cached));
    } else {
      // плейсхолдер; фронт нарисует пробел/«н/д» в этой точке, при следующем обновлении она появится
      curSeries.push({ ym, revenue: null, cheques: null, avgCheck: null, cardPct: null, bonus: null, _pending: true });
      if (!monthCache.isPending('agg:' + ym)) {
        // пинаем фоновый прогрев — не ждём; в логах увидим «warm agg:ym» через ~100с
        aggSales(ym).then(() => console.log(`[marketing-channels] warm ${ym}`)).catch(e => console.log(`[marketing-channels] warm ${ym} fail: ${e.message}`));
      }
    }
  }
  // prevSeries = cur со сдвигом 12: для cur[12]..cur[N-1] это cur[0]..cur[N-13]; для остального — null.
  const ymIndex = new Map(curSeries.map((m, i) => [m.ym, i]));
  const prevSeries = curSeries.map(m => {
    const py12 = prevYearYM(m.ym);
    const i = ymIndex.get(py12);
    return i != null ? curSeries[i] : null;
  });
  const M = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const metric = (k) => ({ cur: cur[k], prev: prev[k], deltaPct: deltaPct(cur[k], prev[k]) });

  // Топ-15 товаров за месяц (по выручке) с именами
  const topProducts = [...cur.products.entries()]
    .map(([code, v]) => ({ name: (pmap[code] && pmap[code].name) || code, revenue: Math.round(v.sum), qty: Math.round(v.qty) }))
    .filter(p => p.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue).slice(0, 15);

  // Категории (розничная группа) за месяц + YoY
  const byGroup = (prodMap) => {
    const g = {};
    for (const [code, v] of prodMap) { const grp = (pmap[code] && pmap[code].group) || '—'; g[grp] = (g[grp] || 0) + v.sum; }
    return g;
  };
  const cg = byGroup(cur.products), pg = byGroup(prev.products);
  const totalCur = Object.values(cg).reduce((s, x) => s + x, 0) || 1;
  const categories = Object.keys(cg)
    .map(grp => ({ group: grp, cur: Math.round(cg[grp]), prev: Math.round(pg[grp] || 0), sharePct: Math.round(cg[grp] / totalCur * 1000) / 10, deltaPct: deltaPct(cg[grp], pg[grp] || 0) }))
    .filter(c => c.cur > 0)
    .sort((a, b) => b.cur - a.cur).slice(0, 15);

  // По точкам: сводим cur+prev в строки, объединяем имена из smap, сортируем по выручке
  const storeCodes = new Set([...cur.byStore.keys(), ...prev.byStore.keys()]);
  const byStore = [...storeCodes].map(code => {
    const c = cur.byStore.get(code) || { revenue: 0, cheques: 0, avgCheck: 0, cardPct: 0, bonus: 0 };
    const pp = prev.byStore.get(code) || { revenue: 0, cheques: 0, avgCheck: 0, cardPct: 0, bonus: 0 };
    return {
      code, name: smap[code] || code,
      revenue: { cur: c.revenue, prev: pp.revenue, deltaPct: deltaPct(c.revenue, pp.revenue) },
      cheques: { cur: c.cheques, prev: pp.cheques, deltaPct: deltaPct(c.cheques, pp.cheques) },
      avgCheck: { cur: c.avgCheck, prev: pp.avgCheck, deltaPct: deltaPct(c.avgCheck, pp.avgCheck) },
      cardPct: { cur: c.cardPct, prev: pp.cardPct, deltaPp: Math.round((c.cardPct - pp.cardPct) * 10) / 10 },
      bonus: c.bonus
    };
  })
  .filter(r => r.revenue.cur > 0 || r.revenue.prev > 0)
  .sort((a, b) => (b.revenue.cur || 0) - (a.revenue.cur || 0));

  return {
    period, periodYoY: py,
    monthName: M[Number(period.split('-')[1])],
    revenue: metric('revenue'),
    cheques: metric('cheques'),
    avgCheck: metric('avgCheck'),
    cardPct: { cur: cur.cardPct, prev: prev.cardPct, deltaPp: Math.round((cur.cardPct - prev.cardPct) * 10) / 10 },
    bonus: metric('bonus'),
    byStore,
    monthlySeries: { cur: curSeries, prev: prevSeries },
    sweet: {
      cur: { cards: sweetCur.cards, points: sweetCur.points, events: sweetCur.events, tasks: sweetCur.tasks },
      prev: { cards: sweetPrev.cards, points: sweetPrev.points },
      isNew: sweetPrev.cards === 0 && sweetPrev.points === 0
    },
    promos,
    topProducts,
    categories,
    external: {
      gis: readExternal('2gis.json'),
      direct: readExternal('direct.json'),
      metrika: readExternal('metrika.json'),
      seo: readExternal('seo.json'),
      prices: readExternal('prices.json'),
      social: readExternal('social.json')
    },
    refreshedAt: new Date().toISOString()
  };
}

function getChannels(period) {
  const p = period || nowYM();
  return cache.wrap('ch:' + p, () => compute(p));
}

// Фоновый прогрев кэша (вызывается из server.js по интервалу).
// ВАЖНО: через getChannels (cache.wrap), а не compute напрямую — иначе кэш не наполнится.
async function warm(period) {
  try { await getChannels(period || nowYM()); return true; } catch (e) { return false; }
}

// Прогрев расширенной серии: 17 месяцев с янв пред.года по выбранный включительно.
// Запускается фоном при старте сервера + раз в сутки, чтобы при открытии дашборда
// monthlySeries уже была наполнена. ~100с на месяц × 17 ≈ 30 минут, последовательно.
async function warmExtendedSeries(period) {
  const months = monthsExtendedSeries(period || nowYM());
  let ok = 0, fail = 0;
  for (const ym of months) {
    try { await aggSales(ym); ok++; } catch (e) { fail++; console.log(`[marketing-channels] warm-ext ${ym} fail: ${e.message}`); }
  }
  console.log(`[marketing-channels] warm-ext done: ok=${ok} fail=${fail} months=${months.length}`);
  return { ok, fail, total: months.length };
}

module.exports = { getChannels, warm, warmExtendedSeries, _compute: compute };
