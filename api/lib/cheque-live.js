// Чеки ЖИВЬЁМ из 1С (Документ.ЧекККМ) — заменяет пустую таблицу cheque_stats.
// Причина: старый push-BSL-модуль не присылает агрегаты чеков (db.chequeStats = []
// на проде), поэтому chequeReports()/chequesByStoreFormat() в sales-analytics.js
// возвращали null и блоки подвкладки «Сеть» (средний чек, кол-во чеков, % с картой,
// чеки по форматам, скидки по видам) были вечно пустыми. Здесь берём всё напрямую
// из 1С через /query_post — тот же паттерн, что returns-live/time-live/daily-live.
//
// NB по УПП Маши:
//  - выручка чека = Ч.СуммаДокумента (фактически оплачено), НЕ Σ Товары.Сумma.
//  - возвраты исключаем: ВидыОперацийЧекККМ.Возврат (литерала ВозвратТоваров нет).
//  - формат точки = Склад.ВидСклада (поля stores.format из BSL у Маши нет).
//  - карта чека = Ч.ДисконтнаяКарта (тип «Информационные карты»), пустая ссылка = без карты.
const { callQuery, parseRu, nowYM, makeCache } = require('./upp-client');

const cache = makeCache(60 * 60 * 1000, 'cheque-live'); // 1ч; per-month
const NOT_RETURN = 'Ч.ВидОперации <> ЗНАЧЕНИЕ(Перечисление.ВидыОперацийЧекККМ.Возврат)';
const EMPTY_CARD = 'ЗНАЧЕНИЕ(Справочник.ИнформационныеКарты.ПустаяСсылка)';

