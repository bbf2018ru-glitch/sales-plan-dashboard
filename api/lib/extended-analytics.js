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

const {
  hasBase,
  parseRu,
  parseRuDate,
  prevMonth,
  rangeMonths,
  callRegister,
  callDocument,
  makeCache,
  nowYM
} = require('./upp-client');

const cache = makeCache(5 * 60 * 1000);
// 24-час кэш per-month уникальных карт (Set). Прошлые месяцы не меняются — большие TTL ок.
const monthCardsCache = makeCache(24 * 60 * 60 * 1000);

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

// Получает уникальные карты, активные в месяце ym (через регистр «Бонусы»).
// Кэшируется per-month (24ч) — прошлые месяцы не меняются.
async function getMonthCards(ym) {
  return monthCardsCache.wrap('cards:' + ym, async () => {
    const set = new Set();
    try {
      const d = await callRegister('Бонусы', ym, ym, 999);
      for (const r of d.rows || []) {
        const card = (r['БонуснаяКарта'] || '').trim();
        if (card) set.add(card);
      }
    } catch (e) {
      return { cards: Array.from(set), _err: e.message };
    }
    return { cards: Array.from(set) };
  });
}

// Помесячно: новые карты в каждом месяце с янв пред.года по выбранный включительно.
// «Новая» = карта появилась впервые ИМЕННО в этом месяце (нет в предыдущих 12 мес и нет
// в более ранних месяцах того же ряда).
// Non-blocking: если месяц не в кэше — добавляет _pending плейсхолдер и греет фон.
async function buildNewCustomersMonthly(period) {
  const [y, m] = period.split('-').map(Number);
  // baseline 12 мес до янв пред.года (для отсечки «новых» от давних)
  const seriesMonths = [];
  for (let yy = y - 1; yy <= y; yy++) {
    const lastM = (yy === y) ? m : 12;
    for (let mm = 1; mm <= lastM; mm++) seriesMonths.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  // baseline: 12 мес до первого месяца ряда
  const baselineMonths = [];
  let bm = seriesMonths[0];
  for (let i = 0; i < 12; i++) { bm = prevMonth(bm); baselineMonths.unshift(bm); }

  // Собираем baseline из того что есть в кэше (синхронно). Недостающее греется фоном.
  const baselineCards = new Set();
  let baselinePending = 0;
  for (const ym of baselineMonths) {
    const c = monthCardsCache.getCached('cards:' + ym);
    if (c) {
      for (const card of c.cards || []) baselineCards.add(card);
    } else {
      baselinePending++;
      if (!monthCardsCache.isPending('cards:' + ym)) {
        getMonthCards(ym).then(() => console.log(`[new-customers] warm baseline ${ym}`)).catch(() => {});
      }
    }
  }

  // Серия по месяцам периода
  const series = [];
  const seenCards = new Set(baselineCards); // карты которые уже встречались
  let seriesPending = 0;
  for (const ym of seriesMonths) {
    const c = monthCardsCache.getCached('cards:' + ym);
    if (!c) {
      series.push({ ym, newCards: null, activeCards: null, _pending: true });
      seriesPending++;
      if (!monthCardsCache.isPending('cards:' + ym)) {
        getMonthCards(ym).then(() => console.log(`[new-customers] warm series ${ym}`)).catch(() => {});
      }
      continue;
    }
    let newInMonth = 0;
    for (const card of c.cards || []) {
      if (!seenCards.has(card)) { newInMonth++; seenCards.add(card); }
    }
    series.push({ ym, newCards: newInMonth, activeCards: (c.cards || []).length });
  }
  return {
    period,
    range: { from: seriesMonths[0], to: seriesMonths[seriesMonths.length - 1] },
    baseline: { months: baselineMonths.length, pending: baselinePending, knownCards: baselineCards.size },
    series,
    seriesPending
  };
}

// Per-month UDS-промокоды (для матрицы «месяц × код»). Кэш 24ч.
const promoMonthCache = makeCache(24 * 60 * 60 * 1000);

async function getUdsMonthlyAggregate(ym) {
  return promoMonthCache.wrap('uds:' + ym, async () => {
    const codes = new Map(); // code → { uses, revenue, bonusUsed }
    try {
      // 1) Получаем чеки с UDS-кодом
      const d = await callDocument('ЧекККМ', ym, ym, 999);
      const rows = d.rows || [];
      const truncated = rows.length >= 999;
      const chequeByNum = new Map(); // Номер → code
      for (const r of rows) {
        const code = (r['uds_КодСкидки'] || '').trim();
        const num = (r['Номер'] || '').trim();
        if (!code) continue;
        const sum = parseRu(r['СуммаДокумента']) || 0;
        if (!codes.has(code)) codes.set(code, { code, uses: 0, revenue: 0, bonusUsed: 0 });
        const c = codes.get(code); c.uses += 1; c.revenue += sum;
        if (num) chequeByNum.set(num, code);
      }
      // 2) Подтягиваем расход = оплата бонусами по тем же чекам (из marketing-channels кэша)
      // Если aggSales уже в кэше — используем без запроса; иначе ничего не считаем для bonus
      try {
        const mc = require('./marketing-channels')._internal;
        const cached = mc.monthCache.getCached('agg:' + ym);
        if (cached && cached.chequeBonus) {
          for (const [num, code] of chequeByNum) {
            const b = cached.chequeBonus.get(num);
            if (b) codes.get(code).bonusUsed += b;
          }
        }
      } catch (_) { /* mc недоступен */ }
      return { codes: Array.from(codes.values()), truncated };
    } catch (e) { return { codes: [], _err: e.message }; }
  });
}

// Помесячная детализация UDS-промокодов: код × месяц × uses × revenue.
// Non-blocking — что в кэше отдаём, недостающее греется фоном.
async function buildPromoCodesMonthly(period) {
  const [y, m] = period.split('-').map(Number);
  const months = [];
  for (let yy = y - 1; yy <= y; yy++) {
    const lastM = (yy === y) ? m : 12;
    for (let mm = 1; mm <= lastM; mm++) months.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }

  // code → { totalUses, totalRevenue, byMonth: { ym → {uses, revenue} } }
  const codes = new Map();
  let pending = 0;
  for (const ym of months) {
    const c = promoMonthCache.getCached('uds:' + ym);
    if (!c) {
      pending++;
      if (!promoMonthCache.isPending('uds:' + ym)) {
        getUdsMonthlyAggregate(ym).then(() => console.log(`[promo-monthly] warm ${ym}`)).catch(() => {});
      }
      continue;
    }
    for (const row of c.codes || []) {
      if (!codes.has(row.code)) codes.set(row.code, { code: row.code, totalUses: 0, totalRevenue: 0, totalBonusUsed: 0, byMonth: {} });
      const e = codes.get(row.code);
      e.totalUses += row.uses;
      e.totalRevenue += row.revenue;
      e.totalBonusUsed += row.bonusUsed || 0;
      e.byMonth[ym] = { uses: row.uses, revenue: Math.round(row.revenue), bonusUsed: Math.round(row.bonusUsed || 0) };
    }
  }

  // Топ-50 по выручке + помесячная разбивка
  const arr = Array.from(codes.values()).sort((a, b) => b.totalRevenue - a.totalRevenue);
  return {
    period,
    range: { from: months[0], to: months[months.length - 1] },
    months,
    monthsPending: pending,
    totalCodes: arr.length,
    summary: {
      totalUses: arr.reduce((s, c) => s + c.totalUses, 0),
      totalRevenue: Math.round(arr.reduce((s, c) => s + c.totalRevenue, 0)),
      totalBonusUsed: Math.round(arr.reduce((s, c) => s + c.totalBonusUsed, 0))
    },
    codes: arr.slice(0, 50).map(c => ({
      code: c.code,
      totalUses: c.totalUses,
      totalRevenue: Math.round(c.totalRevenue),
      totalBonusUsed: Math.round(c.totalBonusUsed),
      avgTicket: c.totalUses ? Math.round(c.totalRevenue / c.totalUses) : 0,
      drrPct: c.totalRevenue ? Math.round((c.totalBonusUsed / c.totalRevenue) * 1000) / 10 : 0,
      byMonth: c.byMonth
    })),
    note: 'Расход = оплата бонусами в этих чеках (поле payBonus в ЧекККМ). Заполняется по мере прогрева кэша marketing-channels: для месяцев где основная серия ещё не прогрета, bonusUsed=0.'
  };
}

async function warmPromoCodesMonthly(period) {
  const p = period || nowYM();
  const [y, m] = p.split('-').map(Number);
  const months = [];
  for (let yy = y - 1; yy <= y; yy++) {
    const lastM = (yy === y) ? m : 12;
    for (let mm = 1; mm <= lastM; mm++) months.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  let ok = 0, fail = 0;
  for (const ym of months) {
    try { await getUdsMonthlyAggregate(ym); ok++; } catch { fail++; }
  }
  console.log(`[promo-monthly] warm done: ok=${ok} fail=${fail} months=${months.length}`);
  return { ok, fail, total: months.length };
}

// «Торт месяца» — автоопределение по всплеску продаж конкретного торта в каждом месяце
// vs его средняя за все 17 месяцев. Использует кэш marketing-channels (aggSales).
// Возвращает [{ ym, productCode, name, revenue, qty, ratio, categoryRevenue, sharePct }, ...]
async function buildCakeOfMonthSeries(period) {
  // Ленивый require — circular dependency safety
  const mc = require('./marketing-channels')._internal;
  const months = mc.monthsExtendedSeries(period);
  const pmap = await mc.getProductMap(period); // productCode → { name, group }

  // Собираем productCode → revenue по месяцам. Только товары из «тортовой» группы.
  const TORT_RE = /торт/i;
  const productMonthly = new Map(); // code → { name, byMonth: { ym → {revenue, qty} } }
  const monthData = [];             // [{ ym, ready, categoryRevenue }]
  for (const ym of months) {
    const cached = mc.monthCache.getCached('agg:' + ym);
    if (!cached) {
      monthData.push({ ym, ready: false });
      if (!mc.monthCache.isPending('agg:' + ym)) {
        mc.aggSales(ym).then(() => console.log(`[cake-of-month] warm agg ${ym}`)).catch(() => {});
      }
      continue;
    }
    let catRev = 0;
    for (const [code, v] of cached.products) {
      const meta = pmap[code];
      if (!meta) continue;
      // «Торт» определяем по группе товара или по имени
      const isTort = TORT_RE.test(meta.group || '') || TORT_RE.test(meta.name || '');
      if (!isTort) continue;
      catRev += v.sum || 0;
      if (!productMonthly.has(code)) productMonthly.set(code, { code, name: meta.name, byMonth: {} });
      productMonthly.get(code).byMonth[ym] = { revenue: v.sum || 0, qty: v.qty || 0 };
    }
    monthData.push({ ym, ready: true, categoryRevenue: Math.round(catRev) });
  }

  // Для каждого товара: avg выручка по доступным месяцам.
  const productAvg = new Map();
  for (const [code, p] of productMonthly) {
    const vals = Object.values(p.byMonth).map(v => v.revenue || 0);
    if (!vals.length) continue;
    productAvg.set(code, vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  // Для каждого месяца: ищем торт с наибольшим ratio = revenue[ym] / avgOverall.
  // Минимальный порог: revenue в этом месяце >= 50 000 ₽ (отсечь редко продаваемые товары).
  const series = monthData.map(md => {
    if (!md.ready) return { ym: md.ym, _pending: true };
    let best = null;
    for (const [code, p] of productMonthly) {
      const m = p.byMonth[md.ym];
      if (!m || m.revenue < 50000) continue;
      const avg = productAvg.get(code) || 1;
      const ratio = m.revenue / avg;
      if (!best || ratio > best.ratio) best = { code, name: p.name, revenue: Math.round(m.revenue), qty: Math.round(m.qty), ratio: Math.round(ratio * 100) / 100 };
    }
    if (!best) return { ym: md.ym, productCode: null, name: 'нет данных', revenue: 0, qty: 0, ratio: null, categoryRevenue: md.categoryRevenue };
    return {
      ym: md.ym,
      productCode: best.code,
      name: best.name,
      revenue: best.revenue,
      qty: best.qty,
      ratio: best.ratio,
      categoryRevenue: md.categoryRevenue,
      sharePct: md.categoryRevenue ? Math.round((best.revenue / md.categoryRevenue) * 1000) / 10 : null
    };
  });

  const pendingCount = series.filter(s => s._pending).length;
  return {
    period,
    method: 'auto: max(revenue/avg) среди тортов с месячной выручкой ≥50к',
    range: { from: months[0], to: months[months.length - 1] },
    series,
    seriesPending: pendingCount,
    productsConsidered: productMonthly.size
  };
}

// Прогрев per-month кэша карт для всей расширенной серии — фоном из server.js.
async function warmNewCustomersMonthly(period) {
  const p = period || nowYM();
  const [y, m] = p.split('-').map(Number);
  const months = [];
  // baseline 12 мес + series 17 мес = 29 месяцев
  let bm = `${y - 1}-01`;
  for (let i = 0; i < 12; i++) { bm = prevMonth(bm); months.unshift(bm); }
  for (let yy = y - 1; yy <= y; yy++) {
    const lastM = (yy === y) ? m : 12;
    for (let mm = 1; mm <= lastM; mm++) months.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  let ok = 0, fail = 0;
  for (const ym of months) {
    try { await getMonthCards(ym); ok++; }
    catch { fail++; }
  }
  console.log(`[new-customers] warm done: ok=${ok} fail=${fail} months=${months.length}`);
  return { ok, fail, total: months.length };
}

// ─── 2) Sales-kg ────────────────────────────────────────────────────────────
// БЛОКЕР: текущая BSL-версия /products-detail падает на поле
// `Н.БазоваяЕдиницаИзмерения.Коэффициент` — у Номенклатуры УПП Маши тип
// БазоваяЕдиницаИзмерения = КлассификаторЕдиницИзмерения, где нет Коэффициента
// (он только у Справочник.ЕдиницыИзмерения). Запрос /catalog тоже не работает
// (URL шаблон не зарегистрирован). Веса остаются недоступными.
//
// Альтернатива: реквизит `ф_ВесШтукивКг` (Число) у Справочник.Номенклатура
// есть и его можно использовать, но нужна BSL-правка `/products-detail`
// (убрать обращение к Коэффициенту).
//
// Пока возвращаем pending.
async function buildSalesKg(_db, _fromISO, _toISO) {
  return {
    available: false,
    pending: true,
    note: 'Веса в УПП Маши лежат в Справочник.Номенклатура.ф_ВесШтукивКг, но текущий BSL HTTP-сервиса (функция ВыполнитьProductsDetail, строка 421) обращается к несуществующему полю Н.БазоваяЕдиницаИзмерения.Коэффициент → 500. Откроется после правки BSL пользователем или Hellstaff (см. файл на Desktop: maria-dashboard-1c-webservice.bsl).'
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
// БЛОКЕР: РегистрНакопления.ВыпускПродукции в УПП Маши **пустой** (probe за
// 2026-04 вернул 0 строк) + веса по той же причине что в sales-kg недоступны.
// Возможно у Маши выпуск не отражается в этом регистре, либо данные пишутся
// в РегистрНакопления.Выпуск (без "Продукции") — нужно подтверждение от
// пользователя/Hellstaff где реально лежат данные о выпуске.
async function buildProductionKg(_fromYM, _toYM) {
  return {
    available: false,
    pending: true,
    note: 'РегистрНакопления.ВыпускПродукции в УПП Маши пустой (probe за 2026-04 → 0 строк). Нужно подтверждение пользователя/Hellstaff: в каком регистре реально лежат данные о выпуске? Кандидаты: РегистрНакопления.Выпуск, .ВыпускПродукцииНаработка. Также нужны веса (см. sales-kg).'
  };
}

// ─── 6) Top customers by revenue ────────────────────────────────────────────
// РегистрНакопления.ПродажиПоДисконтнымКартам — реальный оборот по карте.
// Поля: ДисконтнаяКарта, ВладелецДисконтнойКарты, Сумма, Период.
// Используется для топ-100 клиентов по выручке (не по бонусам).
async function buildTopCustomersByRevenue(fromYM, toYM) {
  const months = rangeMonths(fromYM, toYM);
  const byCard = new Map(); // card -> { card, owner, revenue, transactions }
  let totalRows = 0;
  let truncatedMonths = 0;

  for (const ym of months) {
    const d = await callRegister('ПродажиПоДисконтнымКартам', ym, ym, 999);
    const rows = d.rows || [];
    totalRows += rows.length;
    if (rows.length >= 999) truncatedMonths += 1;
    for (const r of rows) {
      const card = (r['ДисконтнаяКарта'] || '').trim();
      const owner = (r['ВладелецДисконтнойКарты'] || '').trim();
      const sum = parseRu(r['Сумма']);
      if (!card) continue;
      if (!byCard.has(card)) byCard.set(card, { card, owner, revenue: 0, transactions: 0 });
      const c = byCard.get(card);
      c.revenue += sum;
      c.transactions += 1;
    }
  }

  const arr = Array.from(byCard.values()).sort((a, b) => b.revenue - a.revenue);
  const totalRevenue = arr.reduce((s, c) => s + c.revenue, 0);
  return {
    period: { from: fromYM, to: toYM },
    totalCards: arr.length,
    totalTransactions: totalRows,
    totalRevenue: Number(totalRevenue.toFixed(2)),
    truncatedMonths,
    truncatedNote: truncatedMonths > 0
      ? `${truncatedMonths} из ${months.length} мес упёрлись в лимит 999 строк — данные могут быть неполными.`
      : null,
    topCards: arr.slice(0, 100).map(c => ({
      card: c.card,
      owner: c.owner,
      revenue: Number(c.revenue.toFixed(2)),
      transactions: c.transactions,
      avgTicket: Number((c.revenue / c.transactions).toFixed(2))
    }))
  };
}

// ─── 7) Скидки по акциям (промокоды) ────────────────────────────────────────
// У Маши «промокод» = название акции в Справочник.Акции (типа "Промокод СУШИ").
// В отчёте 1С «Скидки по акциям» эта связь идёт через ТЧ документа
// (Товары.ЗначениеУсловияАвтоматическойСкидки = ссылка на Акции).
//
// Текущий BSL /document отдаёт только реквизиты-шапки, до ТЧ не дотягивается.
// Поэтому пока строим частичный отчёт из РегистрНакопления.ПредоставленныеСкидки
// (условие `"По акции (ДК)"`) — даём документ/товар/сумму, но без имени акции.
// После добавления endpoint'а /promo-by-action в BSL — имена появятся.
async function buildPromoByAction(fromYM, toYM) {
  const months = rangeMonths(fromYM, toYM);
  const promoRows = [];
  let truncatedMonths = 0;

  for (const ym of months) {
    const d = await callRegister('ПредоставленныеСкидки', ym, ym, 999);
    const rows = d.rows || [];
    if (rows.length >= 999) truncatedMonths += 1;
    for (const r of rows) {
      const cond = (r['УсловиеСкидки'] || '').trim();
      if (!/акци/i.test(cond)) continue;
      promoRows.push({
        date: r['Период'] || '',
        product: (r['Номенклатура'] || '').trim() || '—',
        document: (r['ДокументСкидки'] || '').trim() || '—',
        store: (r['ПолучательСкидки'] || '').trim() || '—',
        condition: cond,
        sum: parseRu(r['СуммаСкидки'])
      });
    }
  }

  // Группировка по документу (один заказ/чек = одно «применение промокода»)
  const byDoc = new Map();
  for (const r of promoRows) {
    if (!byDoc.has(r.document)) byDoc.set(r.document, { document: r.document, date: r.date, store: r.store, products: [], totalSum: 0 });
    const e = byDoc.get(r.document);
    e.products.push({ product: r.product, sum: Number(r.sum.toFixed(2)) });
    e.totalSum += r.sum;
  }
  const docList = Array.from(byDoc.values())
    .sort((a, b) => b.totalSum - a.totalSum)
    .map(d => ({ ...d, totalSum: Number(d.totalSum.toFixed(2)), productCount: d.products.length }));

  return {
    period: { from: fromYM, to: toYM },
    totalApplications: promoRows.length,
    uniqueDocuments: byDoc.size,
    totalDiscountSum: Number(promoRows.reduce((s, r) => s + r.sum, 0).toFixed(2)),
    truncatedMonths,
    truncatedNote: truncatedMonths > 0
      ? `${truncatedMonths} из ${months.length} мес упёрлись в лимит 999 строк регистра — данные неполные.`
      : null,
    bslLimitNote: 'Имя конкретной акции (типа "Промокод СУШИ") пока не показывается — оно в ТЧ документа. Добавь endpoint /promo-by-action в BSL и здесь появится.',
    documents: docList.slice(0, 200)
  };
}

async function buildUdsPromoCodes(fromYM, toYM) {
  const months = rangeMonths(fromYM, toYM);
  const allCodes = []; // {code, date, doc, sum, store}
  let totalChecks = 0;
  let truncatedMonths = 0;

  for (const ym of months) {
    const d = await callDocument('ЧекККМ', ym, ym, 999);
    const rows = d.rows || [];
    totalChecks += rows.length;
    if (rows.length >= 999) truncatedMonths += 1;
    for (const r of rows) {
      const code = (r['uds_КодСкидки'] || '').trim();
      if (!code) continue;
      const sum = parseRu(r['СуммаДокумента']);
      allCodes.push({
        code,
        date: r['Дата'] || '',
        docNumber: r['Номер'] || '',
        store: (r['Склад'] || r['КассаККМ'] || '').toString(),
        sum: Number(sum.toFixed(2))
      });
    }
  }

  // Группируем по коду — обычно UDS-коды одноразовые, но всё равно агрегируем
  const byCode = new Map();
  for (const c of allCodes) {
    if (!byCode.has(c.code)) byCode.set(c.code, { code: c.code, uses: 0, totalSum: 0, firstDate: c.date, stores: new Set() });
    const e = byCode.get(c.code);
    e.uses += 1;
    e.totalSum += c.sum;
    if (c.store) e.stores.add(c.store);
  }

  return {
    period: { from: fromYM, to: toYM },
    totalChecksScanned: totalChecks,
    checksWithPromocode: allCodes.length,
    promocodeRate: totalChecks ? Number(((allCodes.length / totalChecks) * 100).toFixed(2)) : 0,
    uniqueCodes: byCode.size,
    truncatedMonths,
    truncatedNote: truncatedMonths > 0
      ? `${truncatedMonths} из ${months.length} мес упёрлись в лимит 999 чеков — данные неполные. После обновления BSL лимит поднимется.`
      : null,
    topCodes: Array.from(byCode.values())
      .sort((a, b) => b.totalSum - a.totalSum || b.uses - a.uses)
      .slice(0, 50)
      .map(e => ({
        code: e.code,
        uses: e.uses,
        totalSum: Number(e.totalSum.toFixed(2)),
        stores: e.stores.size,
        firstDate: e.firstDate
      })),
    recentApplications: allCodes
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 100)
  };
}

// ─── Внешние обёртки с кешированием ─────────────────────────────────────────

const cached = (key, fn) => cache.wrap(key, fn);
const BASE = () => hasBase();

async function getCustomersRetention(opts = {}) {
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
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

// Помесячная детализация UDS-промокодов. Non-blocking.
async function getPromoCodesMonthly(opts = {}) {
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const period = opts.period || nowYM();
  return cached(`promo-monthly:${period}`, async () => {
    try {
      return { available: true, ...(await buildPromoCodesMonthly(period)) };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
}

// «Торт месяца» помесячно (автоопределение). Non-blocking — что в кэше отдаём.
async function getCakeOfMonthSeries(opts = {}) {
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const period = opts.period || nowYM();
  return cached(`cake-of-month:${period}`, async () => {
    try {
      return { available: true, ...(await buildCakeOfMonthSeries(period)) };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
}

// Помесячно: новые карты с янв пред.года по выбранный месяц. Non-blocking — что в кэше отдаём,
// остальное греется фоном. Внешний рендер фильтрует _pending точки.
async function getNewCustomersMonthly(opts = {}) {
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const period = opts.period || nowYM();
  // cache 5 мин — чтобы при «греется фоном» подхватывать новые точки быстро
  return cached(`new-customers-monthly:${period}`, async () => {
    try {
      return { available: true, ...(await buildNewCustomersMonthly(period)) };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
}

async function getSalesKg(db, opts = {}) {
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
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
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
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
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
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

async function getUdsPromoCodes(opts = {}) {
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const fromYM = opts.from || nowYM();
  const toYM = opts.to || fromYM;
  return cached(`uds:${fromYM}:${toYM}`, async () => {
    try {
      return { available: true, ...(await buildUdsPromoCodes(fromYM, toYM)) };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
}

async function getPromoByAction(opts = {}) {
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const fromYM = opts.from || nowYM();
  const toYM = opts.to || fromYM;
  return cached(`promoaction:${fromYM}:${toYM}`, async () => {
    try {
      return { available: true, ...(await buildPromoByAction(fromYM, toYM)) };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
}

async function getTopCustomersByRevenue(opts = {}) {
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const fromYM = opts.from || nowYM();
  const toYM = opts.to || fromYM;
  return cached(`topcust:${fromYM}:${toYM}`, async () => {
    try {
      return { available: true, ...(await buildTopCustomersByRevenue(fromYM, toYM)) };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
}

module.exports = {
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
};
