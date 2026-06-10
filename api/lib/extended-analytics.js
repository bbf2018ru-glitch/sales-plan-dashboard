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
  callQuery,
  makeCache,
  nowYM
} = require('./upp-client');

const cache = makeCache(5 * 60 * 1000);
// 24-час кэш per-month уникальных карт. Прошлые месяцы не меняются — большие TTL ок.
// Персистентен (значения — плоские {cards: [строки]}): после деплоя когорты и
// «Новые карты» не ждут 30-мин прогрева 29 месяцев. Файл ~10МБ — терпимо.
const monthCardsCache = makeCache(24 * 60 * 60 * 1000, 'month-cards');

// ─── 1) Customers retention ─────────────────────────────────────────────────
// Считает: новых клиентов в периоде (первая активность карты попадает в from..to)
// vs постоянных (карта активна до from). Использует ретро 6 мес как baseline —
// если за 6 мес до from карта была — она «постоянная».
// Точный счёт без потолка строк. Раньше читали Бонусы по 5000 строк/мес и пересекали
// множества карт в JS — но в месяце ~10.8к карт > потолка, baseline за 6 мес тем более,
// так что new/returning молча считались на огрызке. Полные множества (>5000) через
// HTTP не вытащить (и /register, и /query_post режут до 5000). Зато КОЛИЧЕСТВО(РАЗЛИЧНЫЕ)
// дешёвое и точное → берём мощности множеств и считаем пересечение по формуле
// включения-исключения: |тек ∩ base| = |тек| + |base| − |тек ∪ base|.
function ymBound(ym, plus = 0) {
  let [y, m] = ym.split('-').map(Number);
  m += plus;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return `ДАТАВРЕМЯ(${y},${m},1)`;
}

async function buildCustomersRetention(fromYM, toYM) {
  // baseline: 6 месяцев до fromYM
  let baseFrom = fromYM;
  for (let i = 0; i < 6; i++) baseFrom = prevMonth(baseFrom);
  const baseTo = prevMonth(fromYM);

  const curStart = ymBound(fromYM);          // начало текущего периода
  const curEnd = ymBound(toYM, 1);           // начало месяца после toYM
  const baseStart = ymBound(baseFrom);       // начало baseline (= конец baseline это curStart)
  const distinct = (fromExpr, toExpr) => callQuery(
    `ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Б.БонуснаяКарта) КАК К ИЗ РегистрНакопления.Бонусы КАК Б`
    + ` ГДЕ Б.Период >= ${fromExpr} И Б.Период < ${toExpr}`, { timeoutMs: 60000 })
    .then(r => parseRu((r.rows || [])[0]?.['К']) || 0);

  let cur, base, union;
  try {
    [cur, base, union] = await Promise.all([
      distinct(curStart, curEnd),    // карты текущего периода
      distinct(baseStart, curStart), // карты baseline
      distinct(baseStart, curEnd),   // объединение (baseline ∪ текущий)
    ]);
  } catch (e) {
    return { period: { from: fromYM, to: toYM }, available: false, note: 'Источник 1С недоступен: ' + String(e.message || e).slice(0, 80) };
  }

  let returningCards = cur + base - union; // |тек ∩ base|
  if (returningCards < 0) returningCards = 0;
  if (returningCards > cur) returningCards = cur;
  const newCards = cur - returningCards;
  const total = cur;
  return {
    available: true,
    period: { from: fromYM, to: toYM },
    baseline: { from: baseFrom, to: baseTo, totalCardsKnown: base },
    summary: {
      totalActiveCards: total,
      newCards,
      returningCards,
      newPct: total ? Number(((newCards / total) * 100).toFixed(1)) : 0,
      returningPct: total ? Number(((returningCards / total) * 100).toFixed(1)) : 0
    }
  };
}