function pct1(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

async function build(period) {
  const p = period || nowYM();
  const [y, m] = p.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const DT = `ДАТАВРЕМЯ(${y},${m},1)`, DTEND = `ДАТАВРЕМЯ(${ny},${nm},1)`;
  const WH = `Ч.Проведен И Ч.Дата >= ${DT} И Ч.Дата < ${DTEND} И ${NOT_RETURN}`;

  // ── Шапка чеков по складам: кол-во, выручка (СуммаДокумента), с картой, формат ──
  const hq = await callQuery(
    `ВЫБРАТЬ
       Ч.Склад.Код КАК Код,
       ВЫРАЗИТЬ(Ч.Склад.Наименование КАК СТРОКА(80)) КАК Скл,
       Ч.Склад.ВидСклада КАК Формат,
       КОЛИЧЕСТВО(*) КАК Чеков,
       СУММА(Ч.СуммаДокумента) КАК Сумма,
       СУММА(ВЫБОР КОГДА Ч.ДисконтнаяКарта <> ${EMPTY_CARD} ТОГДА 1 ИНАЧЕ 0 КОНЕЦ) КАК СКартой
     ИЗ Документ.ЧекККМ КАК Ч
     ГДЕ ${WH}
     СГРУППИРОВАТЬ ПО Ч.Склад.Код, ВЫРАЗИТЬ(Ч.Склад.Наименование КАК СТРОКА(80)), Ч.Склад.ВидСклада
     УПОРЯДОЧИТЬ ПО Чеков УБЫВ`,
    { timeoutMs: 90000 });

  // ── Скидки/оплаты по складам из табличной части Товары ──
  const dq = await callQuery(
    `ВЫБРАТЬ
       Ч.Ссылка.Склад.Код КАК Код,
       СУММА(Ч.СуммаРучнойСкидки) КАК Ручн,
       СУММА(Ч.СуммаАвтоматическойСкидки) КАК Авто,
       СУММА(Ч.ОплатаПодарочнымиСертификатами) КАК Серт,
       СУММА(Ч.ОплатаБонусами) КАК Бонус
     ИЗ Документ.ЧекККМ.Товары КАК Ч
     ГДЕ Ч.Ссылка.Проведен И Ч.Ссылка.Дата >= ${DT} И Ч.Ссылка.Дата < ${DTEND}
       И Ч.Ссылка.ВидОперации <> ЗНАЧЕНИЕ(Перечисление.ВидыОперацийЧекККМ.Возврат)
     СГРУППИРОВАТЬ ПО Ч.Ссылка.Склад.Код`,
    { timeoutMs: 120000 });

  const discByStore = new Map();
  for (const r of dq.rows || []) {
    discByStore.set(String(r['Код'] || '').trim(), {
      discountManual: Math.round(parseRu(r['Ручн'])),
      discountAuto: Math.round(parseRu(r['Авто'])),
      paymentGift: Math.round(parseRu(r['Серт'])),
      paymentBonus: Math.round(parseRu(r['Бонус']))
    });
  }

  const byStore = (hq.rows || []).map(r => {
    const storeId = String(r['Код'] || '').trim();
    const chequeCount = Math.round(parseRu(r['Чеков']));
    const withCard = Math.round(parseRu(r['СКартой']));
    const factSum = Math.round(parseRu(r['Сумма']));
    const d = discByStore.get(storeId) || { discountManual: 0, discountAuto: 0, paymentGift: 0, paymentBonus: 0 };
    return {
      storeId,
      storeName: String(r['Скл'] || '').trim() || storeId,
      format: String(r['Формат'] || '').trim() || '— без формата',
      source: '',
      chequeCount,
      withCardCount: withCard,
      noCardCount: chequeCount - withCard,
      cardSharePct: pct1(withCard, chequeCount),
      factSum,
      avgCheque: chequeCount > 0 ? Math.round(factSum / chequeCount) : 0,
      ...d
    };
  });

  if (!byStore.length) return null;

  const sum = (k) => byStore.reduce((s, x) => s + x[k], 0);
  const totalCheques = sum('chequeCount');
  const totalWithCard = sum('withCardCount');
  const totalFact = sum('factSum');

  const cheques = {
    totals: {
      chequeCount: totalCheques,
      withCardCount: totalWithCard,
      cardSharePct: pct1(totalWithCard, totalCheques),
      avgCheque: totalCheques > 0 ? Math.round(totalFact / totalCheques) : 0,
      avgChequesPerStore: byStore.length > 0 ? Math.round(totalCheques / byStore.length) : 0
    },
    byStore,
    discountBreakdown: [
      { type: 'Ручная скидка', amount: sum('discountManual') },
      { type: 'Автоматическая скидка', amount: sum('discountAuto') },
      { type: 'Подарочные сертификаты', amount: sum('paymentGift') },
      { type: 'Бонусы', amount: sum('paymentBonus') }
    ].filter(d => d.amount > 0),
    source: '1c-live'
  };

  // ── По форматам складов (ВидСклада из 1С) ──
  const fmtMap = new Map();
  for (const s of byStore) {
    if (!fmtMap.has(s.format)) fmtMap.set(s.format, { format: s.format, chequeCount: 0, factSum: 0, withCardCount: 0, storeCount: 0 });
    const b = fmtMap.get(s.format);
    b.chequeCount += s.chequeCount;
    b.factSum += s.factSum;
    b.withCardCount += s.withCardCount;
    b.storeCount += 1;
  }
  const byStoreFormat = Array.from(fmtMap.values()).map(b => ({
    format: b.format,
    storeCount: b.storeCount,
    chequeCount: b.chequeCount,
    factSum: b.factSum,
    avgCheque: b.chequeCount > 0 ? Math.round(b.factSum / b.chequeCount) : 0,
    cardSharePct: pct1(b.withCardCount, b.chequeCount)
  })).sort((a, b) => b.avgCheque - a.avgCheque);

  return { period: p, cheques, byStoreFormat };
}

async function chequeLive(period) {
  return cache.wrap('cheq:' + (period || nowYM()), () => build(period));
}

module.exports = { chequeLive };
