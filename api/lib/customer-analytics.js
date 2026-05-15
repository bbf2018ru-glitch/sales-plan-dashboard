// Клиентская аналитика — работает напрямую через HTTP-сервис 1С УПП.
// Тянет регистры Бонусы / ИнформационныеКарты / Продажи и строит отчёты:
//
//   - Топ клиентов по бонусам (по сумме движений за период)
//   - Активные карты (число)
//   - Дни рождения сегодня / на этой неделе
//   - Гео-распределение по микрорайонам
//
// Зависит от UPP_PULL_URL (HTTP-сервис 1С) — не от данных в нашей БД.

const { fetchUppPackage } = require('./upp-pull');

const BASE_URL = process.env.UPP_PULL_URL || '';
const BASE = BASE_URL.replace(/\/pull(\?.*)?$/, '');

async function callRegister(name, fromYM, toYM, limit = 10000) {
  if (!BASE) throw new Error('UPP_PULL_URL не настроен');
  const url = `${BASE}/register?name=${encodeURIComponent(name)}&from=${fromYM}&to=${toYM}&limit=${limit}`;
  return fetchUppPackage({
    url,
    username: process.env.UPP_PULL_USER,
    password: process.env.UPP_PULL_PASSWORD,
    period: ''
  });
}

// Бонусы — движения за период, агрегируем по карте
async function bonusMovements(fromYM, toYM) {
  // ВРЕМЕННО: текущий HTTP-сервис 1С имеет баг — Формат числа > 999 даёт
  // "10 000" с разделителем тысяч и запрос ломается. Используем 999.
  // Будет снят после обновления BSL (Формат(Лимит, "ЧГ=") уже в файле).
  const data = await callRegister('Бонусы', fromYM, toYM, 999);
  const byCard = new Map();
  for (const r of data.rows || []) {
    const card = r['БонуснаяКарта'] || '';
    const sum = parseFloat(String(r['Сумма'] || '0').replace(',', '.').replace(/\s+/g, ''));
    if (!byCard.has(card)) byCard.set(card, { card, sum: 0, movements: 0 });
    const item = byCard.get(card);
    item.sum += sum;
    item.movements += 1;
  }
  const arr = Array.from(byCard.values()).sort((a, b) => b.sum - a.sum);
  return {
    period: { from: fromYM, to: toYM },
    totalCards: arr.length,
    totalMovements: data.rowsCount,
    totalSum: arr.reduce((s, x) => s + x.sum, 0).toFixed(2),
    topCards: arr.slice(0, 100).map(c => ({ ...c, sum: Number(c.sum.toFixed(2)) }))
  };
}

// Получить все карты с активными движениями за период
async function activeCardsCount(fromYM, toYM) {
  try {
    const data = await callRegister('Бонусы', fromYM, toYM, 999);
    const cards = new Set();
    for (const r of data.rows || []) {
      if (r['БонуснаяКарта']) cards.add(r['БонуснаяКарта']);
    }
    return { activeCards: cards.size, totalMovements: data.rowsCount };
  } catch (e) {
    return { error: e.message };
  }
}

// Дни рождения на этой неделе — будет работать после обновления HTTP-сервиса
// (требует /products-detail или специальный endpoint для карт).
// Пока возвращаем заглушку.
async function birthdays() {
  return {
    available: false,
    note: 'Требует расширения HTTP-сервиса — endpoint для перечисления Справочник.ИнформационныеКарты с реквизитами ДатаРождения, ФИО, ВК-номер. Будет активирован после обновления BSL.'
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

async function buildCustomerAnalytics(opts = {}) {
  const now = new Date();
  const fromYM = opts.from || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const toYM = opts.to || fromYM;
  const cacheKey = `cust:${fromYM}:${toYM}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.data, fromCache: true };
  }
  const result = {
    period: { from: fromYM, to: toYM },
    available: !!BASE
  };
  if (!BASE) {
    result.note = 'UPP_PULL_URL не настроен — невозможно тянуть данные из 1С';
    return result;
  }
  try {
    // bonuses и cardCount тянут одни и те же данные — оптимизируем
    // одним запросом + переиспользуем для obeих метрик.
    result.bonuses = await bonusMovements(fromYM, toYM).catch(e => ({ error: e.message }));
    if (result.bonuses && !result.bonuses.error) {
      result.activeCardsThisPeriod = {
        activeCards: result.bonuses.totalCards,
        totalMovements: result.bonuses.totalMovements
      };
    }
    result.birthdays = await birthdays();
  } catch (e) {
    result.error = e.message;
  }
  if (!result.error && !result.bonuses?.error) {
    cache.set(cacheKey, { data: result, at: Date.now() });
  }
  return result;
}

module.exports = { buildCustomerAnalytics };
