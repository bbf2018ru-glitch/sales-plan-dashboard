// Не-розничные каналы (опт/сайт/агрегаторы/B2B-заказы) ЖИВЬЁМ из 1С.
// Дашборд-факт = только розница (ЧекККМ); реализации (РегистрНакопления.Продажи,
// Подразделения «Отдел интернет продаж»/«Опт»/«Агрегатор»/… ≈3.5М/мес) в БД-выгрузку
// не попадают и в факт не входят. Тянем их напрямую и добавляем строками в «Каналы»
// (отдельно от розничного план/факта — у них своего плана нет).
const { callQuery, parseRu, nowYM, makeCache } = require('./upp-client');

const cache = makeCache(60 * 60 * 1000, 'wholesale-live'); // 1ч, per-month

// Подразделение 1С → читаемый канал.
function channelOf(podr) {
  const p = (podr || '').toLowerCase();
  if (/интернет|сайт/.test(p)) return 'Сайт (интернет-продажи)';
  if (/агрегатор/.test(p)) return 'Агрегаторы (доставка)';
  if (/опт/.test(p)) return 'Опт';
  return 'Прочие реализации (B2B/заказы)';
}

async function build(period) {
  const p = period || nowYM();
  const [y, m] = p.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const q = await callQuery(
    `ВЫБРАТЬ ВЫРАЗИТЬ(П.Подразделение.Наименование КАК СТРОКА(60)) КАК Подр, СУММА(П.Стоимость) КАК Ст, СУММА(П.Количество) КАК Кол, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Регистратор) КАК Док ИЗ РегистрНакопления.Продажи КАК П ГДЕ П.Период >= ДАТАВРЕМЯ(${y},${m},1) И П.Период < ДАТАВРЕМЯ(${ny},${nm},1) СГРУППИРОВАТЬ ПО ВЫРАЗИТЬ(П.Подразделение.Наименование КАК СТРОКА(60))`,
    { timeoutMs: 90000 });
  const acc = new Map(); // channel -> {fact, quantity, docs}
  for (const r of q.rows || []) {
    const ch = channelOf(r['Подр']);
    if (!acc.has(ch)) acc.set(ch, { source: ch, plan: 0, fact: 0, quantity: 0, storesCount: 0, cost: 0, margin: null, marginPct: null, completion: null, nonRetail: true });
    const a = acc.get(ch);
    a.fact += parseRu(r['Ст']); a.quantity += parseRu(r['Кол']); a.storesCount += parseRu(r['Док']) || 0;
  }
  const channels = [...acc.values()].map(a => ({ ...a, fact: Math.round(a.fact), quantity: Math.round(a.quantity * 1000) / 1000 }))
    .filter(a => a.fact !== 0).sort((a, b) => b.fact - a.fact);
  const total = channels.reduce((s, c) => s + c.fact, 0);
  return { period: p, source: '1c-live', total, channels };
}

async function wholesaleLive(period) {
  return cache.wrap('ws:' + (period || nowYM()), () => build(period));
}

module.exports = { wholesaleLive };
