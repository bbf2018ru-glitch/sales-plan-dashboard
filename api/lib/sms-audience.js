// SMS-аудитория: для каждой рассылки месяца считаем распределение получателей
// по сегментам ПО RECENCY на момент даты рассылки.
//
// Сегменты:
//   VIP        — была покупка ≤90 дней до рассылки И сумма покупок за 365 дней ≥10 000 ₽
//   активный   — была покупка ≤90 дней до рассылки (без VIP)
//   спящий     — последняя покупка от 90 до 365 дней до рассылки
//   холодный   — последняя покупка >365 дней назад или не было вообще
//
// Считаем на момент ДАТЫ РАССЫЛКИ (не «сейчас») — иначе VIP в мае мог стать
// спящим в июне и теряем картину «кому слали».
//
// Источник данных: тот же что и sms-attribution (берём набор кампаний из её
// результата). Запрос на каждую кампанию тяжёлый (~3-5 сек), кэшируем 6 ч.

const upp = require('./upp-client');
const smsAttribution = require('./sms-attribution');
const cache = upp.makeCache(6 * 60 * 60 * 1000);

const VIP_REVENUE_THRESHOLD = 10000; // ₽ за 365 дней — порог для VIP

function pad(n) { return String(n).padStart(2, '0'); }
function parseDateRu(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(String(s || ''));
  return m ? { y: +m[3], m: +m[2], d: +m[1] } : null;
}
function dtLit(p) { return `ДАТАВРЕМЯ(${p.y},${p.m},${p.d},${p.hh || 0},${p.mm || 0},${p.ss || 0})`; }
function dayLit(p) { return `ДАТАВРЕМЯ(${p.y},${p.m},${p.d})`; }
function plusDays(p, days) {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function parseDts(s) {
  // sms-attribution возвращает firstDate как "DD.MM.YYYY", а ВСЕ dts нам тут не доступны —
  // используем только первую дату (для сегментации это нормально: первая отправка задаёт
  // момент анализа recency, дублирующие отправки в том же дне/неделе не меняют сегмент).
  return parseDateRu(s);
}

// Запрос распределения по сегментам. dtsLit — литералы 1С для дат рассылки (минимум 1),
// dtLit_now — дата отсечения (= dts[0]), d90/d365 — границы окон.
function audienceQuery({ dtsLits, dtLitNow, d90, d365 }) {
  return 'ВЫБРАТЬ Сегмент, КОЛИЧЕСТВО(*) КАК Карт ИЗ ('
    + ' ВЫБРАТЬ'
    + ' П.Получатель КАК К,'
    + ' ВЫБОР'
    + ` КОГДА МАКСИМУМ(Чек.Дата) ЕСТЬ NULL ТОГДА "холодный"`
    + ` КОГДА МАКСИМУМ(Чек.Дата) >= ${d90} И СУММА(ЕСТЬNULL(Чек.СуммаДокумента,0)) >= ${VIP_REVENUE_THRESHOLD} ТОГДА "VIP"`
    + ` КОГДА МАКСИМУМ(Чек.Дата) >= ${d90} ТОГДА "активный"`
    + ` КОГДА МАКСИМУМ(Чек.Дата) >= ${d365} ТОГДА "спящий"`
    + ` ИНАЧЕ "холодный"`
    + ' КОНЕЦ КАК Сегмент'
    + ' ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ Документ.ЧекККМ КАК Чек'
    + ' ПО Чек.ДисконтнаяКарта = П.Получатель'
    + ` И Чек.Дата >= ${d365} И Чек.Дата < ${dtLitNow} И Чек.Проведен`
    + ` ГДЕ П.Ссылка.Дата В (${dtsLits.join(', ')})`
    + ' СГРУППИРОВАТЬ ПО П.Получатель'
    + ') КАК Т'
    + ' СГРУППИРОВАТЬ ПО Сегмент';
}

function emptyDist() { return { VIP: 0, active: 0, sleeping: 0, cold: 0, total: 0 }; }

function dtsLitsForFirstDate(firstDate) {
  // sms-attribution схлопывает повторные отправки в одну кампанию, но в нашем
  // API мы не получаем оригинальный массив дат. Используем приближение: запрос
  // покрывает ВСЕ отправки этого дня (хх:мм заменяем на 00:00..23:59) — для
  // сегментации хватает по дню.
  const p = parseDateRu(firstDate);
  if (!p) return null;
  // одна дата на весь день: SMSСообщение.Дата хранится с временем, поэтому фильтр
  // нужен по диапазону. Меняем подход — в запросе используем ДАТЫ ОТПРАВКИ ИЗ КАМПАНИИ.
  // Но у нас их нет. Делаем фильтр иначе.
  return p;
}

// Альтернативный запрос — по диапазону дат (если у нас только день первой отправки).
function audienceQueryByDayRange({ dayStart, dayEnd, dtLitNow, d90, d365, textNorm }) {
  return 'ВЫБРАТЬ Сегмент, КОЛИЧЕСТВО(*) КАК Карт ИЗ ('
    + ' ВЫБРАТЬ'
    + ' П.Получатель КАК К,'
    + ' ВЫБОР'
    + ` КОГДА МАКСИМУМ(Чек.Дата) ЕСТЬ NULL ТОГДА "холодный"`
    + ` КОГДА МАКСИМУМ(Чек.Дата) >= ${d90} И СУММА(ЕСТЬNULL(Чек.СуммаДокумента,0)) >= ${VIP_REVENUE_THRESHOLD} ТОГДА "VIP"`
    + ` КОГДА МАКСИМУМ(Чек.Дата) >= ${d90} ТОГДА "активный"`
    + ` КОГДА МАКСИМУМ(Чек.Дата) >= ${d365} ТОГДА "спящий"`
    + ` ИНАЧЕ "холодный"`
    + ' КОНЕЦ КАК Сегмент'
    + ' ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ Документ.ЧекККМ КАК Чек'
    + ' ПО Чек.ДисконтнаяКарта = П.Получатель'
    + ` И Чек.Дата >= ${d365} И Чек.Дата < ${dtLitNow} И Чек.Проведен`
    + ` ГДЕ П.Ссылка.Дата >= ${dayStart} И П.Ссылка.Дата <= ${dayEnd}`
    + (textNorm ? ` И ВЫРАЗИТЬ(П.Ссылка.ТекстПисьма КАК СТРОКА(300)) = "${textNorm.replace(/"/g, '""').slice(0, 300)}"` : '')
    + ' СГРУППИРОВАТЬ ПО П.Получатель'
    + ') КАК Т'
    + ' СГРУППИРОВАТЬ ПО Сегмент';
}

const SEGMENT_KEYS = { 'VIP': 'VIP', 'активный': 'active', 'спящий': 'sleeping', 'холодный': 'cold' };

async function audienceForCampaign(c) {
  const first = parseDateRu(c.firstDate);
  if (!first) return emptyDist();
  const dtNow = dtLit({ ...first, hh: 0, mm: 0, ss: 0 });
  const d90 = dayLit(plusDays(first, -90));
  const d365 = dayLit(plusDays(first, -365));
  const dayStart = dayLit(first);
  const dayEnd = dtLit({ ...first, hh: 23, mm: 59, ss: 59 });
  const q = audienceQueryByDayRange({ dayStart, dayEnd, dtLitNow: dtNow, d90, d365, textNorm: c.text });
  const res = await upp.callQuery(q, { timeoutMs: 60000 });
  const dist = emptyDist();
  for (const row of (res?.rows || [])) {
    const k = SEGMENT_KEYS[row.Сегмент] || 'cold';
    const n = upp.parseRu(row.Карт) || 0;
    dist[k] += n;
    dist.total += n;
  }
  return dist;
}

// Ограниченная параллель: чтобы 1С не перегружать.
async function pMapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { ret[idx] = await fn(items[idx], idx); } catch (e) { ret[idx] = { error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return ret;
}

async function compute(period) {
  const sa = await smsAttribution.getSmsAttribution(period);
  const camps = (sa && sa.campaigns) || [];
  if (!camps.length) return { period, campaigns: [], refreshedAt: new Date().toISOString() };
  const dists = await pMapLimit(camps, 3, async (c) => audienceForCampaign(c));
  const out = camps.map((c, i) => ({
    firstDate: c.firstDate,
    text: c.text,
    type: c.type,
    recipients: c.recipients,
    audience: dists[i] && !dists[i].error ? dists[i] : null,
    audienceError: dists[i]?.error || null
  }));
  return {
    period,
    campaigns: out,
    methodNote: 'Сегменты по recency на момент даты рассылки: VIP — покупка ≤90 дн. + сумма за 365 дн. ≥ ' + VIP_REVENUE_THRESHOLD + ' ₽; активный — покупка ≤90 дн.; спящий — 90–365 дн.; холодный — >365 дн. или не было покупок (включает новых).',
    refreshedAt: new Date().toISOString()
  };
}

function getSmsAudience(period) {
  const p = period || upp.nowYM();
  return cache.wrap('smsaud:' + p, () => compute(p));
}

module.exports = { getSmsAudience };
