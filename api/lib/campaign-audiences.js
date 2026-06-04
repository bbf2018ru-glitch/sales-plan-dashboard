// Аудитории для рассылок: живые сегменты из 1С + рекомендованный текст + CSV для рассыльщика.
//
// Сегменты (все: согласие на рассылку + телефон + не заблокирован):
//   dr30        — день рождения в ближайшие 30 дней (слать за 3 дня до ДР)
//   ottok-vip   — покупали на >=5000 ₽ в окне [T-240, T-120), ни одной покупки 4 месяца
//   ottok-bonus — отток (то же окно), не VIP, бонусов >=100 — «бонусы ждут»
//   ottok-rest  — остальной отток (нужен оффер — требует утверждения)
//   sleep60     — ранний отток: последняя покупка 2–4 мес назад (дешевле вернуть, чем ottok)
//   bonus300    — активные (покупка <=60 дн) с бонусами >=300 — пуш на повторный визит
//   newcomers   — карта выдана за 60 дней, <=1 покупки — дожать вторую покупку
//
// Тексты <=70 знаков (кириллическая SMS: 1 сегмент = 70 зн., эмодзи переводят в UCS-2 = 35 зн.).
// Бонусные тексты опираются на РЕАЛЬНЫЕ остатки (Бонусы.Остатки) — утверждения не требуют.
// Офферные («кофе/десерт в подарок») помечены needsApproval — сначала утвердить акцию.
//
// Потолок /query_post = 5000 строк, ?limit= игнорируется → CSV собирается
// keyset-пагинацией по внутреннему Справочник.Код (уникален; КодКарты бывает «Без кода»).

const { callQuery, parseRu, makeCache } = require('./upp-client');

const cache = makeCache(6 * 60 * 60 * 1000, 'campaign-audiences'); // 6ч, персистентно
const SMS_PRICE = 6.28;       // средняя цена SMS из 1С-отчёта «Отправленные SMS» янв–май 2026
const PAGE = 4000;            // < потолка 5000

