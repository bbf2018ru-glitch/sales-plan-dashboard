// Возвраты ЖИВЬЁМ из 1С (ЧекККМ, ВидОперации = Возврат) — заменяет неполные данные
// из БД-выгрузки. Причина: BSL-выгрузка кладёт в БД лишь часть возвратов (оптовые
// со склада ГП ~2 тыс ₽), а розничные возвраты ЧекККМ (≈110 тыс ₽/мес) в БД не
// попадают → блок «Возвраты» занижал в десятки раз. Здесь берём напрямую из 1С.
// NB по УПП Маши: элемент перечисления — `ВидыОперацийЧекККМ.Возврат` (НЕ
// `ВозвратТоваров` — такого литерала нет; проверено 08.06.2026).
const { callQuery, parseRu, nowYM, makeCache } = require('./upp-client');

const cache = makeCache(60 * 60 * 1000, 'returns-live'); // 1ч; per-month
const RET_LINE = 'Т.Ссылка.ВидОперации = ЗНАЧЕНИЕ(Перечисление.ВидыОперацийЧекККМ.Возврат)';

async function build(period) {
  const p = period || nowYM();
  const [y, m] = p.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const DT = `ДАТАВРЕМЯ(${y},${m},1)`, DTEND = `ДАТАВРЕМЯ(${ny},${nm},1)`;
  const WL = `Т.Ссылка.Проведен И Т.Ссылка.Дата >= ${DT} И Т.Ссылка.Дата < ${DTEND} И ${RET_LINE}`;
  const round3 = v => Math.round((parseRu(v) || 0) * 1000) / 1000;

  // По складам (из табличной части — нужны и сумма, и количество единиц).
  const st = await callQuery(
    `ВЫБРАТЬ Т.Ссылка.Склад.Код КАК Код, ВЫРАЗИТЬ(Т.Ссылка.Склад.Наименование КАК СТРОКА(80)) КАК Скл, СУММА(Т.Сумма) КАК Сумма, СУММА(Т.Количество) КАК Кол ИЗ Документ.ЧекККМ.Товары КАК Т ГДЕ ${WL} СГРУППИРОВАТЬ ПО Т.Ссылка.Склад.Код, ВЫРАЗИТЬ(Т.Ссылка.Склад.Наименование КАК СТРОКА(80)) УПОРЯДОЧИТЬ ПО Сумма УБЫВ`,
    { timeoutMs: 90000 });
  const byStore = (st.rows || []).map(r => ({
    storeId: String(r['Код'] || '').trim(),
    storeName: String(r['Скл'] || '').trim(),
    amount: Math.round(parseRu(r['Сумма'])),
    quantity: round3(r['Кол'])
  }));

  // По товарам.
  const pr = await callQuery(
    `ВЫБРАТЬ Т.Номенклатура.Код КАК Код, ВЫРАЗИТЬ(Т.Номенклатура.Наименование КАК СТРОКА(100)) КАК Тов, СУММА(Т.Сумма) КАК Сумма, СУММА(Т.Количество) КАК Кол ИЗ Документ.ЧекККМ.Товары КАК Т ГДЕ ${WL} СГРУППИРОВАТЬ ПО Т.Номенклатура.Код, ВЫРАЗИТЬ(Т.Номенклатура.Наименование КАК СТРОКА(100)) УПОРЯДОЧИТЬ ПО Сумма УБЫВ`,
    { timeoutMs: 120000 });
  const byProduct = (pr.rows || []).map(r => ({
    productId: String(r['Код'] || '').trim(),
    productName: String(r['Тов'] || '').trim(),
    amount: Math.round(parseRu(r['Сумма'])),
    quantity: round3(r['Кол'])
  }));

  const totalAmount = byStore.reduce((s, x) => s + x.amount, 0);
  const totalQuantity = Math.round(byProduct.reduce((s, x) => s + x.quantity, 0) * 1000) / 1000;

  return {
    period: p,
    source: '1c-live',
    totalAmount,
    totalQuantity,
    rowsCount: byProduct.length,
    byStore,
    byProduct: byProduct.slice(0, 100)
  };
}

async function returnsLive(period) {
  return cache.wrap('ret:' + (period || nowYM()), () => build(period));
}

module.exports = { returnsLive };
