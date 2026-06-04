// Дневной план выпуска кондитерки (гибрид) — ЖИВОЙ расчёт из 1С через /query.
// Источники (раскопаны 2026-06-04):
//  • Остаток E/G/H — РегистрНакопления.ТоварыНаСкладах.Остатки: ГП(А00000011)+п/ф(А00000033),
//    Запас(А00000046), Контейнер(А00000155).
//  • Пресс-сетка M(завтра)/O(послезавтра) — ПеремещениеТоваров со склада А00000130
//    («Промежуточный склад гп» → магазины), среднее по тому же дню недели за 3 нед.
//  • Сайт L/P — ЗаказПокупателя.Товары, Контрагент «…(сайт)», по ДатаОтгрузки.
// Формула: N = E + H + G − L − M ; R = N − O − P  (ручные Вычерки/Довозы/Выходные = 0 в онлайне).
// YoY: те же отгрузки на ту же календарную дату год назад (сравнение спроса).

const fs = require('fs');
const path = require('path');
const upp = require('./upp-client');
const cache = upp.makeCache(10 * 60 * 1000); // 10 минут

const WH_GP = ['А00000011', 'А00000033'];
const WH_ZAP = 'А00000046';
const WH_KONT = 'А00000155';
const SRC_PRESS = 'А00000130';

let CEH = { order: [], map: {} };
try { CEH = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'prod-ceh-map.json'), 'utf8')); }
catch (e) { console.log('[production-plan] нет prod-ceh-map.json:', e.message); }

function norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); }
function cc(s) { return String(s == null ? '' : s).trim(); }
// дата → {y,m,d}; сдвиг на дни
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; }
function addDays(o, n) { const dt = new Date(Date.UTC(o.y, o.m - 1, o.d + n)); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; }
function dtLit(o) { return `ДАТАВРЕМЯ(${o.y},${o.m},${o.d})`; }
function dayKey(o) { return `${String(o.d).padStart(2, '0')}.${String(o.m).padStart(2, '0')}.${o.y}`; }
function weekdayRu(o) { const w = new Date(Date.UTC(o.y, o.m - 1, o.d)).getUTCDay(); return ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][w]; }

// --- запросы в 1С ---
async function qStock() {
  const wh = WH_GP.concat([WH_ZAP, WH_KONT]).map(c => `"${c}"`).join(',');
  const q = 'ВЫБРАТЬ Ост.Склад.Код КАК Склад, Ост.Номенклатура.Код КАК Код, Ост.Номенклатура.Наименование КАК Имя,'
    + ' СУММА(Ост.КоличествоОстаток) КАК Кол'
    + ` ИЗ РегистрНакопления.ТоварыНаСкладах.Остатки(, Склад.Код В (${wh})) КАК Ост`
    + ' СГРУППИРОВАТЬ ПО Ост.Склад.Код, Ост.Номенклатура.Код, Ост.Номенклатура.Наименование'
    + ' ИМЕЮЩИЕ СУММА(Ост.КоличествоОстаток) <> 0';
  return (await upp.callQuery(q, { timeoutMs: 90000 })).rows || [];
}
async function qShipDaily(from, to) {
  const q = 'ВЫБРАТЬ НАЧАЛОПЕРИОДА(Т.Ссылка.Дата,ДЕНЬ) КАК День, Т.Номенклатура.Код КАК Код, Т.Номенклатура.Наименование КАК Имя,'
    + ' СУММА(Т.Количество) КАК Кол ИЗ Документ.ПеремещениеТоваров.Товары КАК Т'
    + ` ГДЕ Т.Ссылка.Дата >= ${dtLit(from)} И Т.Ссылка.Дата < ${dtLit(to)} И Т.Ссылка.Проведен`
    + ` И Т.Ссылка.СкладОтправитель.Код = "${SRC_PRESS}"`
    + ' СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(Т.Ссылка.Дата,ДЕНЬ), Т.Номенклатура.Код, Т.Номенклатура.Наименование';
  return (await upp.callQuery(q, { timeoutMs: 90000 })).rows || [];
}
async function qSite(day) {
  const q = 'ВЫБРАТЬ Т.Номенклатура.Код КАК Код, СУММА(Т.Количество) КАК Кол ИЗ Документ.ЗаказПокупателя.Товары КАК Т'
    + ` ГДЕ Т.Ссылка.ДатаОтгрузки >= ${dtLit(day)} И Т.Ссылка.ДатаОтгрузки < ${dtLit(addDays(day, 1))}`
    + ' И Т.Ссылка.Проведен И Т.Ссылка.Контрагент.Наименование ПОДОБНО "%(сайт)%"'
    + ' СГРУППИРОВАТЬ ПО Т.Номенклатура.Код';
  return (await upp.callQuery(q, { timeoutMs: 60000 })).rows || [];
}

// среднее отгрузки по коду на даты `days` (массив {y,m,d})
function weekdayAvg(shipMap, days) {
  const out = {};
  for (const code of Object.keys(shipMap)) {
    let s = 0; for (const d of days) s += shipMap[code][dayKey(d)] || 0;
    out[code] = Math.round(s / days.length * 10) / 10;
  }
  return out;
}

