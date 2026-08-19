// Выпуск продукции в килограммах (production-kg) через /query 1С.
// Источник: Документ.ОтчетПроизводстваЗаСмену.Продукция (НЕ РегистрНакопления.ВыпускПродукции
// — он пуст). Учитываем только готовую продукцию: НоменклатурнаяГруппа.ЭтоПродукция = Истина.
// Кг = Σ(Количество × Справочник.Номенклатура.ф_ВесШтукивКг).
// Количество — в шт (базовая единица); ВесКг — кг за штуку (для весовых позиций ВесКг≈1).
// Позиции без веса (ВесКг=0/null) в кг дают 0 — считаем отдельно как «без веса».

const upp = require('./upp-client');
const cache = upp.makeCache(6 * 60 * 60 * 1000, 'production-kg');

function bounds(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { y, m, ny: next[0], nm: next[1] };
}
function monthsBack(period, n) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - (n - 1), 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

async function compute(period) {
  const b = bounds(period);
  const from = monthsBack(period, 12); // последние 12 месяцев по выбранный включительно

  // По месяцам: кг + шт.
  const byMonthQ = 'ВЫБРАТЬ НАЧАЛОПЕРИОДА(П.Ссылка.Дата, МЕСЯЦ) КАК Мес,'
    + ' СУММА(П.Количество * ЕСТЬNULL(П.Номенклатура.ф_ВесШтукивКг, 0)) КАК Кг,'
    + ' СУММА(П.Количество) КАК Штук'
    + ' ИЗ Документ.ОтчетПроизводстваЗаСмену.Продукция КАК П'
    + ` ГДЕ П.Ссылка.Дата >= ДАТАВРЕМЯ(${from.y},${from.m},1) И П.Ссылка.Дата < ДАТАВРЕМЯ(${b.ny},${b.nm},1)`
    + ' И П.Номенклатура.НоменклатурнаяГруппа.ЭтоПродукция = ИСТИНА'
    + ' СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(П.Ссылка.Дата, МЕСЯЦ)'
    + ' УПОРЯДОЧИТЬ ПО Мес';

  // Топ-продукции по кг за выбранный месяц.
  const topQ = 'ВЫБРАТЬ ПЕРВЫЕ 25 П.Номенклатура КАК Товар,'
    + ' СУММА(П.Количество * ЕСТЬNULL(П.Номенклатура.ф_ВесШтукивКг, 0)) КАК Кг,'
    + ' СУММА(П.Количество) КАК Штук'
    + ' ИЗ Документ.ОтчетПроизводстваЗаСмену.Продукция КАК П'
    + ` ГДЕ П.Ссылка.Дата >= ДАТАВРЕМЯ(${b.y},${b.m},1) И П.Ссылка.Дата < ДАТАВРЕМЯ(${b.ny},${b.nm},1)`
    + ' И П.Номенклатура.НоменклатурнаяГруппа.ЭтоПродукция = ИСТИНА'
    + ' СГРУППИРОВАТЬ ПО П.Номенклатура'
    + ' УПОРЯДОЧИТЬ ПО Кг УБЫВ';

  const MM = ['', 'Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
  const ymOf = (s) => { const p = upp.parseRuDate(s); return p ? `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, '0')}` : s; };

  const [bm, tp] = await Promise.all([upp.callQuery(byMonthQ), upp.callQuery(topQ)]);

  const months = ((bm && bm.rows) || []).map((r) => {
    const ym = ymOf(r.Мес); const p = ym.split('-');
    return { ym, label: (p[0] || '').slice(2) + '-' + (MM[Number(p[1])] || p[1]), kg: Math.round(upp.parseRu(r.Кг)), units: Math.round(upp.parseRu(r.Штук)) };
  });
  const top = ((tp && tp.rows) || []).map((r) => ({ name: r.Товар, kg: Math.round(upp.parseRu(r.Кг) * 10) / 10, units: Math.round(upp.parseRu(r.Штук)) }))
    .filter((x) => x.kg > 0);

  const cur = months.find((x) => x.ym === period) || { kg: 0, units: 0 };
  const prevYm = (() => { const pm = monthsBack(period, 2); return `${pm.y}-${String(pm.m).padStart(2, '0')}`; })();
  const prev = months.find((x) => x.ym === prevYm);
  const momPct = prev && prev.kg ? Math.round((cur.kg - prev.kg) / prev.kg * 1000) / 10 : null;

  return {
    period,
    current: { kg: cur.kg, units: cur.units, momPct },
    months, topProducts: top,
    note: 'Только готовая продукция (НоменклатурнаяГруппа.ЭтоПродукция = Да). Кг = Σ(Количество × вес штуки, кг). Сырьё, полуфабрикаты, компоненты и позиции без заданного веса в кг не входят.',
    refreshedAt: new Date().toISOString()
  };
}

function getProductionKg(period) {
  const p = period || upp.nowYM();
  // Новый ключ не даст пережившему деплой файловому кэшу вернуть прежнюю сумму
  // со всеми строками документа, включая сырьё и полуфабрикаты.
  return cache.wrap('prodkg-ready-v1:' + p, () => compute(p));
}

module.exports = { getProductionKg };
