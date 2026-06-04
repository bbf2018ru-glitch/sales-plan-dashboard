// Маркетинг «по каналам» — живые данные из 1С за месяц + тот же месяц год назад (YoY).
// Источник: HTTP-сервис 1С УПП (sales-detail, register СладкийЧек, catalog Акции).
// Кэш + фоновое обновление в server.js делают данные свежими 24/7 без участия ПК.

const fs = require('fs');
const { callSalesDetail, callRegister, callCatalog, callPull, callStoresDetail, callQuery, parseRu, parseRuDate, nowYM, makeCache } = require('./upp-client');

// Данные не-1С источников (2ГИС/Директ/Метрика) пишутся скрейперами по cron
// в /opt/marketing-data/*.json. API только читает их (без скрейпинга в рантайме).
const EXT_DIR = process.env.MARKETING_DATA_DIR || '/opt/marketing-data';
function readExternal(file) {
  try { return JSON.parse(fs.readFileSync(EXT_DIR + '/' + file, 'utf8')); }
  catch (_) { return null; }
}

const cache = makeCache(6 * 60 * 60 * 1000, 'mkt-channels');     // 6 часов — основной расчёт (персистентно: HTTP-ответ JSON-safe)
const mapCache = makeCache(24 * 60 * 60 * 1000, 'mkt-maps'); // 24 часа — карты товаров/точек (плоские объекты)
// monthCache НЕ персистим: агрегаты содержат Map (byStore/products) — JSON-roundtrip превратит в {} и сломает .get()
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

// Нетто-выручка = Σ ЧекККМ.СуммаДокумента (продажа) − Σ СуммаДокумента (возврат), по Склад.Код.
// ВАЖНО: sales-detail суммирует Товары.Сумма — это БРУТТО (до вычета оплаты бонусами и
// подарочными сертификатами) И прибавляет возвраты как плюс, поэтому завышает выручку на
// ~5%. СуммаДокумента = реально оплачено = Товары.Сумма − ОплатаБонусами − ОплатаСертификатами
// (проверено: совпадает с план/факт дашборда до рубля по каждой точке). Запрос лёгкий —
// агрегат в 1С, на выходе ~20 строк (точка×ВидОперации).
async function netRevenueByStore(period) {
  const [y, m] = period.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const q = 'ВЫБРАТЬ Чек.Склад.Код КАК Код, Чек.ВидОперации КАК Вид,'
    + ' СУММА(ЕСТЬNULL(Чек.СуммаДокумента,0)) КАК Выручка, КОЛИЧЕСТВО(Чек.Ссылка) КАК Чеков'
    + ' ИЗ Документ.ЧекККМ КАК Чек'
    + ` ГДЕ Чек.Дата >= ДАТАВРЕМЯ(${y},${m},1) И Чек.Дата < ДАТАВРЕМЯ(${ny},${nm},1) И Чек.Проведен`
    + ' СГРУППИРОВАТЬ ПО Чек.Склад.Код, Чек.ВидОперации';
  const r = await callQuery(q, { timeoutMs: 100000 });
  const byStore = new Map(); // код → { revenue, cheques }  (нетто продажа−возврат)
  let revenue = 0, cheques = 0;
  for (const row of (r.rows || [])) {
    const code = String(row['Код'] || '').trim();
    const isReturn = /возврат/i.test(String(row['Вид'] || ''));
    const sum = parseRu(row['Выручка']);
    const cnt = parseRu(row['Чеков']);
    if (!byStore.has(code)) byStore.set(code, { revenue: 0, cheques: 0 });
    const s = byStore.get(code);
    if (isReturn) { s.revenue -= sum; revenue -= sum; }       // возврат уменьшает выручку
    else { s.revenue += sum; s.cheques += cnt; revenue += sum; cheques += cnt; } // чеки = только продажи
  }
  return { revenue: Math.round(revenue), cheques, byStore };
}

