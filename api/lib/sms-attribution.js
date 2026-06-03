// SMS-атрибуция: связывает рассылки (Документ.SMSСообщение) с покупками (ЧекККМ)
// по карте лояльности через /query 1С. ПО КАЖДОЙ КАМПАНИИ (документу рассылки),
// только маркетинговые («Реклама»).
//
// Механика: карта на чеке и у получателя — одна ссылка → JOIN
// `Чек.ДисконтнаяКарта = Получатели.Получатель`. Тема — ПЕРЕЧИСЛЕНИЕ (по тексту не
// фильтруется): берём список кампаний группировкой ПО документу и фильтруем «Реклама»
// в Node по представлению.
//
// ⚠️ Перформанс: per-row окно (ДОБАВИТЬКДАТЕ от даты SMS) в JOIN ON → таймаут (>115с).
// Поэтому на каждую кампанию — отдельный запрос с КОНСТАНТНЫМ окном [дата рассылки … +14д]
// (короткое окно → 1С сканирует мало чеков → ~0.2с). Это и корректно (покупки только
// ПОСЛЕ конкретной рассылки), и быстро. Итог по всем — отдельный запрос с дедупом карт
// (карта в нескольких рассылках считается один раз).

const upp = require('./upp-client');

const cache = upp.makeCache(6 * 60 * 60 * 1000);
const WINDOW_DAYS = 14;
const MIN_RECIPIENTS = 50;   // мелкие рассылки (<50 карт) пропускаем как шум
const MAX_CAMPAIGNS = 40;    // потолок числа кампаний в ответе (по убыванию охвата)

const MARKETING_RE = /реклам|акци|подар|бонус|промо|рассылк/i;

function pad(n) { return String(n).padStart(2, '0'); }

// "29.05.2026 12:25:27" → {y,m,d,hh,mm,ss}
function parseDt(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return { y: +m[3], m: +m[2], d: +m[1], hh: +(m[4] || 0), mm: +(m[5] || 0), ss: +(m[6] || 0) };
}
function dtLit(p) { return `ДАТАВРЕМЯ(${p.y},${p.m},${p.d},${p.hh},${p.mm},${p.ss})`; }
function plusDays(p, days) {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) + days * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), hh: dt.getUTCHours(), mm: dt.getUTCMinutes(), ss: dt.getUTCSeconds() };
}
function monthBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { y, m, ny: next[0], nm: next[1] };
}

// Список кампаний-рассылок за месяц (по документам), с темой и охватом.
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

// Атрибуция одной кампании: окно [дата рассылки … +WINDOW_DAYS дней].
function campaignQuery(dt) {
  const from = dtLit(dt), to = dtLit(plusDays(dt, WINDOW_DAYS));
  return 'ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Получатель) КАК Получателей,'
    + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ ВЫБОР КОГДА Чек.Ссылка ЕСТЬ НЕ NULL ТОГДА П.Получатель КОНЕЦ) КАК Купили,'
    + ' СУММА(ЕСТЬNULL(Чек.СуммаДокумента,0)) КАК Выручка'
    + ' ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ Документ.ЧекККМ КАК Чек ПО Чек.ДисконтнаяКарта = П.Получатель'
    + ` И Чек.Дата >= ${from} И Чек.Дата <= ${to}`
    + ` ГДЕ П.Ссылка.Дата = ${dtLit(dt)}`;
}

