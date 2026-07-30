// Разбор среднего чека: ПОЧЕМУ он изменился год-к-году.
// Автоматизация ручного анализа 2026-07-30 (session_log №2): чек раскладывается на
// штуки-в-чеке × цену-штуки, а цена штуки — на честную инфляцию ТЕХ ЖЕ SKU
// (изолирует подорожание от перекодировок категорий — «Десерты»→«Пирожные» иначе
// врут в YoY по группам) и на сдвиг штучного микса (разница «цена/шт выросла на X,
// а те же товары подорожали на Y» = покупатель берёт другие позиции).
//
// Все сравнения MTD-честные: текущий месяц обрезается по вчера включительно,
// прошлогодний — тем же днём (полный-vs-неполный месяц даёт артефакты типа
// «чеки −5%» при реальных +2%).
const upp = require('./upp-client');
const cache = upp.makeCache(6 * 60 * 60 * 1000, 'avg-check-analysis');

const SKU_MIN_REVENUE = 50000;   // SKU мельче не влияют на индекс, но раздувают выдачу
const TOP_MOVERS = 8;
const TOP_NEW = 5;

function windowFor(y, m, asOfDay) {
  const upper = asOfDay
    ? `ДАТАВРЕМЯ(${y},${m},${asOfDay + 1})`
    : (m === 12 ? `ДАТАВРЕМЯ(${y + 1},1,1)` : `ДАТАВРЕМЯ(${y},${m + 1},1)`);
  return `Т.Ссылка.Дата >= ДАТАВРЕМЯ(${y},${m},1) И Т.Ссылка.Дата < ${upper}`;
}

