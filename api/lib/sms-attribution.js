// SMS-атрибуция v2 — по каждой МАРКЕТИНГОВОЙ кампании, привязка к ОФФЕРУ.
//
// Методика (согласована с Машей 2026-06-03):
//  • Тип A (оффер «продукт + срок», напр. «-20% на торты до 10.06»): окно [дата рассылки …
//    дата из текста], конверсия = получатель купил ИМЕННО эту категорию (ЧекККМ.Товары →
//    Номенклатура.НоменклатурнаяГруппа) по карте лояльности в окне.
//  • Тип A «всё» (оффер на всё + срок): любая покупка в окне (привязка слабее — пометка).
//  • Тип B (ссылка без срока, напр. «Открой чек … clck.ru»): цель — переход по ссылке,
//    НЕ покупка. Считается отдельно по статистике clck.ru (пока не подключено — пометка).
//  • Тип C (нет ни срока, ни ссылки): запасное окно 14 дней, любая покупка (пометка «оценка»).
//
// Дедуп: повторные отправки одной рассылки (одинаковый текст) схлопываются в одну
// кампанию (охват = уникальные карты по всем отправкам). Только темы «Реклама»/«Акция».
//
// ⚠️ Базовый уровень: даже привязка к продукту завышена (постоянные клиенты покупают и так).
// Точный прирост даст ТОЛЬКО контрольная группа (холдаут) — отдельный этап.
//
// Перформанс: окна — КОНСТАНТЫ на запрос (per-row ДОБАВИТЬКДАТЕ в JOIN = таймаут).

const fs = require('fs');
const upp = require('./upp-client');
const cache = upp.makeCache(6 * 60 * 60 * 1000);
const EXT_DIR = process.env.MARKETING_DATA_DIR || '/opt/marketing-data';
function readExt(file) { try { return JSON.parse(fs.readFileSync(EXT_DIR + '/' + file, 'utf8')); } catch (_) { return null; } }
// Переходы по ссылкам (Тип B) считает серверный скрейпер scrape-metrika-entry.js:
// резолвит clck.ru/код→clckid реальным браузером (сервер ловит капчу) + визиты из Метрики
// → sms-clicks.json.byCode[код]. Здесь только читаем готовый файл.
const FALLBACK_DAYS = 14;
const MIN_RECIPIENTS = 100;
const MAX_CAMPAIGNS = 30;

const MARKETING_RE = /реклам|акци|подар|бонус|промо|рассылк/i;
const LINK_RE = /https?:\/\/|clck\.ru|[a-zа-я0-9-]+\.(ru|com|ru\/)/i;

// Словарь продукт → паттерны НоменклатурнаяГруппа (ПОДОБНО).
const PRODUCTS = [
  { kw: /торт/i, patterns: ['%торт%'], label: 'торты' },
  { kw: /пирог/i, patterns: ['%пирог%'], label: 'пироги' },
  { kw: /десерт|пирожн/i, patterns: ['%десерт%', '%пирожн%'], label: 'десерты' },
  { kw: /кофе|капучино|латте/i, patterns: ['%кофе%'], label: 'кофе' },
  { kw: /бенто/i, patterns: ['%бенто%'], label: 'бенто-торты' }
];
const ALL_RE = /на всё|на все|всё в марии|все в марии|весь ассортимент/i;

