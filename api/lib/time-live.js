// Время-разрезы (день/час/день-недели/неделя/heatmap) ЖИВЬЁМ из 1С по РЕАЛЬНОЙ дате чека.
// Причина та же, что у daily-live: БД пишет soldAt=время выгрузки → пачка одного дня
// раздувает день/час. Берём из ЧекККМ по Ч.Дата (нетто продажа−возврат).
// Один запрос по (ДЕНЬ,ЧАС) → выводим daily/byHour/byWeekday/weekly/heatmap (день недели
// считаем в JS по календарю). Количество — два лёгких запроса по Товарам (день, час).
const { callQuery, parseRu, nowYM, makeCache } = require('./upp-client');

const cache = makeCache(60 * 60 * 1000, 'time-live'); // 1ч, per-month
const WD = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const NET = 'СУММА(ВЫБОР КОГДА Ч.ВидОперации = ЗНАЧЕНИЕ(Перечисление.ВидыОперацийЧекККМ.Возврат) ТОГДА -Ч.СуммаДокумента ИНАЧЕ Ч.СуммаДокумента КОНЕЦ)';

function pad(n) { return String(n).padStart(2, '0'); }

async function build(period) {
  const p = period || nowYM();
  const [y, m] = p.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const RANGE = `Ч.Дата >= ДАТАВРЕМЯ(${y},${m},1) И Ч.Дата < ДАТАВРЕМЯ(${ny},${nm},1)`;
  const RANGE_T = `Т.Ссылка.Дата >= ДАТАВРЕМЯ(${y},${m},1) И Т.Ссылка.Дата < ДАТАВРЕМЯ(${ny},${nm},1)`;

  // Q1: ЧекККМ по (день, час) — нетто-выручка + число чеков.
  const q1 = await callQuery(
    `ВЫБРАТЬ ДЕНЬ(Ч.Дата) КАК Д, ЧАС(Ч.Дата) КАК Ч, ${NET} КАК С, КОЛИЧЕСТВО(*) КАК Чеков ИЗ Документ.ЧекККМ КАК Ч ГДЕ Ч.Проведен И ${RANGE} СГРУППИРОВАТЬ ПО ДЕНЬ(Ч.Дата), ЧАС(Ч.Дата)`,
    { timeoutMs: 110000 });
  if (q1.error || !(q1.rows || []).length) throw new Error('Q1: ' + (q1.error || 'пусто'));

  // Q2/Q3: количество единиц по дню и по часу (из табличной части).
  const q2 = await callQuery(`ВЫБРАТЬ ДЕНЬ(Т.Ссылка.Дата) КАК Д, СУММА(Т.Количество) КАК К ИЗ Документ.ЧекККМ.Товары КАК Т ГДЕ Т.Ссылка.Проведен И ${RANGE_T} СГРУППИРОВАТЬ ПО ДЕНЬ(Т.Ссылка.Дата)`, { timeoutMs: 110000 }).catch(() => ({ rows: [] }));
  const q3 = await callQuery(`ВЫБРАТЬ ЧАС(Т.Ссылка.Дата) КАК Ч, СУММА(Т.Количество) КАК К ИЗ Документ.ЧекККМ.Товары КАК Т ГДЕ Т.Ссылка.Проведен И ${RANGE_T} СГРУППИРОВАТЬ ПО ЧАС(Т.Ссылка.Дата)`, { timeoutMs: 110000 }).catch(() => ({ rows: [] }));
  const qtyByDay = {}; (q2.rows || []).forEach(r => qtyByDay[parseRu(r['Д'])] = parseRu(r['К']));
  const qtyByHour = {}; (q3.rows || []).forEach(r => qtyByHour[parseRu(r['Ч'])] = parseRu(r['К']));

  // Накопители
  const dayFact = {}, hourFact = {}, hourCheq = {};
  const wdFact = new Array(7).fill(0), wdQty = new Array(7).fill(0), wdDays = new Array(7).fill(0);
  const heat = {}; // `${wd}-${hour}` -> {fact, count}
  const daysWithData = new Set();
  for (const r of q1.rows || []) {
    const d = parseRu(r['Д']), h = parseRu(r['Ч']), f = parseRu(r['С']), c = parseRu(r['Чеков']);
    if (!(d >= 1 && d <= 31)) continue;
    const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0=Пн
    dayFact[d] = (dayFact[d] || 0) + f;
    hourFact[h] = (hourFact[h] || 0) + f; hourCheq[h] = (hourCheq[h] || 0) + c;
    wdFact[wd] += f;
    const hk = wd + '-' + h; if (!heat[hk]) heat[hk] = { fact: 0, count: 0 }; heat[hk].fact += f; heat[hk].count += c;
    daysWithData.add(d);
  }
  // дни недели: количество дней с данными + количество единиц (по дням)
  for (const d of daysWithData) {
    const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    wdDays[wd] += 1; wdQty[wd] += (qtyByDay[d] || 0);
  }

  // daily (date YYYY-MM-DD)
  const lastDay = new Date(Date.UTC(ny, nm - 1, 0)).getUTCDate();
  const daily = [];
  for (let d = 1; d <= lastDay; d++) {
    if (dayFact[d] == null && !qtyByDay[d]) continue; // пропускаем пустые хвостовые дни
    daily.push({ date: `${y}-${pad(m)}-${pad(d)}`, fact: Math.round(dayFact[d] || 0), cost: 0, margin: null, quantity: Math.round((qtyByDay[d] || 0) * 100) / 100 });
  }
  // byHour 0..23
  const byHour = [];
  for (let h = 0; h < 24; h++) byHour.push({ hour: h, fact: Math.round(hourFact[h] || 0), cost: 0, margin: null, marginPct: null, quantity: Math.round((qtyByHour[h] || 0) * 100) / 100, txCount: hourCheq[h] || 0 });
  // byWeekday
  const byWeekday = WD.map((name, i) => ({ weekday: name, weekdayIdx: i, fact: Math.round(wdFact[i]), cost: 0, margin: null, marginPct: null, quantity: Math.round(wdQty[i] * 100) / 100, daysCount: wdDays[i], avgPerDay: wdDays[i] ? Math.round(wdFact[i] / wdDays[i]) : 0 }));
  // weekly — группируем дни по понедельнику недели
  const weeks = {};
  for (let d = 1; d <= lastDay; d++) {
    if (dayFact[d] == null && !qtyByDay[d]) continue;
    const dt = new Date(Date.UTC(y, m - 1, d));
    const monday = new Date(dt); monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    const wkKey = `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
    if (!weeks[wkKey]) weeks[wkKey] = { weekStart: wkKey, fact: 0, cost: 0, margin: null, quantity: 0 };
    weeks[wkKey].fact += (dayFact[d] || 0); weeks[wkKey].quantity += (qtyByDay[d] || 0);
  }
  const weekly = Object.values(weeks).sort((a, b) => a.weekStart.localeCompare(b.weekStart)).map(w => ({ ...w, fact: Math.round(w.fact), quantity: Math.round(w.quantity * 100) / 100 }));
  // heatmap 7×24
  const heatmap = [];
  for (let wd = 0; wd < 7; wd++) for (let h = 0; h < 24; h++) { const c = heat[wd + '-' + h]; heatmap.push({ day: wd, hour: h, fact: Math.round(c ? c.fact : 0), count: c ? c.count : 0 }); }

  return { period: p, source: '1c-live-realdate', daily, byHour, byWeekday, weekly, heatmap };
}

async function timeLive(period) {
  return cache.wrap('t:' + (period || nowYM()), () => build(period));
}

module.exports = { timeLive };
