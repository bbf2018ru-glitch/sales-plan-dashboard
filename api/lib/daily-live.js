// Дневная выручка ЖИВЬЁМ из 1С по РЕАЛЬНОЙ дате чека (а не по soldAt=времени выгрузки).
// Проблема: БД пишет soldAt=момент выгрузки → пачка продаж, выгруженная одним днём,
// сваливается в один день (напр. БД: 31.05 = 16.87М, а в 1С реально 31.05 = 901к).
// Месячный итог при этом верен, но дневное распределение (хитмап «ритм недели») — мусор.
// Берём дни напрямую из ЧекККМ по Ч.Дата (нетто продажа−возврат) → корректный ритм.
const { callQuery, parseRu, nowYM, makeCache } = require('./upp-client');

const cache = makeCache(60 * 60 * 1000, 'daily-live'); // 1ч, per-month

async function build(period) {
  const p = period || nowYM();
  const [y, m] = p.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const q = await callQuery(
    `ВЫБРАТЬ ДЕНЬ(Ч.Дата) КАК Д, СУММА(ВЫБОР КОГДА Ч.ВидОперации = ЗНАЧЕНИЕ(Перечисление.ВидыОперацийЧекККМ.Возврат) ТОГДА -Ч.СуммаДокумента ИНАЧЕ Ч.СуммаДокумента КОНЕЦ) КАК С ИЗ Документ.ЧекККМ КАК Ч ГДЕ Ч.Проведен И Ч.Дата >= ДАТАВРЕМЯ(${y},${m},1) И Ч.Дата < ДАТАВРЕМЯ(${ny},${nm},1) СГРУППИРОВАТЬ ПО ДЕНЬ(Ч.Дата) УПОРЯДОЧИТЬ ПО Д`,
    { timeoutMs: 90000 });
  const rows = (q.rows || []).map(r => ({ day: parseRu(r['Д']), fact: Math.round(parseRu(r['С'])) }))
    .filter(r => r.day >= 1 && r.day <= 31);
  if (!rows.length) throw new Error('пустой ответ 1С');
  return { period: p, source: '1c-live-realdate', daily: rows };
}

async function dailyLive(period) {
  return cache.wrap('d:' + (period || nowYM()), () => build(period));
}

module.exports = { dailyLive };