async function _compute(period) {
  const [y, m] = period.split('-').map(Number);
  const now = new Date();
  const isCurrent = now.getFullYear() === y && now.getMonth() + 1 === m;
  // текущий месяц: по вчера включительно (сегодняшний день неполный); 1-го числа данных нет
  const asOfDay = isCurrent ? Math.max(1, now.getDate() - 1) : null;
  const bothWin = `(${windowFor(y, m, asOfDay)}) ИЛИ (${windowFor(y - 1, m, asOfDay)})`;
  const notReturn = 'Т.Ссылка.Проведен И Т.Ссылка.ВидОперации <> ЗНАЧЕНИЕ(Перечисление.ВидыОперацийЧекККМ.Возврат)';

  // 1) штуки/брутто/чеки по годам (из строк чеков)
  const qTotals = 'ВЫБРАТЬ ГОД(Т.Ссылка.Дата) КАК Г, СУММА(Т.Количество) КАК Штук,'
    + ' СУММА(Т.Сумма) КАК Брутто, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Т.Ссылка) КАК Чеков'
    + ` ИЗ Документ.ЧекККМ.Товары КАК Т ГДЕ ${notReturn} И (${bothWin})`
    + ' СГРУППИРОВАТЬ ПО ГОД(Т.Ссылка.Дата)';

  // 2) нетто-выручка (СуммаДокумента = реально оплачено) по годам, возвраты минусом
  const qNet = 'ВЫБРАТЬ ГОД(Чек.Дата) КАК Г, Чек.ВидОперации КАК Вид,'
    + ' СУММА(ЕСТЬNULL(Чек.СуммаДокумента,0)) КАК Сумма, КОЛИЧЕСТВО(Чек.Ссылка) КАК Чеков'
    + ' ИЗ Документ.ЧекККМ КАК Чек ГДЕ Чек.Проведен И ('
    + bothWin.replace(/Т\.Ссылка\.Дата/g, 'Чек.Дата')
    + ') СГРУППИРОВАТЬ ПО ГОД(Чек.Дата), Чек.ВидОперации';

  // 3) SKU-уровень для честного индекса цен (те же товары в оба года)
  const qSku = 'ВЫБРАТЬ ГОД(Т.Ссылка.Дата) КАК Г, Т.Номенклатура.Наименование КАК Товар,'
    + ' СУММА(Т.Сумма) КАК Брутто, СУММА(Т.Количество) КАК Штук'
    + ` ИЗ Документ.ЧекККМ.Товары КАК Т ГДЕ ${notReturn} И (${bothWin})`
    + ' СГРУППИРОВАТЬ ПО ГОД(Т.Ссылка.Дата), Т.Номенклатура.Наименование'
    + ` ИМЕЮЩИЕ СУММА(Т.Сумма) > ${SKU_MIN_REVENUE}`;

  const [rTot, rNet, rSku] = [
    await upp.callQuery(qTotals), await upp.callQuery(qNet), await upp.callQuery(qSku, { timeoutMs: 160000 })
  ];

  const years = { [y]: {}, [y - 1]: {} };
  for (const row of (rTot.rows || [])) {
    const yy = Math.round(upp.parseRu(row['Г']));
    if (!years[yy]) continue;
    years[yy].units = upp.parseRu(row['Штук']);
    years[yy].gross = upp.parseRu(row['Брутто']);
    years[yy].cheques = Math.round(upp.parseRu(row['Чеков']));
  }
  for (const row of (rNet.rows || [])) {
    const yy = Math.round(upp.parseRu(row['Г']));
    if (!years[yy]) continue;
    const isRet = /возврат/i.test(String(row['Вид'] || ''));
    years[yy].net = (years[yy].net || 0) + (isRet ? -1 : 1) * upp.parseRu(row['Сумма']);
    if (!isRet) years[yy].netCheques = (years[yy].netCheques || 0) + Math.round(upp.parseRu(row['Чеков']));
  }

  const sku = new Map();
  for (const row of (rSku.rows || [])) {
    const yy = Math.round(upp.parseRu(row['Г']));
    if (!years[yy]) continue;
    const name = String(row['Товар'] || '').trim();
    if (!sku.has(name)) sku.set(name, {});
    sku.get(name)[yy] = { rev: upp.parseRu(row['Брутто']), qty: upp.parseRu(row['Штук']) };
  }
  // общие SKU: взвешенный индекс цен. Вес = СРЕДНЕЕ выручки двух лет (Маршалл-Эджворт):
  // вес только текущего года переоценивает подорожавшие позиции (их выручка уже содержит
  // рост цены) — на июле-2026 давал 21% при честных ~15%.
  let wSum = 0, wIdx = 0, commonRevCur = 0;
  const movers = [];
  for (const [name, a] of sku) {
    const cur = a[y], prev = a[y - 1];
    if (!cur || !prev || !(cur.qty > 0) || !(prev.qty > 0)) continue;
    const pCur = cur.rev / cur.qty, pPrev = prev.rev / prev.qty;
    if (!(pPrev > 0)) continue;
    const w = (cur.rev + prev.rev) / 2;
    wSum += w; wIdx += w * (pCur / pPrev); commonRevCur += cur.rev;
    movers.push({ name, pricePrev: Math.round(pPrev), priceCur: Math.round(pCur),
      changePct: Math.round((pCur / pPrev - 1) * 1000) / 10, revenueCur: Math.round(cur.rev),
      impact: w * (pCur / pPrev - 1) });
  }
  const skuInflationPct = wSum > 0 ? Math.round((wIdx / wSum - 1) * 1000) / 10 : null;
  movers.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const newItems = [...sku.entries()].filter(([, a]) => a[y] && !a[y - 1])
    .map(([name, a]) => ({ name, revenue: Math.round(a[y].rev), qty: Math.round(a[y].qty),
      price: a[y].qty > 0 ? Math.round(a[y].rev / a[y].qty) : null }))
    .sort((a, b) => b.revenue - a.revenue);

  const mk = (yy) => {
    const d = years[yy];
    if (!d || !d.cheques) return null;
    return {
      cheques: d.netCheques || d.cheques, units: Math.round(d.units), gross: Math.round(d.gross),
      net: Math.round(d.net || 0),
      avgNetCheque: d.netCheques ? Math.round((d.net / d.netCheques) * 10) / 10 : null,
      unitsPerCheque: Math.round((d.units / d.cheques) * 100) / 100,
      pricePerUnit: d.units > 0 ? Math.round((d.gross / d.units) * 10) / 10 : null
    };
  };
  const cur = mk(y), prev = mk(y - 1);
  const pct = (a, b) => (a != null && b > 0) ? Math.round((a / b - 1) * 1000) / 10 : null;
  const yoy = (cur && prev) ? {
    avgNetCheque: pct(cur.avgNetCheque, prev.avgNetCheque),
    cheques: pct(cur.cheques, prev.cheques),
    unitsPerCheque: pct(cur.unitsPerCheque, prev.unitsPerCheque),
    pricePerUnit: pct(cur.pricePerUnit, prev.pricePerUnit)
  } : null;
  // сдвиг микса ≈ рост цены/шт минус инфляция тех же SKU (оценка: новинки+хвост вне индекса)
  const mixShiftPct = (yoy && yoy.pricePerUnit != null && skuInflationPct != null)
    ? Math.round((yoy.pricePerUnit - skuInflationPct) * 10) / 10 : null;

  return {
    period, asOfDay, prevYear: y - 1,
    cur, prev, yoy,
    skuInflationPct, mixShiftPct,
    commonSkuSharePct: (cur && cur.gross) ? Math.round(commonRevCur / cur.gross * 100) : null,
    topMovers: movers.slice(0, TOP_MOVERS).map(({ impact, ...rest }) => rest),
    newItems: newItems.slice(0, TOP_NEW),
    newItemsRevenue: Math.round(newItems.reduce((s, n) => s + n.revenue, 0)),
    method: `чек = штуки/чек × цена/шт (брутто, Товары.Сумма); нетто-чек = СуммаДокумента−возвраты; SKU-индекс: общие товары >${SKU_MIN_REVENUE / 1000}к, вес = средняя выручка двух лет; сдвиг микса = рост цены/шт − SKU-инфляция (оценка)`
  };
}

async function getAvgCheckAnalysis(period) {
  return cache.wrap(period + ':v2', () => _compute(period)); // v2: веса Маршалла-Эджворта
}

module.exports = { getAvgCheckAnalysis };