// Агрегаты продаж за период из sales-detail (по чекам + по товарам + по точкам, в одном проходе)
async function _aggSalesUncached(period) {
  const d = await callSalesDetail(period);
  const rows = d.rows || [];
  const cheque = new Map(); // chequeNo -> { sum, hasCard, store, bonus }
  const products = new Map(); // productCode -> { sum, qty }
  const storeAcc = new Map(); // storeCode -> { revenue, cheques(Set), withCard(Set), bonus }
  let bonus = 0;
  for (const r of rows) {
    const cn = r.chequeNo;
    const sc = String(r.storeCode || '').trim();
    // НомерЧекаККМ НЕ уникален: повторяется между магазинами и сменами (сбрасывается
    // каждую смену). Ключ чека = магазин + номер + день, иначе разные чеки сливаются
    // в один → счётчик чеков занижен, а средний чек завышен.
    const day = String(r.date || '').slice(0, 10);
    const ck = cn ? (sc + '|' + cn + '|' + day) : '';
    if (ck) {
      if (!cheque.has(ck)) cheque.set(ck, { sum: 0, hasCard: false, store: sc, bonus: 0 });
      const c = cheque.get(ck);
      c.sum += parseRu(r.sum);
      c.bonus += parseRu(r.payBonus);
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
      if (ck) { s.cheques.add(ck); if (String(r.cardCode || '').trim()) s.withCard.add(ck); }
    }
    const pc = String(r.productCode || '').trim();
    if (pc) {
      if (!products.has(pc)) products.set(pc, { sum: 0, qty: 0 });
      const p = products.get(pc); p.sum += parseRu(r.sum); p.qty += parseRu(r.qty);
    }
  }
  // БРУТТО из sales-detail (Товары.Сумма) — оставляем ТОЛЬКО для cardPct (доля чеков с
  // картой) и подушки на случай сбоя нетто-запроса. Выручку/чеки берём из netRevenueByStore.
  let grossRevenue = 0, withCard = 0;
  for (const c of cheque.values()) { grossRevenue += c.sum; if (c.hasCard) withCard += 1; }
  const grossCheques = cheque.size;
  // cardPct (доля чеков с бонусной картой) — от sales-detail (на сумму не влияет, корректно).
  const cardPctByStore = new Map();
  for (const [sc, s] of storeAcc) {
    const ch = s.cheques.size;
    cardPctByStore.set(sc, {
      cardPct: ch ? Math.round((s.withCard.size / ch) * 1000) / 10 : 0,
      bonus: Math.round(s.bonus)
    });
  }
  // Нетто-выручка/чеки из ЧекККМ.СуммаДокумента (продажа−возврат) — авторитетный источник.
  let net = null;
  try { net = await netRevenueByStore(period); }
  catch (e) { console.log(`[marketing-channels] netRevenue ${period} fail: ${e.message}`); }
  const revenue = net ? net.revenue : Math.round(grossRevenue);
  const cheques = net ? net.cheques : grossCheques;
  const cardPctTotal = grossCheques ? Math.round((withCard / grossCheques) * 1000) / 10 : 0;
  // byStore: список точек — из нетто (чистый, без фантомов), карта/бонусы — из sales-detail.
  const byStore = new Map();
  const netStores = net ? net.byStore : new Map([...storeAcc].map(([sc, s]) => [sc, { revenue: Math.round(s.revenue), cheques: s.cheques.size }]));
  for (const [sc, ns] of netStores) {
    const extra = cardPctByStore.get(sc) || { cardPct: 0, bonus: 0 };
    byStore.set(sc, {
      revenue: Math.round(ns.revenue),
      cheques: ns.cheques,
      avgCheck: ns.cheques ? Math.round(ns.revenue / ns.cheques) : 0,
      cardPct: extra.cardPct,
      bonus: extra.bonus
    });
  }
  // chequeBonus: Map(chequeNo → суммарная оплата бонусами в этом чеке)
  // Используется в UDS-промокодах (extended-analytics.getUdsMonthlyAggregate) для расхода
  const chequeBonus = new Map();
  for (const [cn, c] of cheque) chequeBonus.set(cn, Math.round(c.bonus || 0));
  return {
    revenue,
    cheques,
    avgCheck: cheques ? Math.round(revenue / cheques) : 0,
    cardPct: cardPctTotal,
    bonus: Math.round(bonus),
    products,
    byStore,
    chequeBonus
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

// Карты лояльности (Справочник.ИнформационныеКарты): всего в базе + зарегистрировано
// за выбранный месяц (по ДатаКарты). Реальные регистрации в программе лояльности.
async function aggLoyaltyCards(period) {
  const [y, m] = period.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  try {
    const rt = await callQuery('ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Всего ИЗ Справочник.ИнформационныеКарты КАК К ГДЕ НЕ К.ПометкаУдаления И НЕ К.ЭтоГруппа', { timeoutMs: 60000 });
    const total = parseRu(((rt.rows || [])[0] || {})['Всего']) || 0;
    const rn = await callQuery(`ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Новых ИЗ Справочник.ИнформационныеКарты КАК К ГДЕ К.ДатаКарты >= ДАТАВРЕМЯ(${y},${m},1) И К.ДатаКарты < ДАТАВРЕМЯ(${ny},${nm},1) И НЕ К.ПометкаУдаления И НЕ К.ЭтоГруппа`, { timeoutMs: 60000 });
    const newThisMonth = parseRu(((rn.rows || [])[0] || {})['Новых']) || 0;
    return { total, newThisMonth };
  } catch (e) { return { total: null, newThisMonth: null, error: e.message }; }
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

// Использование акций — сколько людей пользовались и сколько купили.
// Главная механика в УПП Маши: акция → виртуальные карты (ИнформационныеКарты.Акция)
// → чеки с этой ДисконтнаяКарта. Поля ЧекККМ.КодСкидки/АкцияКодаСкидки в проде пустые
// (проверено probe 04.06.2026), прямое Ч.Акция — единицы чеков, кофе-бонус — АкцияКофеБонус.
// Окно: последние 92 дня (большинство акций короткие). Кэш 6ч — данные тяжёлые не по
// объёму, а по числу запросов к 1С.
const promoUsageCache = makeCache(6 * 60 * 60 * 1000, 'promo-usage');
async function promoUsage() {
  return promoUsageCache.wrap('all', async () => {
    const since = new Date(Date.now() - 92 * 24 * 3600 * 1000);
    const DT = `ДАТАВРЕМЯ(${since.getFullYear()},${since.getMonth() + 1},${since.getDate()})`;
    const P = `Ч.Проведен И Ч.Дата >= ${DT}`;
    const usage = new Map(); // name → {cheques, buyers, revenue, coffee, cardsTotal}
    const get = (name) => {
      if (!usage.has(name)) usage.set(name, { cheques: 0, buyers: 0, revenue: 0, coffee: 0, cardsTotal: 0 });
      return usage.get(name);
    };
    // 1) Чеки по виртуальным картам акций — основной канал применения
    const byCard = await callQuery(
      `ВЫБРАТЬ Ч.ДисконтнаяКарта.Акция.Наименование КАК Акция, КОЛИЧЕСТВО(*) КАК Чеков, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Ч.ДисконтнаяКарта) КАК Карт, СУММА(Ч.СуммаДокумента) КАК Выручка ИЗ Документ.ЧекККМ КАК Ч ГДЕ ${P} И Ч.ДисконтнаяКарта.Акция <> ЗНАЧЕНИЕ(Справочник.Акции.ПустаяСсылка) СГРУППИРОВАТЬ ПО Ч.ДисконтнаяКарта.Акция.Наименование`,
      { timeoutMs: 120000 });
    for (const r of byCard.rows || []) {
      const u = get(String(r['Акция'] || '').trim());
      u.cheques += parseRu(r['Чеков']) || 0;
      u.buyers += parseRu(r['Карт']) || 0;
      u.revenue += parseRu(r['Выручка']) || 0;
    }
    // 2) Прямая ссылка чека на акцию (редкая, но бывает — самовывоз-промокоды)
    const direct = await callQuery(
      `ВЫБРАТЬ Ч.Акция.Наименование КАК Акция, КОЛИЧЕСТВО(*) КАК Чеков, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Ч.ДисконтнаяКарта) КАК Карт, СУММА(Ч.СуммаДокумента) КАК Выручка ИЗ Документ.ЧекККМ КАК Ч ГДЕ ${P} И Ч.Акция <> ЗНАЧЕНИЕ(Справочник.Акции.ПустаяСсылка) СГРУППИРОВАТЬ ПО Ч.Акция.Наименование`,
      { timeoutMs: 120000 });
    for (const r of direct.rows || []) {
      const u = get(String(r['Акция'] || '').trim());
      u.cheques += parseRu(r['Чеков']) || 0;
      u.buyers += parseRu(r['Карт']) || 0;
      u.revenue += parseRu(r['Выручка']) || 0;
    }
    // 3) Кофе-бонус (штампики на стакан): чеки + количество кофе
    const coffee = await callQuery(
      `ВЫБРАТЬ Ч.АкцияКофеБонус.Наименование КАК Акция, КОЛИЧЕСТВО(*) КАК Чеков, СУММА(Ч.КоличествоКофеБонус) КАК Кофе, СУММА(Ч.СуммаДокумента) КАК Выручка ИЗ Документ.ЧекККМ КАК Ч ГДЕ ${P} И Ч.АкцияКофеБонус <> ЗНАЧЕНИЕ(Справочник.Акции.ПустаяСсылка) СГРУППИРОВАТЬ ПО Ч.АкцияКофеБонус.Наименование`,
      { timeoutMs: 120000 });
    for (const r of coffee.rows || []) {
      const u = get(String(r['Акция'] || '').trim());
      u.cheques += parseRu(r['Чеков']) || 0;
      u.coffee += parseRu(r['Кофе']) || 0;
      u.revenue += parseRu(r['Выручка']) || 0;
    }
    // 4) Сколько карт создано по каждой акции (вся база — охват акции)
    const cards = await callQuery(
      `ВЫБРАТЬ К.Акция.Наименование КАК Акция, КОЛИЧЕСТВО(*) КАК Карт ИЗ Справочник.ИнформационныеКарты КАК К ГДЕ НЕ К.ПометкаУдаления И НЕ К.ЭтоГруппа И К.Акция <> ЗНАЧЕНИЕ(Справочник.Акции.ПустаяСсылка) СГРУППИРОВАТЬ ПО К.Акция.Наименование`,
      { timeoutMs: 120000 });
    for (const r of cards.rows || []) {
      get(String(r['Акция'] || '').trim()).cardsTotal = parseRu(r['Карт']) || 0;
    }
    return {
      sinceDate: since.toISOString().slice(0, 10),
      byPromo: [...usage.entries()].map(([name, u]) => ({ name, ...u, revenue: Math.round(u.revenue) }))
        .sort((a, b) => b.cheques - a.cheques),
    };
  });
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
  const [cur, prev, sweetCur, sweetPrev, promos, pmap, smap, loyaltyCards, promoUse] = await Promise.all([
    aggSales(period), aggSales(py), aggSweet(period), aggSweet(py), activePromos(), getProductMap(period), getStoreMap(), aggLoyaltyCards(period),
    promoUsage().catch(e => ({ error: e.message, byPromo: [] })),
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
    promoUsage: promoUse,
    loyaltyCards,
    topProducts,
    categories,
    external: externalBlock(),
    refreshedAt: new Date().toISOString()
  };
}

// Поисковые запросы 2ГИС («Спрос») — из секции demand в 2gis-all-sections.json
// (скрейп scrape-mkt.js, cron daily). Строки head вида «<запрос>\t<доля>%».
function parseGisDemand() {
  const all = readExternal('2gis-all-sections.json');
  const head = all && all.demand && Array.isArray(all.demand.head) ? all.demand.head : null;
  if (!head) return null;
  const queries = [];
  let period = null;
  for (const line of head) {
    const mp = /^([А-ЯЁ][а-яё]+\s+\d{4})$/.exec(String(line).trim()); // «Май 2026»
    if (mp && !period) period = mp[1];
    const mr = /^(\d{2}\.\d{2}\.\d{4}\s*[–-]\s*\d{2}\.\d{2}\.\d{4})$/.exec(String(line).trim());
    if (mr) period = mr[1];
    const m = /^(.+?)\t\s*([\d.,]+)\s*%$/.exec(String(line));
    if (m) {
      const pct = parseFloat(m[2].replace(',', '.'));
      if (isFinite(pct)) queries.push({ q: m[1].trim(), pct });
    }
  }
  if (!queries.length) return null;
  return { period, queries, scrapedAt: all.scrapedAt || null };
}

// Внешние JSON от скрейперов (2ГИС/Директ/Метрика/…) — дешёвые чтения файлов.
// Читаем ВНЕ 6-часового кэша getChannels, чтобы обновления скрейперов (cron)
// появлялись в дашборде сразу, а не через TTL.
function externalBlock() {
  return {
    gis: readExternal('2gis.json'),
    gisHistory: readExternal('2gis-history.json'),
    gisDemand: parseGisDemand(),
    gisCompetitors: readExternal('competitors-2gis.json'),
    direct: readExternal('direct.json'),
    directHistory: readExternal('direct-history.json'),
    metrika: readExternal('metrika.json'),
    metrikaHistory: readExternal('metrika-history.json'),
    smsClicks: readExternal('sms-clicks.json'),
    seo: readExternal('seo.json'),
    prices: readExternal('prices.json'),
    social: readExternal('social.json'),
    bloggers: readExternal('bloggers.json'),
    partners: readExternal('partners.json')
  };
}

async function getChannels(period) {
  const p = period || nowYM();
  // cache.wrap — async, возвращает Promise. Без await Object.assign({}, Promise, ...)
  // отдавал бы {external:...} (у Promise нет own enumerable свойств), что и ломало
  // весь маркетинг-таб (revenue/cheques/cardPct/monthlySeries отсутствовали).
  const r = await cache.wrap('ch:' + p, () => compute(p));
  // external всегда свежий (мимо кэша) — перекрываем закэшированный снимок.
  return Object.assign({}, r, { external: externalBlock() });
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

// Внутренние API для других модулей (cake-of-month и т.п. читают наш кэш).
module.exports = {
  getChannels, warm, warmExtendedSeries, _compute: compute,
  _internal: { aggSales, getProductMap, monthCache, monthsExtendedSeries }
};
