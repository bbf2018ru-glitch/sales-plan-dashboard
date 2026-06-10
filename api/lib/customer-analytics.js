// Клиентская аналитика — работает напрямую через HTTP-сервис 1С УПП.
// Тянет регистры Бонусы / ИнформационныеКарты / Продажи и строит отчёты:
//
//   - Топ клиентов по бонусам (по сумме движений за период)
//   - Активные карты (число)
//   - Дни рождения сегодня / на этой неделе
//   - Гео-распределение по микрорайонам
//
// Зависит от UPP_PULL_URL (HTTP-сервис 1С) — не от данных в нашей БД.

const { callQuery, parseRu } = require('./upp-client');

// Граница периода YYYY-MM → выражения ДАТАВРЕМЯ для запроса [начало; начало след. месяца).
function periodBounds(fromYM, toYM) {
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const ny = tm === 12 ? ty + 1 : ty;
  const nm = tm === 12 ? 1 : tm + 1;
  return { DT: `ДАТАВРЕМЯ(${fy},${fm},1)`, DTEND: `ДАТАВРЕМЯ(${ny},${nm},1)` };
}

const BASE_URL = process.env.UPP_PULL_URL || '';
const BASE = BASE_URL.replace(/\/pull(\?.*)?$/, '');

// Служебные/безымянные карты — те же фильтры, что в топах по обороту
// (marketing-analytics.js / extended-analytics.js). Здесь только по названию карты:
// регистр Бонусы не отдаёт ВидДисконтнойКарты, поэтому опт по виду не отсекаем —
// но видимый мусор (магазин/склад/«нет»/без ФИО типа «ВК3 000383») уходит.
const INTERNAL_CARD = /магазин|склад|кондитерск|(^|\s)(нет|дс)(\s|$)/i;
const NONAME = /^[а-яёa-z]{1,4}\d*\s+\d+\s*$/i;
const isServiceCard = (name) => INTERNAL_CARD.test(name) || NONAME.test(name);

// Бонусы за период. Агрегируем В 1С (а не построчно): и /register, и /query_post
// режут выдачу на 5000–10000 строк, а движений в месяц ~33к — построчное чтение
// занижало активные карты (4.6к↔10.8к) и суммы в 2-3 раза. Группировка/счётчики
// возвращают мало строк → потолок не мешает, цифры точные.
async function bonusMovements(fromYM, toYM) {
  const { DT, DTEND } = periodBounds(fromYM, toYM);
  const WHERE = `Б.Период >= ${DT} И Б.Период < ${DTEND}`;
  const PRIH = `Б.ВидДвижения = ЗНАЧЕНИЕ(ВидДвиженияНакопления.Приход)`;

  const [sumRows, topRows] = await Promise.all([
    // Итоги: точные активные карты, число движений, начислено (Приход), списано (Расход)
    callQuery(
      `ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Б.БонуснаяКарта) КАК Карт, КОЛИЧЕСТВО(*) КАК Движ,`
      + ` СУММА(ВЫБОР КОГДА ${PRIH} ТОГДА Б.Сумма ИНАЧЕ 0 КОНЕЦ) КАК Начислено,`
      + ` СУММА(ВЫБОР КОГДА НЕ (${PRIH}) ТОГДА Б.Сумма ИНАЧЕ 0 КОНЕЦ) КАК Списано`
      + ` ИЗ РегистрНакопления.Бонусы КАК Б ГДЕ ${WHERE}`, { timeoutMs: 90000 }),
    // Топ карт по НАЧИСЛЕНО (Приход). Берём 200 — после фильтра служебных режем до 100.
    callQuery(
      `ВЫБРАТЬ ПЕРВЫЕ 200 ВЫРАЗИТЬ(Б.БонуснаяКарта.Наименование КАК СТРОКА(100)) КАК Карта,`
      + ` СУММА(Б.Сумма) КАК Сумма, КОЛИЧЕСТВО(*) КАК Движ`
      + ` ИЗ РегистрНакопления.Бонусы КАК Б ГДЕ ${WHERE} И ${PRIH}`
      + ` СГРУППИРОВАТЬ ПО ВЫРАЗИТЬ(Б.БонуснаяКарта.Наименование КАК СТРОКА(100))`
      + ` УПОРЯДОЧИТЬ ПО Сумма УБЫВ`, { timeoutMs: 90000 }),
  ]);

  const s = (sumRows.rows || [])[0] || {};
  const topCards = (topRows.rows || [])
    .map(r => ({ card: (r['Карта'] || '').trim(), sum: parseRu(r['Сумма']), movements: parseRu(r['Движ']) || 0 }))
    .filter(c => c.card && !isServiceCard(c.card))
    .slice(0, 100)
    .map(c => ({ ...c, sum: Number(c.sum.toFixed(2)) }));

  return {
    period: { from: fromYM, to: toYM },
    totalCards: parseRu(s['Карт']) || 0,
    totalMovements: parseRu(s['Движ']) || 0,
    capped: false, // агрегация в 1С — потолка строк больше нет
    totalSum: Number((parseRu(s['Начислено']) || 0).toFixed(2)), // «Бонусов начислено» = Приход
    bonusRedeemed: Number((parseRu(s['Списано']) || 0).toFixed(2)),
    topCards
  };
}

// Дни рождения на этой неделе — будет работать после обновления HTTP-сервиса
// (требует /products-detail или специальный endpoint для карт).
// Пока возвращаем заглушку.
async function birthdays() {
  return {
    available: false,
    note: 'Требует расширения HTTP-сервиса — endpoint для перечисления Справочник.ИнформационныеКарты с реквизитами ДатаРождения, ФИО, ВК-номер. Будет активирован после обновления BSL.'
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

async function buildCustomerAnalytics(opts = {}) {
  const now = new Date();
  const fromYM = opts.from || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const toYM = opts.to || fromYM;
  const cacheKey = `cust:${fromYM}:${toYM}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.data, fromCache: true };
  }
  const result = {
    period: { from: fromYM, to: toYM },
    available: !!BASE
  };
  if (!BASE) {
    result.note = 'UPP_PULL_URL не настроен — невозможно тянуть данные из 1С';
    return result;
  }
  try {
    // bonuses и cardCount тянут одни и те же данные — оптимизируем
    // одним запросом + переиспользуем для obeих метрик.
    result.bonuses = await bonusMovements(fromYM, toYM).catch(e => ({ error: e.message }));
    if (result.bonuses && !result.bonuses.error) {
      result.activeCardsThisPeriod = {
        activeCards: result.bonuses.totalCards,
        totalMovements: result.bonuses.totalMovements
      };
    }
    result.birthdays = await birthdays();
  } catch (e) {
    result.error = e.message;
  }
  if (!result.error && !result.bonuses?.error) {
    cache.set(cacheKey, { data: result, at: Date.now() });
  }
  return result;
}

module.exports = { buildCustomerAnalytics };