// Дедуплицированный итог по нескольким кампаниям: уникальные карты охвата +
// их покупки в общем окне [мин.дата … макс.дата+WINDOW_DAYS], каждый чек один раз.
function totalQuery(dts) {
  const inList = dts.map(dtLit).join(', ');
  // Окно — от самой ранней рассылки до самой поздней + WINDOW_DAYS.
  const sorted = dts.slice().sort((a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d));
  const wFrom = dtLit(sorted[0]);
  const wTo = dtLit(plusDays(sorted[sorted.length - 1], WINDOW_DAYS));
  return 'ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ У.Карта) КАК Получателей,'
    + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ ВЫБОР КОГДА Чек.Ссылка ЕСТЬ НЕ NULL ТОГДА У.Карта КОНЕЦ) КАК Купили,'
    + ' СУММА(ЕСТЬNULL(Чек.СуммаДокумента,0)) КАК Выручка'
    + ` ИЗ (ВЫБРАТЬ РАЗЛИЧНЫЕ П.Получатель КАК Карта ИЗ Документ.SMSСообщение.Получатели КАК П ГДЕ П.Ссылка.Дата В (${inList})) КАК У`
    + ' ЛЕВОЕ СОЕДИНЕНИЕ Документ.ЧекККМ КАК Чек ПО Чек.ДисконтнаяКарта = У.Карта'
    + ` И Чек.Дата >= ${wFrom} И Чек.Дата <= ${wTo}`;
}

function row1(res) {
  const r = (res && res.rows && res.rows[0]) || {};
  const recipients = upp.parseRu(r.Получателей), buyers = upp.parseRu(r.Купили), revenue = upp.parseRu(r.Выручка);
  return {
    recipients, buyers, revenue,
    conversionPct: recipients ? Math.round(buyers / recipients * 1000) / 10 : 0,
    avgCheck: buyers ? Math.round(revenue / buyers) : 0
  };
}

async function compute(period) {
  // 1) Список кампаний → только маркетинговые («Реклама» и т.п.).
  const list = await upp.callQuery(campaignListQuery(period));
  if (!list || !list.rows) return { period, error: 'нет ответа 1С', campaigns: [] };
  let camps = list.rows
    .filter((r) => MARKETING_RE.test(r.Тема || ''))
    .map((r) => ({ dt: parseDt(r.Дата), dateStr: r.Дата, theme: r.Тема, text: (r.Текст || '').trim(), listRecipients: upp.parseRu(r.Получателей) }))
    .filter((c) => c.dt)
    .slice(0, MAX_CAMPAIGNS);

  if (!camps.length) {
    return { period, campaigns: [], total: row1(null), windowDays: WINDOW_DAYS,
      note: 'За период нет маркетинговых рассылок («Реклама») от ' + MIN_RECIPIENTS + ' получателей.', refreshedAt: new Date().toISOString() };
  }

  // 2) По каждой кампании — атрибуция со своим окном (последовательно, ~0.2с каждая).
  const campaigns = [];
  for (const c of camps) {
    try {
      const a = row1(await upp.callQuery(campaignQuery(c.dt), { timeoutMs: 40000 }));
      campaigns.push({ date: c.dateStr, theme: c.theme, text: c.text, ...a });
    } catch (e) {
      campaigns.push({ date: c.dateStr, theme: c.theme, text: c.text, recipients: c.listRecipients, buyers: null, revenue: null, conversionPct: null, avgCheck: null, error: e.message });
    }
  }

  // 3) Дедуплицированный итог (уникальные карты по всем кампаниям).
  let total;
  try { total = row1(await upp.callQuery(totalQuery(camps.map((c) => c.dt)))); }
  catch (_) { total = null; }

  return {
    period, windowDays: WINDOW_DAYS, campaignsCount: campaigns.length,
    campaigns, total,
    note: 'По каждой рассылке «Реклама»: получатель купил по той же карте в окне [дата рассылки … +' + WINDOW_DAYS + ' дней]. Только получатели с картой лояльности. Итог дедуплицирован (карта в нескольких рассылках — один раз); сумма по строкам может быть выше итога из-за пересечения аудиторий.',
    refreshedAt: new Date().toISOString()
  };
}

function getSmsAttribution(period) {
  const p = period || upp.nowYM();
  return cache.wrap('sms:' + p, () => compute(p));
}

module.exports = { getSmsAttribution };
