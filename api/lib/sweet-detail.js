// Детализация программы «Сладкий чек» из 1С (РегистрНакопления.СладкийЧек + ЧекККМ).
// Отдаёт: всего участников (за всё время), пришло за месяц, текущие задания месяца,
// и сумму покупок участников за весь период действия программы.
const { callQuery, parseRu, nowYM, makeCache } = require('./upp-client');

const cache = makeCache(6 * 60 * 60 * 1000); // 6 часов

function ymBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return { y, m, ny, nm };
}

async function build(period) {
  const { y, m, ny, nm } = ymBounds(period);

  // 1) Всего участников за всё время + дата старта программы
  const q1 = 'ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ БонуснаяКарта) КАК Карт, МИНИМУМ(Период) КАК Старт, МАКСИМУМ(Период) КАК Послед ИЗ РегистрНакопления.СладкийЧек';
  const r1 = await callQuery(q1, { timeoutMs: 60000 });
  const row1 = (r1.rows || [])[0] || {};
  const totalParticipants = parseRu(row1['Карт']) || 0;
  const startStr = String(row1['Старт'] || '');
  const sm = startStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const startY = sm ? Number(sm[3]) : y, startM = sm ? Number(sm[2]) : m;
  const programStart = sm ? `${sm[3]}-${sm[2]}-${sm[1]}` : null;
  const programStartMonth = `${startY}-${String(startM).padStart(2, '0')}`;

  // 2) Пришло в этом месяце (первая активность карты — в выбранном месяце)
  const q2 = `ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Новых ИЗ (ВЫБРАТЬ БонуснаяКарта КАК К, МИНИМУМ(Период) КАК Перв ИЗ РегистрНакопления.СладкийЧек СГРУППИРОВАТЬ ПО БонуснаяКарта) КАК Т ГДЕ Т.Перв >= ДАТАВРЕМЯ(${y},${m},1) И Т.Перв < ДАТАВРЕМЯ(${ny},${nm},1)`;
  const r2 = await callQuery(q2, { timeoutMs: 60000 });
  const newThisMonth = parseRu(((r2.rows || [])[0] || {})['Новых']) || 0;

  // 3) Текущие задания месяца (название, выполнений, баллы, карт)
  const q3 = `ВЫБРАТЬ Задание КАК З, КОЛИЧЕСТВО(*) КАК Вып, СУММА(Баллы) КАК Баллы, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ БонуснаяКарта) КАК Карт ИЗ РегистрНакопления.СладкийЧек ГДЕ Период >= ДАТАВРЕМЯ(${y},${m},1) И Период < ДАТАВРЕМЯ(${ny},${nm},1) СГРУППИРОВАТЬ ПО Задание УПОРЯДОЧИТЬ ПО Вып УБЫВ`;
  const r3 = await callQuery(q3, { timeoutMs: 60000 });
  const tasks = (r3.rows || []).map(r => ({
    name: String(r['З'] || '?').trim(),
    events: parseRu(r['Вып']) || 0,
    points: parseRu(r['Баллы']) || 0,
    cards: parseRu(r['Карт']) || 0
  }));
  const monthEvents = tasks.reduce((s, t) => s + t.events, 0);
  const monthPoints = tasks.reduce((s, t) => s + t.points, 0);

  // карт в заданиях за месяц (уникальных) — отдельным лёгким запросом
  const q3b = `ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ БонуснаяКарта) КАК Карт ИЗ РегистрНакопления.СладкийЧек ГДЕ Период >= ДАТАВРЕМЯ(${y},${m},1) И Период < ДАТАВРЕМЯ(${ny},${nm},1)`;
  const r3b = await callQuery(q3b, { timeoutMs: 60000 });
  const monthCards = parseRu(((r3b.rows || [])[0] || {})['Карт']) || 0;

  // 4) Покупки участников за весь период действия (с месяца старта программы),
  //    группировка по ВидОперации → нетто = продажа − возврат.
  const q4 = `ВЫБРАТЬ Чек.ВидОперации КАК Вид, СУММА(ЕСТЬNULL(Чек.СуммаДокумента,0)) КАК Сумма, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Чек.Ссылка) КАК Чеков, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Чек.ДисконтнаяКарта) КАК Карт ИЗ Документ.ЧекККМ КАК Чек ГДЕ Чек.Проведен И Чек.Дата >= ДАТАВРЕМЯ(${startY},${startM},1) И Чек.ДисконтнаяКарта В (ВЫБРАТЬ РАЗЛИЧНЫЕ Р.БонуснаяКарта ИЗ РегистрНакопления.СладкийЧек КАК Р) СГРУППИРОВАТЬ ПО Чек.ВидОперации`;
  const r4 = await callQuery(q4, { timeoutMs: 110000 });
  let revenue = 0, returns = 0, cheques = 0, buyerCards = 0;
  for (const r of (r4.rows || [])) {
    const isReturn = /возврат/i.test(String(r['Вид'] || ''));
    const sum = parseRu(r['Сумма']);
    const cnt = parseRu(r['Чеков']);
    const crd = parseRu(r['Карт']);
    if (isReturn) { returns += sum; }
    else { revenue += sum; cheques += cnt; buyerCards = Math.max(buyerCards, crd); }
  }

  return {
    period,
    totalParticipants,
    programStart,
    programStartMonth,
    newThisMonth,
    monthCards, monthEvents, monthPoints,
    tasks,
    purchases: {
      since: programStartMonth,
      revenue: Math.round(revenue),
      returns: Math.round(returns),
      net: Math.round(revenue - returns),
      cheques,
      cards: buyerCards
    }
  };
}

async function getSweetDetail(period) {
  const p = period || nowYM();
  return cache.wrap('sweet-detail:' + p, async () => {
    try { return { available: true, ...(await build(p)) }; }
    catch (e) { return { available: false, error: e.message }; }
  });
}

module.exports = { getSweetDetail };