function pad(n) { return String(n).padStart(2, '0'); }
function parseDt(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return { y: +m[3], m: +m[2], d: +m[1], hh: +(m[4] || 0), mm: +(m[5] || 0), ss: +(m[6] || 0) };
}
function dtLit(p) { return `ДАТАВРЕМЯ(${p.y},${p.m},${p.d},${p.hh},${p.mm},${p.ss})`; }
function dayLit(p, endOfDay) { return `ДАТАВРЕМЯ(${p.y},${p.m},${p.d}${endOfDay ? ',23,59,59' : ''})`; }
function plusDays(p, days) {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d, p.hh || 0, p.mm || 0, p.ss || 0) + days * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function monthBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { y, m, ny: next[0], nm: next[1] };
}
function normText(t) { return String(t || '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim(); }

// Парс оффера из текста: срок «до DD.MM» + продукт(ы) + ссылка.
function parseOffer(text, year) {
  const t = String(text || '');
  let end = null;
  const dm = /до\s*(\d{1,2})[.\s]+(\d{1,2})/i.exec(t);
  if (dm) { const d = +dm[1], mo = +dm[2]; if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) end = { y: year, m: mo, d }; }
  const hasLink = LINK_RE.test(t);
  const prods = PRODUCTS.filter((p) => p.kw.test(t));
  const isAll = ALL_RE.test(t) || (!prods.length);
  return { end, hasLink, products: prods, isAll, text: t };
}

function campaignListQuery(period) {
  const b = monthBounds(period);
  return 'ВЫБРАТЬ П.Ссылка.Дата КАК Дата, П.Ссылка.Тема КАК Тема,'
    + ' МАКСИМУМ(ВЫРАЗИТЬ(П.Ссылка.ТекстПисьма КАК СТРОКА(300))) КАК Текст,'
    + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Получатель) КАК Получателей'
    + ' ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ` ГДЕ П.Ссылка.Дата >= ДАТАВРЕМЯ(${b.y},${b.m},1) И П.Ссылка.Дата < ДАТАВРЕМЯ(${b.ny},${b.nm},1)`
    + ' СГРУППИРОВАТЬ ПО П.Ссылка, П.Ссылка.Дата, П.Ссылка.Тема'
    + ` ИМЕЮЩИЕ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Получатель) >= ${MIN_RECIPIENTS}`
    + ' УПОРЯДОЧИТЬ ПО Получателей УБЫВ';
}

// Условие категории: OR из ПОДОБНО по НоменклатурнаяГруппа.
function categoryCond(products) {
  const pats = products.reduce((a, p) => a.concat(p.patterns), []);
  if (!pats.length) return null;
  return '(' + pats.map((p) => `ВЫРАЗИТЬ(Т.Номенклатура.НоменклатурнаяГруппа.Наименование КАК СТРОКА(100)) ПОДОБНО "${p}"`).join(' ИЛИ ') + ')';
}

// Конверсия по КАТЕГОРИИ (ЧекККМ.Товары) для набора дат-отправок dts в окне [from..to].
function categoryQuery(dts, from, to, products) {
  const inList = dts.map(dtLit).join(', ');
  const cat = categoryCond(products);
  return 'ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Получатель) КАК Получателей,'
    + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ ВЫБОР КОГДА Т.Ссылка ЕСТЬ НЕ NULL ТОГДА П.Получатель КОНЕЦ) КАК Купили,'
    + ' СУММА(ЕСТЬNULL(Т.Сумма,0)) КАК Выручка'
    + ' ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ Документ.ЧекККМ.Товары КАК Т ПО Т.Ссылка.ДисконтнаяКарта = П.Получатель'
    + ` И Т.Ссылка.Дата >= ${from} И Т.Ссылка.Дата <= ${to}`
    + (cat ? ' И ' + cat : '')
    + ` ГДЕ П.Ссылка.Дата В (${inList})`;
}

// Конверсия по ЛЮБОЙ покупке (ЧекККМ header) — для «на всё» и Тип C.
function anyPurchaseQuery(dts, from, to) {
  const inList = dts.map(dtLit).join(', ');
  return 'ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Получатель) КАК Получателей,'
    + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ ВЫБОР КОГДА Чек.Ссылка ЕСТЬ НЕ NULL ТОГДА П.Получатель КОНЕЦ) КАК Купили,'
    + ' СУММА(ЕСТЬNULL(Чек.СуммаДокумента,0)) КАК Выручка'
    + ' ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ Документ.ЧекККМ КАК Чек ПО Чек.ДисконтнаяКарта = П.Получатель'
    + ` И Чек.Дата >= ${from} И Чек.Дата <= ${to}`
    + ` ГДЕ П.Ссылка.Дата В (${inList})`;
}

