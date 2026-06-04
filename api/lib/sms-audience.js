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
// Чтобы согласоваться с блоком «SMS-атрибуция» — дедупим повторные отправки той же
// рассылки тем же текстом ровно как там (normText + темы «Реклама/Акция»). Тогда
// `audience.total` совпадает с `recipients` из sms-attribution. Не импортируем
// функции напрямую, чтобы не цепляться к sms-attribution.js (его активно правит
// параллельная сессия).

const upp = require('./upp-client');
const cache = upp.makeCache(6 * 60 * 60 * 1000);

const VIP_REVENUE_THRESHOLD = 10000;
const MIN_RECIPIENTS = 100;
const MAX_CAMPAIGNS = 30;
const MARKETING_RE = /реклам|акци|подар|бонус|промо|рассылк/i;

function pad(n) { return String(n).padStart(2, '0'); }
function parseDt(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return { y: +m[3], m: +m[2], d: +m[1], hh: +(m[4] || 0), mm: +(m[5] || 0), ss: +(m[6] || 0) };
}
function dtLit(p) { return `ДАТАВРЕМЯ(${p.y},${p.m},${p.d},${p.hh || 0},${p.mm || 0},${p.ss || 0})`; }
function dayLit(p) { return `ДАТАВРЕМЯ(${p.y},${p.m},${p.d})`; }
function plusDays(p, days) {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function monthBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { y, m, ny: next[0], nm: next[1] };
}
function normText(t) { return String(t || '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim(); }

// Запрос списка отправок месяца. Кроме базовых полей вытаскиваем «критерий отбора»
// (Документ.SMSСообщение.СодержаниеТемыSMS — менеджер пишет туда вручную перед
// рассылкой, напр. «клиенты, кто покупал блюда вчера Ржанова/Ядринцева 01.06.-03.06.»)
// и ответственного (кто отправил).
function campaignListQuery(period) {
  const b = monthBounds(period);
  return 'ВЫБРАТЬ П.Ссылка.Дата КАК Дата, П.Ссылка.Тема КАК Тема,'
    + ' МАКСИМУМ(ВЫРАЗИТЬ(П.Ссылка.ТекстПисьма КАК СТРОКА(300))) КАК Текст,'
    + ' МАКСИМУМ(ВЫРАЗИТЬ(П.Ссылка.СодержаниеТемыSMS КАК СТРОКА(200))) КАК Критерий,'
    + ' МАКСИМУМ(ВЫРАЗИТЬ(П.Ссылка.Ответственный.Наименование КАК СТРОКА(50))) КАК Ответственный,'
    + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Получатель) КАК Получателей'
    + ' ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ` ГДЕ П.Ссылка.Дата >= ДАТАВРЕМЯ(${b.y},${b.m},1) И П.Ссылка.Дата < ДАТАВРЕМЯ(${b.ny},${b.nm},1)`
    + ' СГРУППИРОВАТЬ ПО П.Ссылка, П.Ссылка.Дата, П.Ссылка.Тема'
    + ` ИМЕЮЩИЕ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Получатель) >= ${MIN_RECIPIENTS}`
    + ' УПОРЯДОЧИТЬ ПО Получателей УБЫВ';
}

// Нормализуем «текст-разделитель» 1С: спецсимвол ¶ в реальных строках = перевод строки.
function cleanCriterion(s) {
  return String(s || '').replace(/¶+/g, ' · ').replace(/[\r\n]+/g, ' · ').replace(/\s+/g, ' ').trim();
}

// Запрос сегментов: получатели всех dts → группировка по карте → классификация
// по последней покупке (recency) и сумме за 365 дней (для VIP).
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

const SEGMENT_KEYS = { 'VIP': 'VIP', 'активный': 'active', 'спящий': 'sleeping', 'холодный': 'cold' };
function emptyDist() { return { VIP: 0, active: 0, sleeping: 0, cold: 0, total: 0 }; }

// Ограниченная параллель — чтобы 1С не перегружать (на одну кампанию ~3-5с).
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
  const list = await upp.callQuery(campaignListQuery(period));
  if (!list || !list.rows) return { period, campaigns: [], error: 'нет ответа 1С', refreshedAt: new Date().toISOString() };

  // Дедуп ровно как в sms-attribution: только маркетинговые темы + normText.
  // Критерий/ответственный схлопываем по первой непустой отправке группы.
  const byText = new Map();
  for (const r of list.rows) {
    if (!MARKETING_RE.test(r.Тема || '')) continue;
    const dt = parseDt(r.Дата); if (!dt) continue;
    const key = normText(r.Текст) || ('doc-' + r.Дата);
    if (!byText.has(key)) byText.set(key, { text: (r.Текст || '').trim(), theme: r.Тема, dts: [], criterion: '', responsible: '' });
    const g = byText.get(key);
    g.dts.push(dt);
    if (!g.criterion && r.Критерий) g.criterion = cleanCriterion(r.Критерий);
    if (!g.responsible && r.Ответственный) g.responsible = String(r.Ответственный).trim();
  }
  const groups = Array.from(byText.values()).slice(0, MAX_CAMPAIGNS);

  const out = await pMapLimit(groups, 3, async (g) => {
    g.dts.sort((a, b) => Date.UTC(a.y, a.m - 1, a.d, a.hh, a.mm, a.ss) - Date.UTC(b.y, b.m - 1, b.d, b.hh, b.mm, b.ss));
    const first = g.dts[0];
    const firstDate = `${pad(first.d)}.${pad(first.m)}.${first.y}`;
    const dtLitNow = dayLit(first); // отсечка — начало дня первой отправки
    const d90 = dayLit(plusDays(first, -90));
    const d365 = dayLit(plusDays(first, -365));
    try {
      const res = await upp.callQuery(audienceQuery({
        dtsLits: g.dts.map(dtLit), dtLitNow, d90, d365
      }), { timeoutMs: 60000 });
      const dist = emptyDist();
      for (const row of (res?.rows || [])) {
        const k = SEGMENT_KEYS[row.Сегмент] || 'cold';
        const n = upp.parseRu(row.Карт) || 0;
        dist[k] += n; dist.total += n;
      }
      return { firstDate, text: g.text, sendsCount: g.dts.length, criterion: g.criterion || null, responsible: g.responsible || null, audience: dist, audienceError: null };
    } catch (e) {
      return { firstDate, text: g.text, sendsCount: g.dts.length, criterion: g.criterion || null, responsible: g.responsible || null, audience: null, audienceError: e.message };
    }
  });

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
