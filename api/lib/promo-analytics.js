// Промо-аналитика — скидки, купоны, акции, подарочные сертификаты.
// Тянет через HTTP-сервис 1С УПП напрямую.
//
// До обновления BSL (баг с разделителем тысяч) — лимит 999 строк за запрос,
// чанкуем по неделям чтобы охватить весь месяц. После обновления — лимит 100k.

const { fetchUppPackage } = require('./upp-pull');

const BASE_URL = process.env.UPP_PULL_URL || '';
const BASE = BASE_URL.replace(/\/pull(\?.*)?$/, '');

async function callRegister(name, fromYM, toYM, limit = 999) {
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

// Чанкуем месяц на куски (всё равно YYYY-MM/YYYY-MM т.к. /register принимает
// формат YYYY-MM, не дни). До обновления BSL ограничены лимитом 999.
async function fetchAllDiscounts(fromYM, toYM) {
  const data = await callRegister('ПредоставленныеСкидки', fromYM, toYM, 999);
  return {
    rows: data.rows || [],
    truncated: (data.rowsCount || 0) >= 999  // признак что упёрлись в лимит
  };
}

function aggregateDiscounts(rows) {
  const byCondition = new Map();
  const byProduct = new Map();
  const byDoc = new Map();
  let totalSum = 0;

  for (const r of rows) {
    const sum = parseRu(r['СуммаСкидки']);
    totalSum += sum;

    const cond = (r['УсловиеСкидки'] || '').trim() || '—';
    if (!byCondition.has(cond)) byCondition.set(cond, { condition: cond, sum: 0, count: 0 });
    const c = byCondition.get(cond);
    c.sum += sum;
    c.count += 1;

    const prod = (r['Номенклатура'] || '').trim() || '—';
    if (!byProduct.has(prod)) byProduct.set(prod, { product: prod, sum: 0, count: 0 });
    const p = byProduct.get(prod);
    p.sum += sum;
    p.count += 1;

    const doc = (r['ДокументСкидки'] || '').trim() || '—';
    // Извлекаем тип документа (Реализация / Чек ККМ / Отчёт)
    const docType = doc.split(' ').slice(0, 3).join(' ');
    if (!byDoc.has(docType)) byDoc.set(docType, { docType, sum: 0, count: 0 });
    const d = byDoc.get(docType);
    d.sum += sum;
    d.count += 1;
  }

  const sortBySum = (a, b) => b.sum - a.sum;
  return {
    totalSum: Number(totalSum.toFixed(2)),
    totalRows: rows.length,
    byCondition: Array.from(byCondition.values()).sort(sortBySum).map(x => ({ ...x, sum: Number(x.sum.toFixed(2)) })),
    byProduct: Array.from(byProduct.values()).sort(sortBySum).slice(0, 30).map(x => ({ ...x, sum: Number(x.sum.toFixed(2)) })),
    byDocType: Array.from(byDoc.values()).sort(sortBySum).map(x => ({ ...x, sum: Number(x.sum.toFixed(2)) }))
  };
}

async function fetchGiftCertificates(fromYM, toYM) {
  try {
    const data = await callRegister('ПодарочныеСертификаты', fromYM, toYM, 999);
    let total = 0;
    let count = 0;
    for (const r of data.rows || []) {
      total += parseRu(r['Сумма'] || r['СуммаСертификата'] || '0');
      count += 1;
    }
    return {
      movements: count,
      totalSum: Number(total.toFixed(2)),
      truncated: count >= 999
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchCoffeeCertificates(fromYM, toYM) {
  try {
    const data = await callRegister('СертификатыНаКофе', fromYM, toYM, 999);
    let count = 0;
    for (const r of data.rows || []) count += 1;
    return { movements: count, truncated: count >= 999 };
  } catch (e) {
    return { error: e.message };
  }
}

async function buildPromoAnalytics(opts = {}) {
  const now = new Date();
  const fromYM = opts.from || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const toYM = opts.to || fromYM;

  const result = {
    period: { from: fromYM, to: toYM },
    available: !!BASE
  };
  if (!BASE) {
    result.note = 'UPP_PULL_URL не настроен — невозможно тянуть данные из 1С';
    return result;
  }

  try {
    const [discountsRaw, gifts, coffee] = await Promise.all([
      fetchAllDiscounts(fromYM, toYM).catch(e => ({ error: e.message })),
      fetchGiftCertificates(fromYM, toYM),
      fetchCoffeeCertificates(fromYM, toYM)
    ]);
    if (discountsRaw.error) {
      result.discounts = { error: discountsRaw.error };
    } else {
      result.discounts = {
        ...aggregateDiscounts(discountsRaw.rows),
        truncated: discountsRaw.truncated,
        truncatedNote: discountsRaw.truncated
          ? 'Показаны первые 999 строк скидок за период. После обновления BSL HTTP-сервиса (Формат(Лимит, "ЧГ=")) лимит поднимется до 100 000.'
          : null
      };
    }
    result.giftCertificates = gifts;
    result.coffeeCertificates = coffee;
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

module.exports = { buildPromoAnalytics };