// Регистрации в «Сладком чеке» среди получателей: карты, чьё ПЕРВОЕ участие в регистре
// СладкийЧек пришлось на/после даты рассылки (ссылка вела на страницу регистрации).
function sweetRegQuery(dts, fromDay) {
  const inList = dts.map(dtLit).join(', ');
  return 'ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Рег ИЗ ('
    + ' ВЫБРАТЬ П.Получатель КАК К, МИНИМУМ(СЧ.Период) КАК Перв'
    + ' ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ' ВНУТРЕННЕЕ СОЕДИНЕНИЕ РегистрНакопления.СладкийЧек КАК СЧ ПО СЧ.БонуснаяКарта = П.Получатель'
    + ` ГДЕ П.Ссылка.Дата В (${inList})`
    + ' СГРУППИРОВАТЬ ПО П.Получатель'
    + ` ИМЕЮЩИЕ МИНИМУМ(СЧ.Период) >= ${fromDay}) КАК Т`;
}

// Уникальных получателей (карт) по набору дат-отправок — для базы затрат (без дублей-ресендов).
function uniqueRecipQuery(dts) {
  const inList = dts.map(dtLit).join(', ');
  return 'ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Получатель) КАК У ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ` ГДЕ П.Ссылка.Дата В (${inList})`;
}

function row1(res) {
  const r = (res && res.rows && res.rows[0]) || {};
  const recipients = upp.parseRu(r.Получателей), buyers = upp.parseRu(r.Купили), revenue = upp.parseRu(r.Выручка);
  return { recipients, buyers, revenue, conversionPct: recipients ? Math.round(buyers / recipients * 1000) / 10 : 0, avgCheck: buyers ? Math.round(revenue / buyers) : 0 };
}

// Прирост к собственному базовому уровню (квази-контроль без потери охвата):
// сравнение конверсии в окне оффера с конверсией ТЕХ ЖЕ получателей в равный период ДО.
function liftOf(offerRow, baselineRow) {
  const baselinePct = baselineRow.conversionPct;
  const liftPct = Math.round((offerRow.conversionPct - baselinePct) * 10) / 10;
  const incremental = Math.max(0, Math.round(liftPct / 100 * offerRow.recipients));
  const incRevenue = offerRow.avgCheck ? incremental * offerRow.avgCheck : 0;
  return { baselinePct, baselineBuyers: baselineRow.buyers, liftPct, incremental, incRevenue };
}

