// Промо-аналитика — скидки, купоны, акции, подарочные сертификаты.
// Тянет через HTTP-сервис 1С УПП напрямую.
//
// Лимит 5000 строк за запрос (BSL формат >999 пофикшен).
// чанкуем по неделям чтобы охватить весь месяц. После обновления — лимит 100k.

const { fetchUppPackage } = require('./upp-pull');
const { callQuery } = require('./upp-client');

const BASE_URL = process.env.UPP_PULL_URL || '';
const BASE = BASE_URL.replace(/\/pull(\?.*)?$/, '');

async function callRegister(name, fromYM, toYM, limit = 5000) {
  if (!BASE) throw new Error('UPP_PULL_URL не настроен');
  const url = `${BASE}/register?name=${encodeURIComponent(name)}&from=${fromYM}&to=${toYM}&limit=${limit}`;
  return fetchUppPackage({
    url,
    username: process.env.UPP_PULL_USER,
    password: process.env.UPP_PULL_PASSWORD,
    period: ''
  });
}

function parseRu(num) {
  return parseFloat(String(num || '0').replace(/\s+/g, '').replace(',', '.')) || 0;
}

// Скидки — агрегация В 1С (раньше /register по 5000 строк из ~16к/мес → занижение ~3x).
// Группировки (условие/товар/тип документа) возвращают мало строк → потолок не мешает.
async function buildDiscountsAgg(fromYM, toYM) {
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const ny = tm === 12 ? ty + 1 : ty, nm = tm === 12 ? 1 : tm + 1;
  const WHERE = `П.Период >= ДАТАВРЕМЯ(${fy},${fm},1) И П.Период < ДАТАВРЕМЯ(${ny},${nm},1)`;
  const TBL = 'РегистрНакопления.ПредоставленныеСкидки КАК П';
  const refChq = 'П.ДокументСкидки ССЫЛКА Документ.ЧекККМ';
  const refReal = 'П.ДокументСкидки ССЫЛКА Документ.РеализацияТоваровУслуг';

  const [tot, cond, prod] = await Promise.all([
    // тоталы + разбивка по типу документа (ТИПЗНАЧЕНИЯ в группировке 1С не даёт → CASE+ССЫЛКА)
    callQuery(`ВЫБРАТЬ СУММА(П.СуммаСкидки) КАК С, КОЛИЧЕСТВО(*) КАК N,`
      + ` СУММА(ВЫБОР КОГДА ${refChq} ТОГДА П.СуммаСкидки ИНАЧЕ 0 КОНЕЦ) КАК ЧекС, СУММА(ВЫБОР КОГДА ${refChq} ТОГДА 1 ИНАЧЕ 0 КОНЕЦ) КАК ЧекN,`
      + ` СУММА(ВЫБОР КОГДА ${refReal} ТОГДА П.СуммаСкидки ИНАЧЕ 0 КОНЕЦ) КАК РеалС, СУММА(ВЫБОР КОГДА ${refReal} ТОГДА 1 ИНАЧЕ 0 КОНЕЦ) КАК РеалN`
      + ` ИЗ ${TBL} ГДЕ ${WHERE}`, { timeoutMs: 90000 }),
    callQuery(`ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(П.УсловиеСкидки) КАК Усл, СУММА(П.СуммаСкидки) КАК С, КОЛИЧЕСТВО(*) КАК N ИЗ ${TBL} ГДЕ ${WHERE} СГРУППИРОВАТЬ ПО П.УсловиеСкидки УПОРЯДОЧИТЬ ПО С УБЫВ`, { timeoutMs: 90000 }),
    callQuery(`ВЫБРАТЬ ПЕРВЫЕ 30 ВЫРАЗИТЬ(П.Номенклатура.Наименование КАК СТРОКА(80)) КАК Тов, СУММА(П.СуммаСкидки) КАК С, КОЛИЧЕСТВО(*) КАК N ИЗ ${TBL} ГДЕ ${WHERE} СГРУППИРОВАТЬ ПО ВЫРАЗИТЬ(П.Номенклатура.Наименование КАК СТРОКА(80)) УПОРЯДОЧИТЬ ПО С УБЫВ`, { timeoutMs: 90000 }),
  ]);

  const t = (tot.rows || [])[0] || {};
  const byDocType = [
    { docType: 'Чек ККМ', sum: Number((parseRu(t['ЧекС']) || 0).toFixed(2)), count: parseRu(t['ЧекN']) || 0 },
    { docType: 'Реализация товаров и услуг', sum: Number((parseRu(t['РеалС']) || 0).toFixed(2)), count: parseRu(t['РеалN']) || 0 },
  ].filter(x => x.count > 0).sort((a, b) => b.sum - a.sum);

  return {
    totalSum: Number((parseRu(t['С']) || 0).toFixed(2)),
    totalRows: parseRu(t['N']) || 0,
    byCondition: (cond.rows || []).map(r => ({ condition: (r['Усл'] || '—').trim() || '—', sum: Number((parseRu(r['С']) || 0).toFixed(2)), count: parseRu(r['N']) || 0 })),
    byProduct: (prod.rows || []).map(r => ({ product: (r['Тов'] || '—').trim() || '—', sum: Number((parseRu(r['С']) || 0).toFixed(2)), count: parseRu(r['N']) || 0 })),
    byDocType,
    truncated: false
  };
}

async function fetchGiftCertificates(fromYM, toYM) {
  try {
    const data = await callRegister('ПодарочныеСертификаты', fromYM, toYM, 5000);
    let total = 0;
    let count = 0;
    for (const r of data.rows || []) {
      total += parseRu(r['Сумма'] || r['СуммаСертификата'] || '0');
      count += 1;
    }
    return {
      movements: count,
      totalSum: Number(total.toFixed(2)),
      truncated: count >= 5000
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchCoffeeCertificates(fromYM, toYM) {
  try {
    const data = await callRegister('СертификатыНаКофе', fromYM, toYM, 5000);
    let count = 0;
    for (const r of data.rows || []) count += 1;
    return { movements: count, truncated: count >= 5000 };
  } catch (e) {
    return { error: e.message };
  }
}

// Кеш на 5 минут — старый IIS 1С Маши не любит частых дёрганий
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

async function buildPromoAnalytics(opts = {}) {
  const now = new Date();
  const fromYM = opts.from || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const toYM = opts.to || fromYM;

  const cacheKey = `promo:${fromYM}:${toYM}`;
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
    // ПОСЛЕДОВАТЕЛЬНО (не Promise.all): старый IIS 1С не любит параллельных
    // запросов, один из них падает по таймауту. С последовательным — стабильно.
    const discounts = await buildDiscountsAgg(fromYM, toYM).catch(e => ({ error: e.message }));
    const gifts = await fetchGiftCertificates(fromYM, toYM);
    const coffee = await fetchCoffeeCertificates(fromYM, toYM);

    result.discounts = discounts.error
      ? { error: discounts.error }
      : { ...discounts, truncatedNote: null };
    result.giftCertificates = gifts;
    result.coffeeCertificates = coffee;
  } catch (e) {
    result.error = e.message;
  }

  // Кешируем только успешные ответы — ошибки не сохраняем чтобы retry помог
  if (!result.error && !result.discounts?.error) {
    cache.set(cacheKey, { data: result, at: Date.now() });
  }
  return result;
}

module.exports = { buildPromoAnalytics };
