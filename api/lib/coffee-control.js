// Кофе-контроль: стаканы, отгруженные на точку (ПеремещениеТоваров) vs напитки,
// ПРОБИТЫЕ в чеках (ЧекККМ.Товары). Ловит продажу кофе мимо кассы: стакан нужен
// каждому напитку навынос независимо от рецептуры, поэтому разрыв «стаканов сильно
// больше, чем пробитых напитков» = недопробитие (июль-2026: Солнце ДЦ 700 стаканов
// при 34 кофе-чеках, Баумана 700/84, Премьер БЦ 300/21 — против Союза 1100/769).
//
// Методика v1 (консервативная, чтобы не было ложных обвинений):
//  • стаканы = все перемещения «Стакан Бумажный …» на склад точки за окно 56 дней
//    (двойное окно сглаживает запас: точка могла взять стаканы «на будущее»);
//  • напитки = ВСЕ пробитые позиции групп «Кофе с собой», «Кофе», «Напитки»,
//    «Напитки производства», «Чай» — т.е. считаем в плюс точке даже напитки не в
//    стаканах (чай в чайнике, бутылки). Это ЗАВЫШАЕТ пробитое → занижает тревогу;
//  • ratio = стаканы / напитки. ok ≤ 1.7 (запас+брак), warn ≤ 3, red > 3.
//  Зерно/молоко в v1 не считаем: на точки они едут НЕ перемещениями (закупка
//  напрямую), их поток в 1С этим каналом не виден.
const upp = require('./upp-client');
const cache = upp.makeCache(6 * 60 * 60 * 1000, 'coffee-control');

const WINDOW_DAYS = 56;
const MIN_CUPS = 100;          // меньше — «мало данных», не оцениваем
const DRINK_GROUPS = '"Кофе с собой", "Кофе", "Напитки", "Напитки производства", "Чай"';

function dt(d) { return `ДАТАВРЕМЯ(${d.getFullYear()},${d.getMonth() + 1},${d.getDate()})`; }

async function _compute() {
  const to = new Date(); to.setHours(0, 0, 0, 0); to.setDate(to.getDate() + 1); // завтра 00:00 = включая сегодня
  const from = new Date(to); from.setDate(from.getDate() - WINDOW_DAYS);

  const qCups = 'ВЫБРАТЬ Т.Ссылка.СкладПолучатель.Наименование КАК Точка, СУММА(Т.Количество) КАК Кол'
    + ' ИЗ Документ.ПеремещениеТоваров.Товары КАК Т'
    + ` ГДЕ Т.Ссылка.Проведен И Т.Ссылка.Дата >= ${dt(from)} И Т.Ссылка.Дата < ${dt(to)}`
    + ' И Т.Номенклатура.Наименование ПОДОБНО "Стакан Бумажный%"'
    + ' СГРУППИРОВАТЬ ПО Т.Ссылка.СкладПолучатель.Наименование';

  const qDrinks = 'ВЫБРАТЬ Т.Ссылка.Склад.Наименование КАК Точка, СУММА(Т.Количество) КАК Кол,'
    + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Т.Ссылка) КАК Чеков'
    + ' ИЗ Документ.ЧекККМ.Товары КАК Т'
    + ' ГДЕ Т.Ссылка.Проведен И Т.Ссылка.ВидОперации <> ЗНАЧЕНИЕ(Перечисление.ВидыОперацийЧекККМ.Возврат)'
    + ` И Т.Ссылка.Дата >= ${dt(from)} И Т.Ссылка.Дата < ${dt(to)}`
    + ` И Т.Номенклатура.НоменклатурнаяГруппа.Наименование В (${DRINK_GROUPS})`
    + ' СГРУППИРОВАТЬ ПО Т.Ссылка.Склад.Наименование';

  const [rCups, rDrinks] = [await upp.callQuery(qCups), await upp.callQuery(qDrinks)];
  const stores = new Map();
  for (const row of (rCups.rows || [])) {
    const name = String(row['Точка'] || '').trim();
    if (!name || /промежуточн|возврат|основной склад|сырье/i.test(name)) continue;
    stores.set(name, { store: name, cups: Math.round(upp.parseRu(row['Кол'])), drinks: 0, drinkCheques: 0 });
  }
  for (const row of (rDrinks.rows || [])) {
    const name = String(row['Точка'] || '').trim();
    if (!stores.has(name)) stores.set(name, { store: name, cups: 0, drinks: 0, drinkCheques: 0 });
    const s = stores.get(name);
    s.drinks = Math.round(upp.parseRu(row['Кол']));
    s.drinkCheques = Math.round(upp.parseRu(row['Чеков']));
  }
  const list = [...stores.values()].map(s => {
    const ratio = s.drinks > 0 ? s.cups / s.drinks : null;
    let status;
    if (s.cups < MIN_CUPS) status = 'few';                    // стаканов мало — не оцениваем
    else if (s.drinks === 0 || ratio > 3) status = 'red';     // стаканы есть, пробития нет
    else if (ratio > 1.7) status = 'warn';
    else status = 'ok';
    return { ...s, ratio: ratio != null ? Math.round(ratio * 100) / 100 : null, status };
  }).sort((a, b) => {
    const rank = { red: 0, warn: 1, ok: 2, few: 3 };
    return rank[a.status] - rank[b.status] || (b.cups - a.cups);
  });
  return {
    from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), windowDays: WINDOW_DAYS,
    redCount: list.filter(s => s.status === 'red').length,
    stores: list,
    method: 'стаканы(перемещения 56д) / пробитые напитки(Кофе с собой+Кофе+Напитки+Напитки производства+Чай); ok≤1.7, warn≤3, red>3'
  };
}

async function getCoffeeControl() {
  return cache.wrap('v1', _compute);
}

module.exports = { getCoffeeControl };
