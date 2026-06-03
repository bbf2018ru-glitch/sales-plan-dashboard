// SMS-атрибуция: связывает рассылки (Документ.SMSСообщение) с покупками (ЧекККМ)
// по карте лояльности — через универсальный /query эндпоинт 1С (ВыполнитьQuery).
//
// Механика (доказана 2026-06-03): карта на чеке и у получателя SMS — ОДНА ссылка,
// матчатся JOIN'ом `Чек.ДисконтнаяКарта = Получатели.Получатель`. Тема SMS — это
// ПЕРЕЧИСЛЕНИЕ (фильтровать по тексту нельзя), поэтому группируем ПО Тема и разливаем
// маркетинг/транзакционные в Node по представлению.
//
// ⚠️ Перформанс: per-row окно (ДОБАВИТЬКДАТЕ от даты каждой SMS) в JOIN ON → таймаут.
// Поэтому окно фиксированное: чеки за [начало месяца … конец месяца + windowDays].
// Это аппроксимация месячной кампании (покупка в окне месяца, не строго +N дней от своей
// SMS), но для агрегата по месяцу корректна и быстра (~9с вместо >115с).

const upp = require('./upp-client');

const cache = upp.makeCache(6 * 60 * 60 * 1000); // 6ч — как у marketing-channels
const WINDOW_DAYS = 14;

// Классификация тем по представлению (enum-синоним). Маркетинг = активные рассылки,
// которые мы инициируем ради продаж; остальное — триггерное/транзакционное.
const MARKETING_RE = /реклам|акци|подар|бонус|промо|рассылк/i;
// Аномалии-исключения: «Код выдачи …» — оптовая выдача заказов (чеки до 1 млрд ₽,
// не розничная атрибуция).
const ANOMALY_RE = /код выдачи|выдача заказ/i;

function classify(theme) {
  if (ANOMALY_RE.test(theme)) return 'anomaly';
  if (MARKETING_RE.test(theme)) return 'marketing';
  return 'transactional';
}

function pad(n) { return String(n).padStart(2, '0'); }

// Границы окна для периода YYYY-MM.
function windowFor(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  const monthEnd = new Date(Date.UTC(y, m, 0));            // последний день месяца
  const chqEnd = new Date(monthEnd.getTime() + WINDOW_DAYS * 86400000);
  return {
    y, m, ny: next[0], nm: next[1],
    chqEndY: chqEnd.getUTCFullYear(), chqEndM: chqEnd.getUTCMonth() + 1, chqEndD: chqEnd.getUTCDate(),
    label: `${pad(m)}.${y} (покупки до +${WINDOW_DAYS}д)`
  };
}

function buildQuery(period) {
  const w = windowFor(period);
  return 'ВЫБРАТЬ П.Ссылка.Тема КАК Тема,'
    + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ П.Получатель) КАК Получателей,'
    + ' КОЛИЧЕСТВО(РАЗЛИЧНЫЕ ВЫБОР КОГДА Чек.Ссылка ЕСТЬ НЕ NULL ТОГДА П.Получатель КОНЕЦ) КАК Купили,'
    + ' СУММА(ЕСТЬNULL(Чек.СуммаДокумента, 0)) КАК Выручка'
    + ' ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ Документ.ЧекККМ КАК Чек'
    + ' ПО Чек.ДисконтнаяКарта = П.Получатель'
    + ` И Чек.Дата >= ДАТАВРЕМЯ(${w.y},${w.m},1) И Чек.Дата <= ДАТАВРЕМЯ(${w.chqEndY},${w.chqEndM},${w.chqEndD},23,59,59)`
    + ` ГДЕ П.Ссылка.Дата >= ДАТАВРЕМЯ(${w.y},${w.m},1) И П.Ссылка.Дата < ДАТАВРЕМЯ(${w.ny},${w.nm},1)`
    + ' СГРУППИРОВАТЬ ПО П.Ссылка.Тема'
    + ' УПОРЯДОЧИТЬ ПО Получателей УБЫВ';
}

async function compute(period) {
  const res = await upp.callQuery(buildQuery(period));
  if (!res || !res.rows) return { period, error: 'нет ответа 1С', themes: [] };
  const themes = res.rows.map((r) => {
    const recipients = upp.parseRu(r.Получателей);
    const buyers = upp.parseRu(r.Купили);
    const revenue = upp.parseRu(r.Выручка);
    return {
      theme: r.Тема || '—',
      kind: classify(r.Тема || ''),
      recipients, buyers, revenue,
      conversionPct: recipients ? Math.round(buyers / recipients * 1000) / 10 : 0,
      avgCheck: buyers ? Math.round(revenue / buyers) : 0
    };
  });
  // Итоги по маркетинговым темам (без триггерных и аномалий).
  const mkt = themes.filter((t) => t.kind === 'marketing');
  const sum = (k) => mkt.reduce((s, t) => s + t[k], 0);
  const recT = sum('recipients'), buyT = sum('buyers'), revT = sum('revenue');
  return {
    period,
    window: windowFor(period).label,
    windowDays: WINDOW_DAYS,
    themes,
    marketingTotals: {
      recipients: recT, buyers: buyT, revenue: revT,
      conversionPct: recT ? Math.round(buyT / recT * 1000) / 10 : 0,
      avgCheck: buyT ? Math.round(revT / buyT) : 0
    },
    note: 'Карточная атрибуция: получатель SMS купил по той же карте в окне месяца + ' + WINDOW_DAYS + 'д. Только получатели с картой лояльности (рассылки по телефону без карты не атрибутируются). «Код выдачи» — оптовая выдача, помечена как аномалия.',
    refreshedAt: new Date().toISOString()
  };
}

function getSmsAttribution(period) {
  const p = period || upp.nowYM();
  return cache.wrap('sms:' + p, () => compute(p));
}

module.exports = { getSmsAttribution, _buildQuery: buildQuery };