async function compute(period) {
  const smsClicks = readExt('sms-clicks.json') || { byClckid: {} };
  const list = await upp.callQuery(campaignListQuery(period));
  if (!list || !list.rows) return { period, error: 'нет ответа 1С', campaigns: [] };

  // Только маркетинг + дедуп по нормализованному тексту.
  const byText = new Map();
  for (const r of list.rows) {
    if (!MARKETING_RE.test(r.Тема || '')) continue;
    const dt = parseDt(r.Дата); if (!dt) continue;
    const key = normText(r.Текст) || ('doc-' + r.Дата);
    if (!byText.has(key)) byText.set(key, { text: (r.Текст || '').trim(), theme: r.Тема, dts: [], sends: 0 });
    const g = byText.get(key);
    g.dts.push(dt); g.sends += upp.parseRu(r.Получателей);
  }
  let groups = Array.from(byText.values())
    .sort((a, b) => b.sends - a.sends)
    .slice(0, MAX_CAMPAIGNS);

  const campaigns = [];
  for (const g of groups) {
    g.dts.sort((a, b) => Date.UTC(a.y, a.m - 1, a.d, a.hh, a.mm, a.ss) - Date.UTC(b.y, b.m - 1, b.d, b.hh, b.mm, b.ss));
    const first = g.dts[0];
    const offer = parseOffer(g.text, first.y);
    const base = {
      text: g.text, theme: g.theme, sends: g.sends, sendsCount: g.dts.length,
      firstDate: `${pad(first.d)}.${pad(first.m)}.${first.y}`,
      endDate: offer.end ? `${pad(offer.end.d)}.${pad(offer.end.m)}.${offer.end.y}` : null
    };
    try {
      if (offer.end && !offer.isAll && offer.products.length) {
        // Тип A: продукт + срок.
        const a = row1(await upp.callQuery(categoryQuery(g.dts, dayLit(first), dayLit(offer.end, true), offer.products), { timeoutMs: 50000 }));
        const Ld = Math.max(1, Math.round((Date.UTC(offer.end.y, offer.end.m - 1, offer.end.d) - Date.UTC(first.y, first.m - 1, first.d)) / 86400000));
        let lift = {};
        try { const bl = row1(await upp.callQuery(categoryQuery(g.dts, dayLit(plusDays(first, -Ld)), dayLit(first), offer.products), { timeoutMs: 50000 })); lift = liftOf(a, bl); } catch (_) {}
        campaigns.push({ ...base, type: 'A', product: offer.products.map((p) => p.label).join(', '), metric: 'покупка категории', ...a, ...lift });
      } else if (offer.end && offer.isAll) {
        // Тип A «всё» + срок: любая покупка в окне.
        const a = row1(await upp.callQuery(anyPurchaseQuery(g.dts, dayLit(first), dayLit(offer.end, true)), { timeoutMs: 50000 }));
        const Ld = Math.max(1, Math.round((Date.UTC(offer.end.y, offer.end.m - 1, offer.end.d) - Date.UTC(first.y, first.m - 1, first.d)) / 86400000));
        let lift = {};
        try { const bl = row1(await upp.callQuery(anyPurchaseQuery(g.dts, dayLit(plusDays(first, -Ld)), dayLit(first)), { timeoutMs: 50000 })); lift = liftOf(a, bl); } catch (_) {}
        campaigns.push({ ...base, type: 'A*', product: 'всё', metric: 'любая покупка (оффер на всё)', ...a, ...lift });
      } else if (offer.hasLink) {
        // Тип B: ссылка — переходы из Метрики. clck.ru/код→clckid→визиты резолвит серверный
        // скрейпер (браузером, сервер ловит капчу) и кладёт в sms-clicks.json.byCode[код].
        let clicks = null, dest = '';
        const cm = /clck\.ru\/([a-z0-9]+)/i.exec(g.text);
        if (cm && smsClicks.byCode && smsClicks.byCode[cm[1]] != null) clicks = smsClicks.byCode[cm[1]];
        if (cm && smsClicks.codeToUrl) dest = smsClicks.codeToUrl[cm[1]] || '';
        // Уникальный охват (без дублей-ресендов) — для конверсии и затрат.
        let uniq = g.sends;
        try { uniq = upp.parseRu((await upp.callQuery(uniqueRecipQuery(g.dts))).rows[0].У) || g.sends; } catch (_) {}
        // Если ссылка ведёт на /for_clients/ (регистрация в Сладком чеке) — считаем регистрации.
        let sweetReg = null;
        if (/for_clients/i.test(dest)) {
          try { const sr = await upp.callQuery(sweetRegQuery(g.dts, dayLit(first))); sweetReg = upp.parseRu((sr.rows && sr.rows[0] || {}).Рег); } catch (_) {}
        }
        if (clicks != null) {
          campaigns.push({ ...base, type: 'B', product: 'переход по ссылке', metric: 'переходов по ссылке (Метрика)', recipients: uniq, buyers: clicks, revenue: null, conversionPct: uniq ? Math.round(clicks / uniq * 1000) / 10 : 0, avgCheck: null, isClicks: true, dest, sweetReg });
        } else {
          campaigns.push({ ...base, type: 'B', product: 'переход по ссылке', metric: 'переходы — пока нет данных Метрики', recipients: uniq, buyers: null, revenue: null, conversionPct: null, avgCheck: null, linkPending: true, dest, sweetReg });
        }
      } else {
        // Тип C: нет срока и ссылки — запасное окно, любая покупка (оценка).
        const to = plusDays(first, FALLBACK_DAYS);
        const a = row1(await upp.callQuery(anyPurchaseQuery(g.dts, dayLit(first), dayLit(to, true)), { timeoutMs: 50000 }));
        campaigns.push({ ...base, type: 'C', product: '—', metric: 'любая покупка, окно ' + FALLBACK_DAYS + 'д (оценка)', ...a });
      }
    } catch (e) {
      campaigns.push({ ...base, type: '?', error: e.message, recipients: g.sends, buyers: null, revenue: null, conversionPct: null, avgCheck: null });
    }
  }

  // Затраты = ВСЕГО отправленных сообщений × цена SMS (env MKT_SMS_PRICE, дефолт 8.5) —
  // как тарифицирует оператор (за каждое сообщение). Отдельно считаем переплату на повторных
  // отправках одной рассылки тем же людям: dupCost = (отправлено − уникальных) × цена.
  const smsPrice = Number(process.env.MKT_SMS_PRICE) || 8.5;
  campaigns.forEach((c) => {
    c.cost = Math.round((c.sends || 0) * smsPrice);
    c.dupSends = Math.max(0, (c.sends || 0) - (c.recipients || 0));
    c.dupCost = Math.round(c.dupSends * smsPrice);
  });
  const sum = (k) => campaigns.reduce((s, c) => s + (c[k] || 0), 0);
  const totals = {
    sends: sum('sends'), recipients: sum('recipients'), cost: sum('cost'), dupCost: sum('dupCost'),
    revenue: sum('revenue'), buyers: sum('buyers'), sweetReg: sum('sweetReg'), smsPrice,
    incremental: sum('incremental'), incRevenue: sum('incRevenue'),
    conversionPct: sum('recipients') ? Math.round(sum('buyers') / sum('recipients') * 1000) / 10 : 0
  };

  return {
    period, campaigns, campaignsCount: campaigns.length, totals, smsPrice,
    methodNote: 'Конверсия привязана к офферу: Тип A — купил ИМЕННО акционную категорию в окне [дата рассылки … срок из текста]; «всё»+срок — любая покупка в окне; ссылочные (Тип B) — ПЕРЕХОДЫ по ссылке из Яндекс.Метрики; без срока/ссылки (Тип C) — окно ' + FALLBACK_DAYS + 'д, оценка. Только «Реклама»/«Акция». «Отправлено» = всего сообщений (с повторными отправками), «Получателей» = уникальных людей; затраты = всего отправок × ' + smsPrice + ' ₽. Если рассылку отправили ×N одним и тем же — это переплата (показана отдельно). Конверсия — по уникальным получателям. Итого «купили/перешли» — смешанная сумма (покупки + переходы).',
    caveat: '«Прирост» = конверсия в окне оффера МИНУС обычный уровень тех же получателей за равный период ДО рассылки (квази-контроль, без потери охвата). Это и есть покупки БЛАГОДАРЯ акции, а не базовый уровень. Оговорка: на прирост влияет сезонность (настоящий рандомизированный холдаут точнее, но требует не слать части клиентов — от него отказались ради охвата).',
    refreshedAt: new Date().toISOString()
  };
}

function getSmsAttribution(period) {
  const p = period || upp.nowYM();
  return cache.wrap('sms2:' + p, () => compute(p));
}

module.exports = { getSmsAttribution };