// Получает уникальные карты, активные в месяце ym (через регистр «Бонусы»).
// Кэшируется per-month (24ч) — прошлые месяцы не меняются.
async function getMonthCards(ym) {
  return monthCardsCache.wrap('cards:' + ym, async () => {
    const set = new Set();
    try {
      const d = await callRegister('Бонусы', ym, ym, 5000);
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

// Синхронный доступ к картам месяца из кэша (+фоновый прогрев при промахе).
// Используется когортами в marketing-analytics — чтобы «новые карты» считались
// ОДНОЙ методикой с графиком «Новые карты лояльности» (baseline 12 мес).
function peekMonthCards(ym) {
  const c = monthCardsCache.getCached('cards:' + ym);
  if (c) return c;
  if (!monthCardsCache.isPending('cards:' + ym)) {
    getMonthCards(ym).then(() => console.log(`[month-cards] warm ${ym}`)).catch(() => {});
  }
  return null;
}

// Помесячно: новые/активные карты с янв пред.года по выбранный включительно.
// «Новая» = карта, чьё ПЕРВОЕ движение бонусов попало в этот месяц (МИНИМУМ(Период)).
// Считаем агрегацией в 1С: построчное чтение по 5000 строк/мес занижало (карт ~10.8к/мес),
// и «новизну» определяло на огрызке множеств. Теперь точно и cap-free.
async function buildNewCustomersMonthly(period) {
  const [y, m] = period.split('-').map(Number);
  const seriesMonths = [];
  for (let yy = y - 1; yy <= y; yy++) {
    const lastM = (yy === y) ? m : 12;
    for (let mm = 1; mm <= lastM; mm++) seriesMonths.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  const first = seriesMonths[0], last = seriesMonths[seriesMonths.length - 1];
  const seriesStart = ymBound(first);          // начало ряда
  const seriesEnd = ymBound(last, 1);          // месяц после последнего
  const DEEP = 'ДАТАВРЕМЯ(2020,1,1)';          // раньше старта регистра (12.2022) → истинное первое появление
  const TBL = 'РегистрНакопления.Бонусы КАК Б';
  const ymKey = (raw) => { const d = parseRuDate(raw); return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : null; };

  let actRows, newRows;
  try {
    [actRows, newRows] = await Promise.all([
      // активные карты по месяцам
      callQuery(`ВЫБРАТЬ НАЧАЛОПЕРИОДА(Б.Период, МЕСЯЦ) КАК М, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Б.БонуснаяКарта) КАК Акт`
        + ` ИЗ ${TBL} ГДЕ Б.Период >= ${seriesStart} И Б.Период < ${seriesEnd}`
        + ` СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(Б.Период, МЕСЯЦ)`, { timeoutMs: 90000 }),
      // новые карты по месяцу первого появления (МИНИМУМ Период по карте, скан с DEEP)
      callQuery(`ВЫБРАТЬ НАЧАЛОПЕРИОДА(Перв.Первая, МЕСЯЦ) КАК М, КОЛИЧЕСТВО(*) КАК Новых ИЗ`
        + ` (ВЫБРАТЬ Б.БонуснаяКарта КАК Карта, МИНИМУМ(Б.Период) КАК Первая ИЗ ${TBL}`
        + ` ГДЕ Б.Период >= ${DEEP} И Б.Период < ${seriesEnd} СГРУППИРОВАТЬ ПО Б.БонуснаяКарта) КАК Перв`
        + ` ГДЕ Перв.Первая >= ${seriesStart} СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(Перв.Первая, МЕСЯЦ)`, { timeoutMs: 120000 }),
    ]);
  } catch (e) {
    return { period, available: false, note: 'Источник 1С недоступен: ' + String(e.message || e).slice(0, 80) };
  }

  const actBy = new Map(), newBy = new Map();
  for (const r of actRows.rows || []) { const k = ymKey(r['М']); if (k) actBy.set(k, parseRu(r['Акт']) || 0); }
  for (const r of newRows.rows || []) { const k = ymKey(r['М']); if (k) newBy.set(k, parseRu(r['Новых']) || 0); }

  const series = seriesMonths.map(ym => ({ ym, newCards: newBy.get(ym) || 0, activeCards: actBy.get(ym) || 0 }));
  return {
    period,
    range: { from: first, to: last },
    baseline: { note: 'новизна = карта с первым в истории движением бонусов в этом месяце' },
    series,
    seriesPending: 0
  };
}

// Per-month UDS-промокоды (для матрицы «месяц × код»). Кэш 24ч.
const promoMonthCache = makeCache(24 * 60 * 60 * 1000);

async function getUdsMonthlyAggregate(ym) {
  return promoMonthCache.wrap('uds:' + ym, async () => {
    const codes = new Map(); // code → { uses, revenue, bonusUsed }
    try {
      // 1) Получаем чеки с UDS-кодом
      const d = await callDocument('ЧекККМ', ym, ym, 5000);
      const rows = d.rows || [];
      const truncated = rows.length >= 5000;
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

// «Торт месяца» — НАСТОЯЩАЯ акция Марии: на один торт встаёт скидка на весь месяц
// (механика подтверждена 04.06.2026 по РегистрНакопления.ПредоставленныеСкидки:
// топ-торт по сумме скидок доминирует с отрывом ×5+ и стоит 25-31 день — май
// «Банан-солёная карамель» 414к скидок/31д, дек-2025 «Красный бархат» 3.2М/25д,
// который автодетект по выручке вообще не видел).
//
// Источник торта = скидки 1С (а не всплеск выручки); продажи (выручка/шт) — факт
// из aggSales. Запрос скидок за прошлый месяц неизменен → дисковый кэш надолго.
const cakeDiscCache = makeCache(24 * 60 * 60 * 1000, 'cake-discounts');
const CAKE_SLICE_RE = /кусоч/i; // «… КУСОЧЕК» — тот же торт, не отдельный кандидат

// Топ тортов по сумме скидок за месяц: [{ name, discount, days }]
async function monthCakeDiscounts(ym) {
  const r = await cakeDiscCache.wrap('cd:' + ym, async () => {
    const [y, m] = ym.split('-').map(Number);
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const q = 'ВЫБРАТЬ ПЕРВЫЕ 8 П.Номенклатура КАК Т, СУММА(П.СуммаСкидки) КАК С,'
      + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ НАЧАЛОПЕРИОДА(П.Период,ДЕНЬ)) КАК Д'
      + ' ИЗ РегистрНакопления.ПредоставленныеСкидки КАК П'
      + ` ГДЕ П.Период >= ДАТАВРЕМЯ(${y},${m},1) И П.Период < ДАТАВРЕМЯ(${ny},${nm},1)`
      + ' И П.Номенклатура.Наименование ПОДОБНО "Торт%"'
      + ' СГРУППИРОВАТЬ ПО П.Номенклатура УПОРЯДОЧИТЬ ПО С УБЫВ';
    const res = await callQuery(q, { timeoutMs: 90000 });
    const rows = (res?.rows || []).map(r2 => ({
      name: String(r2['Т'] || '').trim(),
      discount: parseRu(r2['С']),
      days: parseRu(r2['Д'])
    }));
    return { rows };
  });
  return (r && r.rows) || [];
}

function normName(s) { return String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/g, ''); }

async function buildCakeOfMonthSeries(period) {
  // Ленивый require — circular dependency safety
  const mc = require('./marketing-channels')._internal;
  const months = mc.monthsExtendedSeries(period);
  const pmap = await mc.getProductMap(period); // productCode → { name, group }

  const TORT_RE = /торт/i;
  const now = new Date();
  const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const series = [];
  for (const ym of months) {
    const isCur = ym === curYM;
    // 1) ТОРТ МЕСЯЦА = топ по сумме скидок 1С за месяц (целый торт, не КУСОЧЕК).
    let rows;
    try {
      rows = await monthCakeDiscounts(ym);
    } catch (e) {
      series.push({ ym, name: null, error: 'скидки 1С: ' + String(e.message || e).slice(0, 80) });
      continue;
    }
    const cand = rows.find(r => !CAKE_SLICE_RE.test(r.name)) || null;
    // Акция должна СТОЯТЬ месяц: ≥15 дней (текущий месяц — почти все прошедшие дни).
    const minDays = isCur ? Math.max(1, Math.min(3, now.getDate() - 1)) : 15;
    const minDisc = isCur ? 5000 : 50000;
    if (!cand || cand.days < minDays || cand.discount < minDisc) {
      series.push({ ym, name: null, noFlagman: true });
      continue;
    }
    // КУСОЧЕК-вариант той же позиции — добавляем его скидку к акции.
    const baseNorm = normName(cand.name);
    let discountSum = cand.discount;
    for (const r of rows) {
      if (r === cand || !CAKE_SLICE_RE.test(r.name)) continue;
      if (normName(r.name.replace(/кусоч\w*/gi, '')) === baseNorm) discountSum += r.discount;
    }

    // 2) Факт продаж торта (целый + кусочек) из aggSales — если месяц прогрет.
    const cached = mc.monthCache.getCached('agg:' + ym);
    let revenue = null, qty = null, sharePct = null;
    if (cached) {
      // Карта товаров ЭТОГО месяца: сезонный торт (напр. декабрьский «Красный бархат»)
      // отсутствует в pmap текущего периода → его код не матчился и продажи были 0.
      let pmapM = pmap;
      try { pmapM = await mc.getProductMap(ym); } catch (_) { /* фоллбэк на общий pmap */ }
      let catRev = 0, rev = 0, q = 0;
      for (const [code, v] of cached.products) {
        const meta = pmapM[code] || pmap[code];
        if (!meta) continue;
        const nm = String(meta.name || '');
        if (!TORT_RE.test(nm) && !TORT_RE.test(meta.group || '')) continue;
        catRev += v.sum || 0;
        if (normName(nm.replace(/кусоч\w*/gi, '')) === baseNorm) { rev += v.sum || 0; q += v.qty || 0; }
      }
      revenue = Math.round(rev);
      qty = Math.round(q);
      sharePct = catRev ? Math.round((rev / catRev) * 1000) / 10 : null;
    } else if (!mc.monthCache.isPending('agg:' + ym)) {
      mc.aggSales(ym).then(() => console.log(`[cake-of-month] warm agg ${ym}`)).catch(() => {});
    }

    // Эффективный % скидки: скидки / полная цена (выручка уже СО скидкой).
    // Проверено: дек-2025 даёт 52.7% (в чеках реально стояло 50%), май-2026 ~22% (≈20%).
    const discountPct = (revenue != null && revenue + discountSum > 0)
      ? Math.round((discountSum / (revenue + discountSum)) * 1000) / 10
      : null;

    series.push({
      ym,
      name: cand.name,
      discount: Math.round(discountSum),
      discountDays: cand.days,
      discountPct,
      revenue, qty, sharePct,
      partialMonth: isCur || undefined,
      salesPending: cached ? undefined : true
    });
  }

  // Торт месяца — целый ВЕСОВОЙ торт: Количество в чеках = килограммы (qty=кг).
  // Чтобы показать и штуки, тянем вес одной штуки (ф_ВесШтукивКг) одним запросом и
  // оцениваем штуки = кг ÷ вес. (Подтверждено пробой 08.06: «Торт …» продаётся в «кг».)
  const cakeNames = [...new Set(series.filter(s => s.name && s.qty != null).map(s => s.name))];
  if (cakeNames.length) {
    try {
      const cond = cakeNames.map(n => `Н.Наименование = "${String(n).replace(/"/g, '')}"`).join(' ИЛИ ');
      const wd = await callQuery(`ВЫБРАТЬ ВЫРАЗИТЬ(Н.Наименование КАК СТРОКА(120)) КАК Тов, Н.ф_ВесШтукивКг КАК Вес ИЗ Справочник.Номенклатура КАК Н ГДЕ ${cond}`, { timeoutMs: 60000 });
      const wmap = {};
      for (const r of wd.rows || []) { const w = parseRu(r['Вес']); if (w > 0 && !wmap[String(r['Тов']).trim()]) wmap[String(r['Тов']).trim()] = w; }
      for (const s of series) {
        if (s.name && s.qty != null) {
          s.kg = s.qty;                                       // qty весового торта = килограммы
          const w = wmap[s.name];
          s.weightKg = w || null;
          s.units = w ? Math.round(s.qty / w) : null;         // ≈ штук (кг ÷ вес одной)
        }
      }
    } catch (_) { /* вес не критичен — останется только кг */ }
  }

  const salesPendingCount = series.filter(s => s.salesPending).length;
  return {
    period,
    method: 'торт месяца = торт с месячной скидкой в 1С (РегистрНакопления.ПредоставленныеСкидки, топ по сумме скидок, акция ≥15 дней); продажи — факт из чеков (целый торт весовой → продано в кг; штуки = кг ÷ вес одной)',
    range: { from: months[0], to: months[months.length - 1] },
    series,
    seriesPending: salesPendingCount,
    productsConsidered: series.filter(s => s.name).length
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
  // Агрегация В 1С (раньше читали 5000 строк/мес из ~16к → усечение). Два шага:
  // 1) топ-10 товаров по сумме скидки; 2) дневной ряд только для этих 10 (IN-список).
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const ny = tm === 12 ? ty + 1 : ty, nm = tm === 12 ? 1 : tm + 1;
  const WHERE = `П.Период >= ДАТАВРЕМЯ(${fy},${fm},1) И П.Период < ДАТАВРЕМЯ(${ny},${nm},1)`;
  const NAME = 'ВЫРАЗИТЬ(П.Номенклатура.Наименование КАК СТРОКА(60))';
  const TBL = 'РегистрНакопления.ПредоставленныеСкидки КАК П';

  const topRows = await callQuery(
    `ВЫБРАТЬ ПЕРВЫЕ 10 ${NAME} КАК Тов, СУММА(П.СуммаСкидки) КАК С ИЗ ${TBL} ГДЕ ${WHERE}`
    + ` СГРУППИРОВАТЬ ПО ${NAME} УПОРЯДОЧИТЬ ПО С УБЫВ`, { timeoutMs: 90000 });
  const topProducts = (topRows.rows || [])
    .map(r => ({ product: (r['Тов'] || '').trim() || '—', sum: Number((parseRu(r['С']) || 0).toFixed(2)) }))
    .filter(p => p.product && p.product !== '—');

  let series = [], days = [];
  if (topProducts.length) {
    // IN-список имён топ-10 (двоим кавычки внутри строкового литерала 1С)
    const inList = topProducts.map(p => `"${p.product.replace(/"/g, '""')}"`).join(', ');
    const dayRows = await callQuery(
      `ВЫБРАТЬ ${NAME} КАК Тов, НАЧАЛОПЕРИОДА(П.Период, ДЕНЬ) КАК День, СУММА(П.СуммаСкидки) КАК С`
      + ` ИЗ ${TBL} ГДЕ ${WHERE} И ${NAME} В (${inList})`
      + ` СГРУППИРОВАТЬ ПО ${NAME}, НАЧАЛОПЕРИОДА(П.Период, ДЕНЬ)`, { timeoutMs: 90000 });
    const seriesByDay = new Map(); // day(YYYY-MM-DD) -> Map(product -> sum)
    const daySet = new Set();
    for (const r of dayRows.rows || []) {
      const product = (r['Тов'] || '').trim();
      const d = parseRuDate(r['День']);
      const day = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : fromYM + '-01';
      daySet.add(day);
      if (!seriesByDay.has(day)) seriesByDay.set(day, new Map());
      seriesByDay.get(day).set(product, parseRu(r['С']));
    }
    days = Array.from(daySet).sort();
    series = topProducts.map(tp => ({
      product: tp.product,
      points: days.map(d => ({ day: d, sum: Number((seriesByDay.get(d)?.get(tp.product) || 0).toFixed(2)) }))
    }));
  }

  return {
    period: { from: fromYM, to: toYM },
    truncatedMonths: 0,
    truncatedNote: null, // агрегация в 1С — данные полные
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
  // Серверная группировка в 1С (а не построчное чтение callRegister с лимитом 5000):
  //  • даёт точные итоги по всем картам без обрезки;
  //  • ТИПЗНАЧЕНИЯ(Регистратор)=ЧекККМ снимает дубль — отпуск со склада ГП 1С проводит
  //    И Реализацией, И ЧекомККМ на ту же сумму, регистр иначе задваивает оборот/покупки.
  // Имя клиента уже содержится в Наименовании карты («КЛП 038231 Иванов И.И.») → owner не тянем.
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const ny = tm === 12 ? ty + 1 : ty;
  const nm = tm === 12 ? 1 : tm + 1;
  const DT = `ДАТАВРЕМЯ(${fy},${fm},1)`;
  const DTEND = `ДАТАВРЕМЯ(${ny},${nm},1)`;
  const WHERE = `П.Период >= ${DT} И П.Период < ${DTEND}`
    + ` И П.ДисконтнаяКарта <> ЗНАЧЕНИЕ(Справочник.ИнформационныеКарты.ПустаяСсылка)`
    + ` И ТИПЗНАЧЕНИЯ(П.Регистратор) = ТИП(Документ.ЧекККМ)`;

  // Берём с запасом (300), т.к. служебные/опт карты ниже отфильтруем в JS до 100.
  const [top, totals] = await Promise.all([
    callQuery(
      `ВЫБРАТЬ ПЕРВЫЕ 300 ВЫРАЗИТЬ(П.ДисконтнаяКарта.Наименование КАК СТРОКА(100)) КАК Карта,`
      + ` ВЫРАЗИТЬ(П.ДисконтнаяКарта.ВидДисконтнойКарты.Наименование КАК СТРОКА(50)) КАК Вид,`
      + ` СУММА(П.Сумма) КАК Сумма, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Регистратор) КАК Покупок`
      + ` ИЗ РегистрНакопления.ПродажиПоДисконтнымКартам КАК П ГДЕ ${WHERE}`
      + ` СГРУППИРОВАТЬ ПО ВЫРАЗИТЬ(П.ДисконтнаяКарта.Наименование КАК СТРОКА(100)),`
      + ` ВЫРАЗИТЬ(П.ДисконтнаяКарта.ВидДисконтнойКарты.Наименование КАК СТРОКА(50))`
      + ` УПОРЯДОЧИТЬ ПО Сумма УБЫВ`, { timeoutMs: 120000 }),
    callQuery(
      `ВЫБРАТЬ СУММА(П.Сумма) КАК Сумма, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.ДисконтнаяКарта) КАК Карт,`
      + ` КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Регистратор) КАК Покупок`
      + ` ИЗ РегистрНакопления.ПродажиПоДисконтнымКартам КАК П ГДЕ ${WHERE}`, { timeoutMs: 120000 }),
  ]);

  // Те же исключения, что в маркетинговом топе лояльности (marketing-analytics.js):
  // опт/корпоратив по виду карты + служебные/магазинные/безымянные по названию.
  const WHOLESALE_KINDS = /корпоратив|офис|привилег|оптов|промоакц/i;
  const INTERNAL_CARD = /магазин|склад|кондитерск|(^|\s)(нет|дс)(\s|$)/i;
  const NONAME = /^[а-яёa-z]{1,4}\d*\s+\d+\s*$/i;
  const arr = (top.rows || []).map(r => {
    const card = (r['Карта'] || '').trim();
    const kind = String(r['Вид'] || '').trim();
    const revenue = parseRu(r['Сумма']);
    const transactions = parseRu(r['Покупок']) || 0;
    return { card, kind, revenue, transactions };
  }).filter(c => c.card
    && !WHOLESALE_KINDS.test(c.kind)
    && !INTERNAL_CARD.test(c.card) && !NONAME.test(c.card)
  ).slice(0, 100);

  const t = (totals.rows || [])[0] || {};
  return {
    period: { from: fromYM, to: toYM },
    totalCards: parseRu(t['Карт']) || 0,
    totalTransactions: parseRu(t['Покупок']) || 0,
    totalRevenue: Number((parseRu(t['Сумма']) || 0).toFixed(2)),
    truncatedNote: null,
    topCards: arr.map(c => ({
      card: c.card,
      owner: '',
      revenue: Number(c.revenue.toFixed(2)),
      transactions: c.transactions,
      avgTicket: c.transactions ? Number((c.revenue / c.transactions).toFixed(2)) : 0
    }))
  };
}

// ─── 7) Скидки по акциям (промокоды) ────────────────────────────────────────
// «Акция» = элемент Справочник.Акции (типа "Кофе в подарок 3+1", "Промокод САМОВЫВОЗ",
// "Офис", "Студенческая карта"). Связь — в ТЧ документа: ЧекККМ.Товары.
// ЗначениеУсловияАвтоматическойСкидки → Справочник.Акции (доступно через /query_post,
// БЕЗ доработки BSL). Сумма скидки в самой ТЧ = 0, она в РегистрНакопления.ПредоставленныеСкидки
// → джойним регистр к ТЧ по (документ + номенклатура) и группируем по акции.
// Раньше тянули регистр по 5000 строк и фильтровали "По акции" в JS (усечение + без имён акций).
async function buildPromoByAction(fromYM, toYM) {
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const ny = tm === 12 ? ty + 1 : ty, nm = tm === 12 ? 1 : tm + 1;
  const DT = `ДАТАВРЕМЯ(${fy},${fm},1)`, DTEND = `ДАТАВРЕМЯ(${ny},${nm},1)`;
  const ACT = 'ВЫРАЗИТЬ(Т.ЗначениеУсловияАвтоматическойСкидки.Наименование КАК СТРОКА(80))';
  const NOTEMPTY = 'Т.ЗначениеУсловияАвтоматическойСкидки <> ЗНАЧЕНИЕ(Справочник.Акции.ПустаяСсылка)';
  const tchWhere = `Т.Ссылка.Дата >= ${DT} И Т.Ссылка.Дата < ${DTEND} И ${NOTEMPTY}`;

  let byAct, sumRows, totRows;
  try {
    [byAct, sumRows, totRows] = await Promise.all([
      // применений (строк ТЧ) и чеков по каждой акции
      callQuery(`ВЫБРАТЬ ${ACT} КАК Акция, КОЛИЧЕСТВО(*) КАК Прим, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Т.Ссылка) КАК Чеков`
        + ` ИЗ Документ.ЧекККМ.Товары КАК Т ГДЕ ${tchWhere} СГРУППИРОВАТЬ ПО ${ACT}`, { timeoutMs: 90000 }),
      // сумма скидки по акции — из регистра, джойн к ТЧ по документу+номенклатуре
      callQuery(`ВЫБРАТЬ ${ACT} КАК Акция, СУММА(Р.СуммаСкидки) КАК Скидка`
        + ` ИЗ РегистрНакопления.ПредоставленныеСкидки КАК Р`
        + ` ВНУТРЕННЕЕ СОЕДИНЕНИЕ Документ.ЧекККМ.Товары КАК Т ПО Р.ДокументСкидки = Т.Ссылка И Р.Номенклатура = Т.Номенклатура`
        + ` ГДЕ Р.Период >= ${DT} И Р.Период < ${DTEND} И ${NOTEMPTY} СГРУППИРОВАТЬ ПО ${ACT}`, { timeoutMs: 120000 }),
      // итоги для KPI (точный distinct чеков с любой акцией)
      callQuery(`ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Прим, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Т.Ссылка) КАК Чеков`
        + ` ИЗ Документ.ЧекККМ.Товары КАК Т ГДЕ ${tchWhere}`, { timeoutMs: 90000 }),
    ]);
  } catch (e) {
    return { period: { from: fromYM, to: toYM }, available: false, note: 'Источник 1С недоступен: ' + String(e.message || e).slice(0, 80) };
  }

  const discBy = new Map();
  for (const r of sumRows.rows || []) discBy.set((r['Акция'] || '').trim(), parseRu(r['Скидка']) || 0);
  const actions = (byAct.rows || [])
    .map(r => {
      const action = (r['Акция'] || '').trim();
      return { action, applications: parseRu(r['Прим']) || 0, cheques: parseRu(r['Чеков']) || 0, discountSum: Number((discBy.get(action) || 0).toFixed(2)) };
    })
    .filter(a => a.action) // пустую акцию (прочие скидки) не показываем
    .sort((a, b) => (b.discountSum - a.discountSum) || (b.applications - a.applications));

  const t = (totRows.rows || [])[0] || {};
  return {
    period: { from: fromYM, to: toYM },
    totalApplications: parseRu(t['Прим']) || 0,
    uniqueDocuments: parseRu(t['Чеков']) || 0,
    totalDiscountSum: Number(actions.reduce((s, a) => s + a.discountSum, 0).toFixed(2)),
    truncatedNote: null, // агрегация в 1С — без потолка
    actions
  };
}

// UDS-промокоды за ОДИН месяц — прямой агрегат в 1С (callQuery), без лимита 5000.
// Раньше шло через callDocument('ЧекККМ', ..., 5000): брало первые 5000 чеков месяца
// (~12% при 40к/мес, только первые дни) → за май видели 571 код вместо 1363, выручку
// 321к вместо 742к. Теперь СГРУППИРОВАТЬ в 1С — полные данные + бонусы списано.
async function buildUdsPromoCodes(fromYM, toYM) {
  // toYM = выбранный месяц (фронт привязан к периоду слева). fromYM игнорируем —
  // считаем РОВНО за выбранный месяц (весь маркетинг «за период слева»).
  const ym = toYM || fromYM || nowYM();
  const [y, m] = ym.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const range = `Ч.Проведен И Ч.Дата >= ДАТАВРЕМЯ(${y},${m},1) И Ч.Дата < ДАТАВРЕМЯ(${ny},${nm},1)`;

  // 1) Все проведённые чеки месяца (для доли) + итоги по чекам с промокодом
  const [totalRes, promoRes, topRes, recentRes] = await Promise.all([
    callQuery(`ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Всего ИЗ Документ.ЧекККМ КАК Ч ГДЕ ${range}`, { timeoutMs: 120000 }),
    callQuery(`ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Ч.uds_КодСкидки) КАК Кодов, КОЛИЧЕСТВО(*) КАК Применений,`
      + ` СУММА(ЕСТЬNULL(Ч.СуммаДокумента,0)) КАК Выручка, СУММА(ЕСТЬNULL(Ч.СуммаОплатыБонусами,0)) КАК Бонусы`
      + ` ИЗ Документ.ЧекККМ КАК Ч ГДЕ ${range} И Ч.uds_КодСкидки <> ""`, { timeoutMs: 120000 }),
    callQuery(`ВЫБРАТЬ ПЕРВЫЕ 50 Ч.uds_КодСкидки КАК Код, КОЛИЧЕСТВО(*) КАК Применений,`
      + ` СУММА(ЕСТЬNULL(Ч.СуммаДокумента,0)) КАК Выручка, СУММА(ЕСТЬNULL(Ч.СуммаОплатыБонусами,0)) КАК Бонусы,`
      + ` КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Ч.Склад.Код) КАК Точек, МИНИМУМ(Ч.Дата) КАК Первый`
      + ` ИЗ Документ.ЧекККМ КАК Ч ГДЕ ${range} И Ч.uds_КодСкидки <> ""`
      + ` СГРУППИРОВАТЬ ПО Ч.uds_КодСкидки УПОРЯДОЧИТЬ ПО Выручка УБЫВ`, { timeoutMs: 120000 }),
    callQuery(`ВЫБРАТЬ ПЕРВЫЕ 100 Ч.Дата КАК Дата, Ч.uds_КодСкидки КАК Код, Ч.Номер КАК Номер,`
      + ` Ч.Склад.Наименование КАК Точка, ЕСТЬNULL(Ч.СуммаДокумента,0) КАК Сумма`
      + ` ИЗ Документ.ЧекККМ КАК Ч ГДЕ ${range} И Ч.uds_КодСкидки <> "" УПОРЯДОЧИТЬ ПО Ч.Дата УБЫВ`, { timeoutMs: 120000 })
  ]);

  const totalChecks = parseRu((totalRes.rows || [])[0]?.['Всего']) || 0;
  const pr = (promoRes.rows || [])[0] || {};
  const uniqueCodes = parseRu(pr['Кодов']) || 0;
  const checksWithPromocode = parseRu(pr['Применений']) || 0;
  const bonusUsed = Math.round(parseRu(pr['Бонусы']) || 0);
  const revenue = Math.round(parseRu(pr['Выручка']) || 0);

  return {
    period: { from: ym, to: ym },
    periodYM: ym,
    totalChecksScanned: totalChecks,
    checksWithPromocode,
    promocodeRate: totalChecks ? Number(((checksWithPromocode / totalChecks) * 100).toFixed(2)) : 0,
    uniqueCodes,
    revenue,
    bonusUsed,
    drr: revenue ? Number(((bonusUsed / revenue) * 100).toFixed(1)) : 0,
    truncatedNote: null,
    topCodes: (topRes.rows || []).map(r => ({
      code: (r['Код'] || '').trim(),
      uses: parseRu(r['Применений']) || 0,
      totalSum: Math.round(parseRu(r['Выручка']) || 0),
      bonusUsed: Math.round(parseRu(r['Бонусы']) || 0),
      stores: parseRu(r['Точек']) || 0,
      firstDate: r['Первый'] || ''
    })),
    recentApplications: (recentRes.rows || []).map(r => ({
      date: r['Дата'] || '',
      code: (r['Код'] || '').trim(),
      docNumber: r['Номер'] || '',
      store: (r['Точка'] || '').toString(),
      sum: Math.round(parseRu(r['Сумма']) || 0)
    }))
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

const udsCache = makeCache(6 * 60 * 60 * 1000, 'uds-promo');
async function getUdsPromoCodes(opts = {}) {
  if (!BASE()) return { available: false, note: 'UPP_PULL_URL не настроен' };
  const ym = opts.to || opts.from || nowYM(); // считаем за выбранный месяц
  return udsCache.wrap(`uds:${ym}`, async () => {
    try {
      return { available: true, ...(await buildUdsPromoCodes(ym, ym)) };
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
  peekMonthCards,
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