function pad(n) { return String(n).padStart(2, '0'); }
function dLit(d) { return `ДАТАВРЕМЯ(${d.getFullYear()},${d.getMonth() + 1},${d.getDate()})`; }
function shiftDays(d, days) { const x = new Date(d); x.setDate(x.getDate() + days); return x; }
function ruDate(d) { return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
function segs(t) { const n = String(t).length; return n <= 70 ? 1 : Math.ceil(n / 67); }

// Чистое кириллическое имя <=19 зн. (длиннее — текст вылезает за 1 сегмент)
function cleanName(s) {
  const w = String(s || '').trim().replace(/\s+/g, ' ');
  if (!w || w.length < 2 || w.length > 19 || /[^а-яёА-ЯЁ\- ]/.test(w)) return null;
  return w.split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

// ── Фильтры-сниппеты ─────────────────────────────────────────────────────────
const CARD_OK = 'К.СогласенНаРассылку И НЕ К.Заблокировать И НЕ К.ЭтоГруппа И К.КонтактныйТелефон <> ""';
const CHK_CARD_OK = 'Ч.ДисконтнаяКарта.СогласенНаРассылку И НЕ Ч.ДисконтнаяКарта.Заблокировать И Ч.ДисконтнаяКарта.КонтактныйТелефон <> ""';

// Окно ДР [from, to] включительно — условие по МЕСЯЦ/ДЕНЬ (окно может пересекать месяц)
function birthdayCond(from, to) {
  const parts = [];
  let cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cur <= to) {
    const mEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0); // конец месяца cur
    const upto = mEnd < to ? mEnd : to;
    parts.push(`(МЕСЯЦ(К.ДатаРождения) = ${cur.getMonth() + 1} И ДЕНЬ(К.ДатаРождения) МЕЖДУ ${cur.getDate()} И ${upto.getDate()})`);
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return '(' + parts.join(' ИЛИ ') + ')';
}

// Внутренний запрос «отток»: карты с покупками в [d240,d120), без покупок с d120
function churnInner(d240, d120) {
  return 'ВЫБРАТЬ Ч.ДисконтнаяКарта КАК Карта, СУММА(Ч.СуммаДокумента) КАК Покупки,'
    + ' МАКСИМУМ(ЕСТЬNULL(О.СуммаОстаток, 0)) КАК Бонусы'
    + ' ИЗ Документ.ЧекККМ КАК Ч'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ РегистрНакопления.Бонусы.Остатки КАК О ПО О.БонуснаяКарта = Ч.ДисконтнаяКарта'
    + ` ГДЕ Ч.Проведен И Ч.Дата >= ${dLit(d240)} И Ч.Дата < ${dLit(d120)} И ${CHK_CARD_OK}`
    + ` И Ч.ДисконтнаяКарта НЕ В (ВЫБРАТЬ РАЗЛИЧНЫЕ Ч2.ДисконтнаяКарта ИЗ Документ.ЧекККМ КАК Ч2 ГДЕ Ч2.Проведен И Ч2.Дата >= ${dLit(d120)})`
    + ' СГРУППИРОВАТЬ ПО Ч.ДисконтнаяКарта';
}

// ── Тексты (отправитель — альфа-имя «Мария», бренд в тексте не дублируем) ───
function endOfMonthRu() { const n = new Date(); return ruDate(new Date(n.getFullYear(), n.getMonth() + 1, 0)); }
const TEXTS = {
  dr30: { tpl: '{Имя}, с наступающим! Десерт в подарок при чеке от 1000 р', fallback: 'С наступающим днем рождения! Десерт в подарок при чеке от 1000 р', needsApproval: 'Оффер «десерт в подарок при чеке от 1000 ₽» — утвердить акцию и механику на кассе' },
  'ottok-vip': { tpl: 'Мы скучаем! У вас {N} бонусов на карте. Ждем вас за десертом!', fallback: () => `Скучаем! Кофе в подарок при чеке от 500 р - покажите SMS. До ${endOfMonthRu().slice(0, 5)}`, needsApproval: 'Топ-50 по сумме покупок лучше прозвонить лично; текст без бонусов — оффер «кофе», утвердить' },
  'ottok-bonus': { tpl: 'На вашей карте {N} бонусов! Потратьте их на любимый десерт.', needsApproval: null },
  'ottok-rest': { tpl: () => `Скучаем! Кофе в подарок при чеке от 500 р - покажите SMS. До ${endOfMonthRu().slice(0, 5)}`, needsApproval: 'Оффер «кофе в подарок при чеке от 500 ₽» — утвердить акцию, предупредить кассиров' },
  sleep60: { tpl: 'Давно не виделись! Ваши {N} бонусов ждут - загляните за десертом', fallback: 'Давно не виделись! Загляните за любимым десертом - мы рядом', needsApproval: null },
  bonus300: { tpl: 'У вас {N} бонусов! Оплатите ими часть покупки - ждем вас', needsApproval: null },
  newcomers: { tpl: 'Ваша карта активна! Копите бонусы с каждой покупкой - ждем вас', needsApproval: null },
};
function renderText(def, opts = {}) {
  let t = typeof def === 'function' ? def() : def;
  if (opts.name != null) t = t.replace('{Имя}', opts.name);
  if (opts.bonus != null) t = t.replace('{N}', opts.bonus);
  return t;
}
// Для карточки в UI — шаблон с примером подстановки
function previewText(key) {
  const T = TEXTS[key];
  return renderText(T.tpl, { name: 'Имя', bonus: '350' });
}

// ── Сводка сегментов ─────────────────────────────────────────────────────────
async function buildAudiences() {
  const now = new Date();
  const d60 = shiftDays(now, -60), d120 = shiftDays(now, -120), d240 = shiftDays(now, -240);
  const drTo = shiftDays(now, 30);

  // 1) ДР ближайшие 30 дней
  const qDr = 'ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Всего,'
    + ' СУММА(ВЫБОР КОГДА ЕСТЬNULL(О.СуммаОстаток, 0) >= 50 ТОГДА 1 ИНАЧЕ 0 КОНЕЦ) КАК СБонусами,'
    + ' СУММА(ЕСТЬNULL(О.СуммаОстаток, 0)) КАК СуммаБонусов'
    + ' ИЗ Справочник.ИнформационныеКарты КАК К'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ РегистрНакопления.Бонусы.Остатки КАК О ПО О.БонуснаяКарта = К.Ссылка'
    + ` ГДЕ ${birthdayCond(now, drTo)} И ${CARD_OK}`;

  // 2) Отток: внешняя агрегация над сгруппированным подзапросом
  const qChurn = 'ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Карт,'
    + ' СУММА(ВЫБОР КОГДА Т.Покупки >= 5000 ТОГДА 1 ИНАЧЕ 0 КОНЕЦ) КАК VIP,'
    + ' СУММА(ВЫБОР КОГДА Т.Покупки < 5000 И Т.Бонусы >= 100 ТОГДА 1 ИНАЧЕ 0 КОНЕЦ) КАК СБонусами,'
    + ' СУММА(Т.Бонусы) КАК СуммаБонусов, СУММА(Т.Покупки) КАК СуммаПокупок'
    + ` ИЗ (${churnInner(d240, d120)}) КАК Т`;

  // 3) Ранний отток (последняя покупка 2–4 мес назад)
  const qSleep = 'ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Карт, СУММА(Т.Бонусы) КАК СуммаБонусов'
    + ` ИЗ (${churnInner(d120, d60)}) КАК Т`;

  // 4) Активные с бонусами >=300
  const qBonus = 'ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Карт, СУММА(Т.Бонусы) КАК СуммаБонусов ИЗ ('
    + 'ВЫБРАТЬ Ч.ДисконтнаяКарта КАК Карта, МАКСИМУМ(ЕСТЬNULL(О.СуммаОстаток, 0)) КАК Бонусы'
    + ' ИЗ Документ.ЧекККМ КАК Ч'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ РегистрНакопления.Бонусы.Остатки КАК О ПО О.БонуснаяКарта = Ч.ДисконтнаяКарта'
    + ` ГДЕ Ч.Проведен И Ч.Дата >= ${dLit(d60)} И ${CHK_CARD_OK}`
    + ' СГРУППИРОВАТЬ ПО Ч.ДисконтнаяКарта) КАК Т ГДЕ Т.Бонусы >= 300';

  // 5) Новички без второй покупки (карта выдана за 60 дней)
  const qNew = 'ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Карт ИЗ ('
    + 'ВЫБРАТЬ К.Ссылка КАК Карта, КОЛИЧЕСТВО(Ч.Ссылка) КАК Чеков'
    + ' ИЗ Справочник.ИнформационныеКарты КАК К'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ Документ.ЧекККМ КАК Ч ПО Ч.ДисконтнаяКарта = К.Ссылка И Ч.Проведен'
    + ` ГДЕ К.ДатаКарты >= ${dLit(d60)} И ${CARD_OK}`
    + ' СГРУППИРОВАТЬ ПО К.Ссылка) КАК Т ГДЕ Т.Чеков <= 1';

  const [dr, churn, sleep, bonus, fresh] = await Promise.all(
    [qDr, qChurn, qSleep, qBonus, qNew].map(q => callQuery(q)));
  const r = j => (j && j.rows && j.rows[0]) || {};
  const drR = r(dr), chR = r(churn), slR = r(sleep), boR = r(bonus), frR = r(fresh);
  const n = v => Math.round(parseRu(v) || 0);

  const vip = n(chR['VIP']), chBonus = n(chR['СБонусами']);
  const rest = Math.max(0, n(chR['Карт']) - vip - chBonus);

  function seg(key, title, size, extra) {
    const T = TEXTS[key];
    return Object.assign({
      key, title, size,
      text: previewText(key),
      textLen: String(previewText(key)).length,
      smsCostRub: Math.round(size * SMS_PRICE),
      needsApproval: T.needsApproval || null,
      csvUrl: '/api/marketing/campaign-audience.csv?key=' + key,
    }, extra);
  }

  return {
    generatedAt: new Date().toISOString(),
    smsPrice: SMS_PRICE,
    note: 'Все сегменты: согласие на рассылку + телефон + не заблокирован. Тексты <=70 знаков = 1 SMS-сегмент; эмодзи не вставлять (UCS-2 = 35 зн./сегмент). CSV содержит готовую колонку SMS с подставленными бонусами/именем.',
    windows: {
      churn: `покупали ${ruDate(d240)}–${ruDate(d120)}, без покупок с ${ruDate(d120)}`,
      sleep: `последняя покупка ${ruDate(d120)}–${ruDate(d60)}`,
      dr: `ДР ${ruDate(now)}–${ruDate(drTo)}`,
    },
    segments: [
      seg('dr30', 'Дни рождения (30 дней)', n(drR['Всего']), {
        desc: 'Слать за 3 дня до ДР (колонка ДатаОтправки в CSV). Лучшая конверсия из возможных — SMS ждут.',
        bonusSum: n(drR['СуммаБонусов']), withBonus: n(drR['СБонусами']),
        priority: 1,
      }),
      seg('ottok-vip', 'Отток: VIP (>=5000 ₽)', vip, {
        desc: 'Покупали на 5000+ ₽ за «активное» окно и пропали на 4 месяца. Самая дорогая потеря — топ списка лучше прозвонить.',
        avgSpent: vip ? Math.round(n(chR['СуммаПокупок']) / Math.max(1, n(chR['Карт']))) : 0,
        priority: 2,
      }),
      seg('ottok-bonus', 'Отток: с бонусами >=100', chBonus, {
        desc: 'Ушли, но на карте лежат бонусы — самый дешёвый крючок («бонусы ждут»). Текст не требует утверждения.',
        bonusSum: n(chR['СуммаБонусов']),
        priority: 3,
      }),
      seg('ottok-rest', 'Отток: остальные', rest, {
        desc: 'Ушли, бонусов нет — нужен оффер. Слать частями по ~3000 после замера конверсии на VIP/бонусных волнах.',
        priority: 6,
      }),
      seg('sleep60', 'Засыпающие (2–4 мес)', n(slR['Карт']), {
        desc: 'Ранний отток: ещё не потеряны окончательно — вернуть дешевле, чем 4-месячный отток. Слать раньше остальных волн оттока.',
        bonusSum: n(slR['СуммаБонусов']),
        priority: 4,
      }),
      seg('bonus300', 'Активные с бонусами >=300', n(boR['Карт']), {
        desc: 'Покупали за последние 60 дней, накопили 300+ бонусов. Напоминание о бонусах = доп. визит. Без офферов и скидок.',
        bonusSum: n(boR['СуммаБонусов']),
        priority: 5,
      }),
      seg('newcomers', 'Новички без 2-й покупки', n(frR['Карт']), {
        desc: 'Карта выдана за последние 60 дней, максимум 1 чек. Дожать вторую покупку, пока помнят о нас.',
        priority: 7,
      }),
    ],
  };
}

async function getAudiences({ force = false } = {}) {
  const key = 'audiences';
  if (!force) { const hit = cache.get(key); if (hit) return { ...hit, fromCache: true }; }
  const data = await buildAudiences();
  cache.set(key, data);
  return data;
}

// ── CSV-выгрузка сегмента ────────────────────────────────────────────────────
async function pageAll(makeQuery) {
  let last = '', all = []; const seen = new Set();
  for (let p = 0; p < 30; p++) { // защитный потолок 120к строк
    const j = await callQuery(makeQuery(last));
    const rows = (j && j.rows) || [];
    for (const r of rows) { const k = r['Ключ']; if (!seen.has(k)) { seen.add(k); all.push(r); } }
    if (rows.length < PAGE) break;
    last = rows[rows.length - 1]['Ключ'];
  }
  return all;
}
const CARD_FIELDS = 'К.Код КАК Ключ, К.КодКарты КАК Код, К.Фамилия КАК Фамилия, К.Имя КАК Имя, К.КонтактныйТелефон КАК Телефон, К.КонтактныйТелефонПриведенный КАК ТелефонНорм';
const CHK_FIELDS = 'Ч.ДисконтнаяКарта.Код КАК Ключ, Ч.ДисконтнаяКарта.КодКарты КАК Код, Ч.ДисконтнаяКарта.Фамилия КАК Фамилия, Ч.ДисконтнаяКарта.Имя КАК Имя, Ч.ДисконтнаяКарта.КонтактныйТелефон КАК Телефон, Ч.ДисконтнаяКарта.КонтактныйТелефонПриведенный КАК ТелефонНорм';
const CHK_GROUP = 'Ч.ДисконтнаяКарта.Код, Ч.ДисконтнаяКарта.КодКарты, Ч.ДисконтнаяКарта.Фамилия, Ч.ДисконтнаяКарта.Имя, Ч.ДисконтнаяКарта.КонтактныйТелефон, Ч.ДисконтнаяКарта.КонтактныйТелефонПриведенный';

function churnPageQuery(d240, d120, having) {
  return last => `ВЫБРАТЬ ПЕРВЫЕ ${PAGE} ${CHK_FIELDS},`
    + ' КОЛИЧЕСТВО(*) КАК Чеков, СУММА(Ч.СуммаДокумента) КАК Покупки,'
    + ' МАКСИМУМ(Ч.Дата) КАК ПоследняяПокупка, МАКСИМУМ(ЕСТЬNULL(О.СуммаОстаток, 0)) КАК Бонусы'
    + ' ИЗ Документ.ЧекККМ КАК Ч'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ РегистрНакопления.Бонусы.Остатки КАК О ПО О.БонуснаяКарта = Ч.ДисконтнаяКарта'
    + ` ГДЕ Ч.Проведен И Ч.Дата >= ${dLit(d240)} И Ч.Дата < ${dLit(d120)} И ${CHK_CARD_OK}`
    + ` И Ч.ДисконтнаяКарта.Код > "${last}"`
    + ` И Ч.ДисконтнаяКарта НЕ В (ВЫБРАТЬ РАЗЛИЧНЫЕ Ч2.ДисконтнаяКарта ИЗ Документ.ЧекККМ КАК Ч2 ГДЕ Ч2.Проведен И Ч2.Дата >= ${dLit(d120)})`
    + ` СГРУППИРОВАТЬ ПО ${CHK_GROUP}`
    + (having ? ` ИМЕЮЩИЕ ${having}` : '')
    + ' УПОРЯДОЧИТЬ ПО Ключ';
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(header, rows) {
  return '﻿' + [header.join(';')].concat(rows.map(r => r.map(csvCell).join(';'))).join('\r\n');
}
const baseCols = r => [r['Код'], r['Фамилия'], r['Имя'], r['Телефон'], r['ТелефонНорм']];
const BASE_HEAD = ['КодКарты', 'Фамилия', 'Имя', 'Телефон', 'ТелефонНорм'];

async function getAudienceCsv(key) {
  const now = new Date();
  const d60 = shiftDays(now, -60), d120 = shiftDays(now, -120), d240 = shiftDays(now, -240);
  const n = v => Math.round(parseRu(v) || 0);
  const T = TEXTS[key];
  if (!T) throw new Error('Неизвестный сегмент: ' + key);

  // Текст с бонусами: подставляем остаток; без бонусов — fallback (или общий шаблон)
  function smsWithBonus(b) {
    if (b > 0 && T.tpl && String(typeof T.tpl === 'function' ? T.tpl() : T.tpl).includes('{N}'))
      return renderText(T.tpl, { bonus: b });
    return renderText(T.fallback || T.tpl, { bonus: b });
  }

  if (key === 'dr30') {
    const drTo = shiftDays(now, 30);
    const q = last => `ВЫБРАТЬ ПЕРВЫЕ ${PAGE} ${CARD_FIELDS},`
      + ' ДЕНЬ(К.ДатаРождения) КАК ДеньДР, МЕСЯЦ(К.ДатаРождения) КАК МесяцДР, ЕСТЬNULL(О.СуммаОстаток, 0) КАК Бонусы'
      + ' ИЗ Справочник.ИнформационныеКарты КАК К'
      + ' ЛЕВОЕ СОЕДИНЕНИЕ РегистрНакопления.Бонусы.Остатки КАК О ПО О.БонуснаяКарта = К.Ссылка'
      + ` ГДЕ ${birthdayCond(now, drTo)} И ${CARD_OK} И К.Код > "${last}" УПОРЯДОЧИТЬ ПО Ключ`;
    const rows = await pageAll(q);
    const out = rows.map(r => {
      const day = n(r['ДеньДР']), mon = n(r['МесяцДР']);
      // дата отправки = ДР − 3 дня (ДР в этом или следующем году-месяце относительно окна)
      let bd = new Date(now.getFullYear(), mon - 1, day);
      if (bd < now) bd = new Date(now.getFullYear() + (mon === 1 && now.getMonth() === 11 ? 1 : 0), mon - 1, day);
      const send = shiftDays(bd, -3);
      const nm = cleanName(r['Имя']);
      let text = nm ? renderText(T.tpl, { name: nm }) : T.fallback;
      if (segs(text) > 1) text = T.fallback;
      return baseCols(r).concat([day ? `${pad(day)}.${pad(mon)}` : '', day ? ruDate(send < now ? now : send) : 'вручную (нет дня ДР)', Math.round(parseRu(r['Бонусы']) || 0), text, segs(text)]);
    }).sort((a, b) => String(a[6]).localeCompare(String(b[6])));
    return { filename: 'ДР-30-дней.csv', csv: toCsv(BASE_HEAD.concat(['ДР', 'ДатаОтправки', 'БонусовНаКарте', 'SMS', 'СегментовSMS']), out) };
  }

  const churnLike = {
    'ottok-vip': { having: 'СУММА(Ч.СуммаДокумента) >= 5000', file: 'Отток-VIP.csv', win: [d240, d120] },
    'ottok-bonus': { having: 'СУММА(Ч.СуммаДокумента) < 5000 И МАКСИМУМ(ЕСТЬNULL(О.СуммаОстаток, 0)) >= 100', file: 'Отток-с-бонусами.csv', win: [d240, d120] },
    'ottok-rest': { having: 'СУММА(Ч.СуммаДокумента) < 5000 И МАКСИМУМ(ЕСТЬNULL(О.СуммаОстаток, 0)) < 100', file: 'Отток-остальные.csv', win: [d240, d120] },
    sleep60: { having: null, file: 'Засыпающие-2-4-мес.csv', win: [d120, d60] },
  };
  if (churnLike[key]) {
    const { having, file, win } = churnLike[key];
    const rows = await pageAll(churnPageQuery(win[0], win[1], having));
    const out = rows.map(r => {
      const b = n(r['Бонусы']);
      const text = smsWithBonus(b);
      return baseCols(r).concat([n(r['Чеков']), n(r['Покупки']), String(r['ПоследняяПокупка'] || '').slice(0, 10), b, text, segs(text)]);
    }).sort((a, b) => b[6] - a[6]);
    return { filename: file, csv: toCsv(BASE_HEAD.concat(['Чеков', 'СуммаПокупок', 'ПоследняяПокупка', 'БонусовНаКарте', 'SMS', 'СегментовSMS']), out) };
  }

  if (key === 'bonus300') {
    const q = last => `ВЫБРАТЬ ПЕРВЫЕ ${PAGE} ${CHK_FIELDS}, МАКСИМУМ(ЕСТЬNULL(О.СуммаОстаток, 0)) КАК Бонусы`
      + ' ИЗ Документ.ЧекККМ КАК Ч'
      + ' ЛЕВОЕ СОЕДИНЕНИЕ РегистрНакопления.Бонусы.Остатки КАК О ПО О.БонуснаяКарта = Ч.ДисконтнаяКарта'
      + ` ГДЕ Ч.Проведен И Ч.Дата >= ${dLit(d60)} И ${CHK_CARD_OK} И Ч.ДисконтнаяКарта.Код > "${last}"`
      + ` СГРУППИРОВАТЬ ПО ${CHK_GROUP}`
      + ' ИМЕЮЩИЕ МАКСИМУМ(ЕСТЬNULL(О.СуммаОстаток, 0)) >= 300 УПОРЯДОЧИТЬ ПО Ключ';
    const rows = await pageAll(q);
    const out = rows.map(r => {
      const b = n(r['Бонусы']); const text = smsWithBonus(b);
      return baseCols(r).concat([b, text, segs(text)]);
    }).sort((a, b) => b[5] - a[5]);
    return { filename: 'Активные-бонусы-300.csv', csv: toCsv(BASE_HEAD.concat(['БонусовНаКарте', 'SMS', 'СегментовSMS']), out) };
  }

  if (key === 'newcomers') {
    const q = last => `ВЫБРАТЬ ПЕРВЫЕ ${PAGE} ${CARD_FIELDS}, К.ДатаКарты КАК ДатаКарты, КОЛИЧЕСТВО(Ч.Ссылка) КАК Чеков`
      + ' ИЗ Справочник.ИнформационныеКарты КАК К'
      + ' ЛЕВОЕ СОЕДИНЕНИЕ Документ.ЧекККМ КАК Ч ПО Ч.ДисконтнаяКарта = К.Ссылка И Ч.Проведен'
      + ` ГДЕ К.ДатаКарты >= ${dLit(d60)} И ${CARD_OK} И К.Код > "${last}"`
      + ' СГРУППИРОВАТЬ ПО К.Код, К.КодКарты, К.Фамилия, К.Имя, К.КонтактныйТелефон, К.КонтактныйТелефонПриведенный, К.ДатаКарты'
      + ' ИМЕЮЩИЕ КОЛИЧЕСТВО(Ч.Ссылка) <= 1 УПОРЯДОЧИТЬ ПО Ключ';
    const rows = await pageAll(q);
    const text = renderText(T.tpl);
    const out = rows.map(r => baseCols(r).concat([String(r['ДатаКарты'] || '').slice(0, 10), n(r['Чеков']), text, segs(text)]));
    return { filename: 'Новички-без-2-покупки.csv', csv: toCsv(BASE_HEAD.concat(['КартаВыдана', 'Чеков', 'SMS', 'СегментовSMS']), out) };
  }

  throw new Error('Сегмент без CSV-обработчика: ' + key);
}

module.exports = { getAudiences, getAudienceCsv };