// собрать пресс-сетку (M на день target, O на target+1) из подённой отгрузки за 3 нед назад
async function pressForDate(target) {
  const from = addDays(target, -22), to = addDays(target, 1);
  const rows = await qShipDaily(from, to);
  const shipMap = {}; const names = {};
  for (const r of rows) {
    const code = cc(r.Код), day = cc(r.День).slice(0, 10);
    if (!code || !day) continue;
    (shipMap[code] = shipMap[code] || {})[day] = (shipMap[code][day] || 0) + upp.parseRu(r.Кол);
    names[code] = r.Имя;
  }
  const mDays = [addDays(target, -7), addDays(target, -14), addDays(target, -21)];
  const oT = addDays(target, 1);
  const oDays = [addDays(oT, -7), addDays(oT, -14), addDays(oT, -21)];
  return { M: weekdayAvg(shipMap, mDays), O: weekdayAvg(shipMap, oDays), names };
}

async function compute(dateStr, opts) {
  const yoy = !!(opts && opts.yoy);
  const target = parseYMD(dateStr);
  const next = addDays(target, 1);

  const [stockRows, press, siteL, siteP] = await Promise.all([
    qStock(), pressForDate(target), qSite(target), qSite(next)
  ]);

  // остаток по коду
  const E = {}, G = {}, H = {}, names = {};
  for (const r of stockRows) {
    const code = cc(r.Код), w = cc(r.Склад), q = upp.parseRu(r.Кол);
    names[code] = r.Имя;
    if (WH_GP.includes(w)) E[code] = (E[code] || 0) + q;
    else if (w === WH_ZAP) G[code] = (G[code] || 0) + q;
    else if (w === WH_KONT) H[code] = (H[code] || 0) + q;
  }
  Object.assign(names, press.names);
  const L = {}, P = {};
  for (const r of siteL) L[cc(r.Код)] = upp.parseRu(r.Кол);
  for (const r of siteP) P[cc(r.Код)] = upp.parseRu(r.Кол);

  // YoY: отгрузка на ту же дату год назад
  let lyM = {};
  if (yoy) {
    try { lyM = (await pressForDate({ y: target.y - 1, m: target.m, d: target.d })).M; }
    catch (e) { console.log('[production-plan] yoy fail:', e.message); }
  }

  // все коды, по которым есть хоть что-то
  const codes = new Set([...Object.keys(E), ...Object.keys(G), ...Object.keys(H), ...Object.keys(press.M), ...Object.keys(L), ...Object.keys(P)]);
  const cehBuckets = {};
  let deficitCount = 0, taskUnits = 0;
  for (const code of codes) {
    const nm = names[code] || code;
    const e = Math.round((E[code] || 0) * 10) / 10, g = Math.round((G[code] || 0) * 10) / 10, h = Math.round((H[code] || 0) * 10) / 10;
    const m = press.M[code] || 0, o = press.O[code] || 0, l = L[code] || 0, p = P[code] || 0;
    const N = e + h + g - l - m;
    const R = N - o - p;
    const task = R < 0 ? Math.ceil(-R) : 0;
    if (e === 0 && g === 0 && h === 0 && m === 0 && o === 0 && l === 0 && p === 0) continue;
    if (task > 0) { deficitCount++; taskUnits += task; }
    const cehInfo = CEH.map[norm(nm)];
    const ceh = (cehInfo && cehInfo.ceh) || 'Прочее';
    const lym = yoy ? (lyM[code] || 0) : null;
    const deltaPct = (yoy && lym) ? Math.round((m - lym) / lym * 1000) / 10 : null;
    (cehBuckets[ceh] = cehBuckets[ceh] || []).push({
      code, name: nm, gp: e, zap: g, kont: h, ship: m, shipNext: o, siteL: l, siteP: p,
      N: Math.round(N * 10) / 10, R: Math.round(R * 10) / 10, task,
      lyShip: lym, deltaPct
    });
  }
  const order = CEH.order && CEH.order.length ? CEH.order : Object.keys(cehBuckets);
  const ceh = [];
  for (const name of order) {
    const items = cehBuckets[name];
    if (!items || !items.length) continue;
    items.sort((a, b) => b.task - a.task || (b.ship - a.ship));
    ceh.push({ name, items, task: items.reduce((s, x) => s + x.task, 0), deficit: items.filter(x => x.task > 0).length });
  }
  // прочие цеха, которых нет в order
  for (const name of Object.keys(cehBuckets)) {
    if (order.includes(name)) continue;
    const items = cehBuckets[name]; items.sort((a, b) => b.task - a.task);
    ceh.push({ name, items, task: items.reduce((s, x) => s + x.task, 0), deficit: items.filter(x => x.task > 0).length });
  }

  return {
    date: dateStr, weekday: weekdayRu(target), nextWeekday: weekdayRu(next),
    yoy, ceh,
    totals: { skus: [].concat(...ceh.map(c => c.items)).length, deficitCount, taskUnits: Math.round(taskUnits) },
    note: 'Онлайн-расчёт из 1С. Остаток — текущий; M/O — среднее отгрузки А00000130→магазины по дню недели за 3 нед; Вычерки/Довозы/Выходные не учтены (ручные у Маши).',
    refreshedAt: new Date().toISOString()
  };
}

function getPlan(dateStr, opts) {
  const key = 'plan:' + dateStr + (opts && opts.yoy ? ':yoy' : '');
  return cache.wrap(key, () => compute(dateStr, opts));
}

module.exports = { getPlan };
