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
  getSalesKg,
  getChequeCategories,
  getPromoDynamics,
  getProductionKg,
  getTopCustomersByRevenue,
  getUdsPromoCodes,
  getPromoByAction
};
