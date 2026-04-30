// Календарь значимых дат для кондитерской «Мария» в Иркутске.
// Используется AI-блоком рекомендаций и в прогнозе спроса как признак.

const TIMEZONE = 'Asia/Irkutsk';
const TZ_OFFSET_MS = 8 * 3600 * 1000;

// Праздник = окно с пиковым спросом, не одна дата.
// `windowDaysBefore` — за сколько дней до даты начинается влияние на продажи
// (заказ тортов идёт заранее).
const FIXED_HOLIDAYS = [
  { name: 'Новый год',                month: 1, day: 1,  windowDaysBefore: 5, tag: 'newyear', impact: 'major' },
  { name: 'Православное Рождество',   month: 1, day: 7,  windowDaysBefore: 2, tag: 'christmas', impact: 'medium' },
  { name: 'День защитника Отечества', month: 2, day: 23, windowDaysBefore: 3, tag: 'feb23', impact: 'medium' },
  { name: 'Международный женский день', month: 3, day: 8, windowDaysBefore: 4, tag: 'mar8', impact: 'major' },
  { name: 'Праздник весны и труда',   month: 5, day: 1,  windowDaysBefore: 2, tag: 'may1', impact: 'low' },
  { name: 'День Победы',              month: 5, day: 9,  windowDaysBefore: 2, tag: 'may9',
    note: 'В местах празднования ограничена продажа алкоголя — рост спроса на десерты к чаю.', impact: 'medium' },
  { name: 'День защиты детей',        month: 6, day: 1,  windowDaysBefore: 2, tag: 'kidsday', impact: 'medium' },
  { name: 'День России',              month: 6, day: 12, windowDaysBefore: 2, tag: 'jun12', impact: 'low' },
  { name: '1 сентября — День знаний', month: 9, day: 1,  windowDaysBefore: 3, tag: 'sept1',
    note: 'Корпоративные заказы тортов в школах.', impact: 'medium' },
  { name: 'День народного единства',  month: 11, day: 4, windowDaysBefore: 1, tag: 'nov4', impact: 'low' },
];

// Сагаалган (буддийский Новый год) — лунный, разные даты каждый год.
// Источник дат: Иркутская областная пресс-служба, Лента.ру.
const SAGAALGAN = {
  2025: '2025-03-01',
  2026: '2026-02-17',
  2027: '2027-02-07',
};

// День города Иркутска — первая суббота июня.
function dayOfCity(year) {
  const firstJune = new Date(Date.UTC(year, 5, 1));
  const dow = firstJune.getUTCDay();
  const offset = dow === 6 ? 0 : (6 - dow + 7) % 7;
  const date = new Date(Date.UTC(year, 5, 1 + offset));
  return formatYmd(date);
}

// День Байкала — первое воскресенье сентября.
function dayOfBaikal(year) {
  const firstSept = new Date(Date.UTC(year, 8, 1));
  const dow = firstSept.getUTCDay();
  const offset = dow === 0 ? 0 : 7 - dow;
  const date = new Date(Date.UTC(year, 8, 1 + offset));
  return formatYmd(date);
}

function formatYmd(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function ymdToDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function nowInIrk() {
  return new Date(Date.now() + TZ_OFFSET_MS);
}

// Все события для года в формате [{date: 'YYYY-MM-DD', name, ...}]
function eventsForYear(year) {
  const list = FIXED_HOLIDAYS.map((h) => ({
    date: `${year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`,
    name: h.name,
    tag: h.tag,
    windowDaysBefore: h.windowDaysBefore,
    impact: h.impact,
    note: h.note || null,
  }));

  if (SAGAALGAN[year]) {
    list.push({
      date: SAGAALGAN[year],
      name: 'Сагаалган (буддийский Новый год)',
      tag: 'sagaalgan',
      windowDaysBefore: 4,
      impact: 'major',
      note: 'Локальный сибирский праздник. Пик спроса на «белую» выпечку (молоко, сметана, творог), семейные торты.',
    });
  }

  list.push({
    date: dayOfCity(year),
    name: 'День города Иркутска',
    tag: 'irkday',
    windowDaysBefore: 2,
    impact: 'medium',
    note: 'Совпадает по неделе с Днём защиты детей — детские торты, бенто.',
  });

  list.push({
    date: dayOfBaikal(year),
    name: 'День Байкала',
    tag: 'baikalday',
    windowDaysBefore: 1,
    impact: 'low',
    note: 'Локальный праздник, пик байкальского туризма.',
  });

  return list.sort((a, b) => a.date.localeCompare(b.date));
}

// Возвращает события в окне [сегодня, сегодня+daysAhead] по Иркутску.
function getUpcomingEvents(daysAhead = 60) {
  const now = nowInIrk();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const limit = new Date(today.getTime() + daysAhead * 24 * 3600 * 1000);

  const years = new Set([today.getUTCFullYear(), limit.getUTCFullYear()]);
  const all = [];
  for (const y of years) all.push(...eventsForYear(y));

  return all
    .filter((e) => {
      const d = ymdToDate(e.date);
      return d >= today && d <= limit;
    })
    .map((e) => {
      const d = ymdToDate(e.date);
      const days = Math.round((d - today) / (24 * 3600 * 1000));
      return { ...e, daysFromNow: days };
    });
}

// Сезонные индикаторы для текущей даты.
function seasonalContext(date = nowInIrk()) {
  const month = date.getUTCMonth() + 1;
  const tags = [];

  if (month === 12 || month <= 2) tags.push({ tag: 'winter-cold', note: 'Сибирская зима −20…−30°C — поток в стрит-точках падает, в ТЦ растёт.' });
  if (month >= 6 && month <= 9) tags.push({ tag: 'baikal-tourism', note: 'Туристический сезон Байкала — рост в центральных и туристических точках.' });
  if (month === 9) tags.push({ tag: 'school-start', note: 'Старт учебного года — корпоративные заказы школ, рост детских тортов.' });
  if (month >= 12 || month <= 3) tags.push({ tag: 'hot-drinks-peak', note: 'Пик спроса на горячие напитки и «зимнюю» выпечку.' });

  return tags;
}

// Дни в текущем периоде, на которые приходятся праздники с windowDaysBefore.
// Возвращает массив [{day, event}] — какие дни месяца под влиянием праздника.
function holidayDaysInPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return [];
  const events = eventsForYear(y).concat(eventsForYear(y + 1));
  const result = [];
  for (const e of events) {
    const eDate = ymdToDate(e.date);
    const start = new Date(eDate.getTime() - e.windowDaysBefore * 24 * 3600 * 1000);
    const periodStart = new Date(Date.UTC(y, m - 1, 1));
    const periodEnd = new Date(Date.UTC(y, m, 0));
    const winStart = start > periodStart ? start : periodStart;
    const winEnd = eDate < periodEnd ? eDate : periodEnd;
    if (winStart <= winEnd && winStart <= periodEnd && winEnd >= periodStart) {
      for (let d = new Date(winStart); d <= winEnd; d.setUTCDate(d.getUTCDate() + 1)) {
        if (d >= periodStart && d <= periodEnd) {
          result.push({ day: d.getUTCDate(), event: e.name, tag: e.tag });
        }
      }
    }
  }
  return result;
}

module.exports = {
  TIMEZONE,
  eventsForYear,
  getUpcomingEvents,
  seasonalContext,
  holidayDaysInPeriod,
  nowInIrk,
};
