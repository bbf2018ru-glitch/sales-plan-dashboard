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

  // attach: % чеков точки, в которых есть кофе (только кофейные группы, без чая/бутылок) —
  // показывает, где кофе-аттач не работает (упущенная выручка), в паре с антифродом выше
  const qAttach = 'ВЫБРАТЬ Т.Ссылка.Склад.Наименование КАК Точка,'
    + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Т.Ссылка) КАК КофеЧеков, СУММА(Т.Сумма) КАК КофеРуб'
    + ' ИЗ Документ.ЧекККМ.Товары КАК Т'
    + ' ГДЕ Т.Ссылка.Проведен И Т.Ссылка.ВидОперации <> ЗНАЧЕНИЕ(Перечисление.ВидыОперацийЧекККМ.Возврат)'
    + ` И Т.Ссылка.Дата >= ${dt(from)} И Т.Ссылка.Дата < ${dt(to)}`
    + ' И Т.Номенклатура.НоменклатурнаяГруппа.Наименование В ("Кофе с собой", "Кофе")'
    + ' СГРУППИРОВАТЬ ПО Т.Ссылка.Склад.Наименование';
  const qAllCheques = 'ВЫБРАТЬ Чек.Склад.Наименование КАК Точка, КОЛИЧЕСТВО(Чек.Ссылка) КАК Чеков'
    + ' ИЗ Документ.ЧекККМ КАК Чек'
    + ' ГДЕ Чек.Проведен И Чек.ВидОперации <> ЗНАЧЕНИЕ(Перечисление.ВидыОперацийЧекККМ.Возврат)'
    + ` И Чек.Дата >= ${dt(from)} И Чек.Дата < ${dt(to)}`
    + ' СГРУППИРОВАТЬ ПО Чек.Склад.Наименование';

  const [rCups, rDrinks, rAttach, rAll] = [
    await upp.callQuery(qCups), await upp.callQuery(qDrinks),
    await upp.callQuery(qAttach), await upp.callQuery(qAllCheques)
  ];
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
  const attach = new Map(); // точка → { coffeeCheques, coffeeRub, allCheques }
  for (const row of (rAttach.rows || [])) {
    const name = String(row['Точка'] || '').trim();
    attach.set(name, { coffeeCheques: Math.round(upp.parseRu(row['КофеЧеков'])), coffeeRub: Math.round(upp.parseRu(row['КофеРуб'])), allCheques: 0 });
  }
  for (const row of (rAll.rows || [])) {
    const name = String(row['Точка'] || '').trim();
    if (!attach.has(name)) attach.set(name, { coffeeCheques: 0, coffeeRub: 0, allCheques: 0 });
    attach.get(name).allCheques = Math.round(upp.parseRu(row['Чеков']));
  }
  const attachRows = [...attach.entries()]
    .filter(([name, a]) => a.allCheques >= 300 && !/промежуточн|возврат|основной склад|сырье|сайт/i.test(name))
    .map(([name, a]) => ({ store: name, allCheques: a.allCheques, coffeeCheques: a.coffeeCheques,
      coffeeRub: a.coffeeRub, attachPct: Math.round(a.coffeeCheques / a.allCheques * 1000) / 10 }))
    .sort((a, b) => b.attachPct - a.attachPct);
  // потенциал: подтянуть точки ниже медианы до медианы, по среднему кофе-чеку сети (оценка)
  const med = attachRows.length ? attachRows[Math.floor(attachRows.length / 2)].attachPct : 0;
  const netCoffee = attachRows.reduce((s, r) => s + r.coffeeRub, 0);
  const netCoffeeCheques = attachRows.reduce((s, r) => s + r.coffeeCheques, 0);
  const avgCoffeeTicket = netCoffeeCheques ? netCoffee / netCoffeeCheques : 0;
  for (const r of attachRows) {
    r.potentialRub = r.attachPct < med
      ? Math.round((med - r.attachPct) / 100 * r.allCheques * avgCoffeeTicket)
      : 0;
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
    attach: {
      medianPct: med,
      avgCoffeeTicket: Math.round(avgCoffeeTicket),
      totalPotentialRub: attachRows.reduce((s, r) => s + r.potentialRub, 0),
      rows: attachRows
    },
    method: 'стаканы(перемещения 56д) / пробитые напитки(Кофе с собой+Кофе+Напитки+Напитки производства+Чай); ok≤1.7, warn≤3, red>3; attach = % чеков с кофе, потенциал = подтяжка до медианы (оценка)'
  };
}

async function getCoffeeControl() {
  return cache.wrap('v2', _compute); // v2: + attach-блок (ключ бампнут, чтобы не отдать старый кэш без него)
}

module.exports = { getCoffeeControl };
