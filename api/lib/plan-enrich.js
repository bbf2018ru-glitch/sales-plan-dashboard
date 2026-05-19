// Обогащение плана из РегистрНакопления.ф_ПланФактПоПродавцам.
//
// Текущий BSL /pull берёт план ТОЛЬКО для ВидОперации=СТС (только розница).
// У Маши есть ещё планы по направлениям: Сайт, Сайт Ангарск, Заказная продукция,
// Опт, Агрегатор, Корпоративные клиенты. Каждое направление дублируется в
// 2-3 строки регистра (отгрузка/заказы/деньги), но это одно и то же значение
// плана — поэтому берём один из них (отгрузка).
//
// Запускается отдельно от основного pull (не блокирует) — добавляет недостающие
// планы в таблицу plans на уровне сети (storeId=__network__, productId=__total__).

const { fetchUppPackage } = require('./upp-pull');

const BASE_URL_ENV = 'UPP_PULL_URL';

// Из реальных данных Маши (probe 2026-05-19):
//   СТС (Мария)                    — основной розничный план (по магазинам)
//   Сайт (отгрузка|заказы|деньги)  — одинаковая сумма, берём отгрузку
//   Сайт Ангарск (...)             — то же
//   Заказная продукция (...)       — то же
//   Опт (...)                      — то же
//   Агрегатор (...)                — то же
//   Корпоративные клиенты (...)    — то же
//
// Берём ровно «отгрузка» для каждой → получаем сумму без дубликатов.
function pickPrimary(vid) {
  if (!vid) return null;
  const v = String(vid).trim();
  if (v === 'СТС (Мария)' || /^СТС\b/.test(v)) return 'СТС';
  if (/Сайт Ангарск \(отгрузка\)/.test(v)) return 'Сайт Ангарск';
  if (/^Сайт \(отгрузка\)/.test(v)) return 'Сайт';
  if (/Заказная продукция \(отгрузка\)/.test(v)) return 'Заказная продукция';
  if (/Опт \(отгрузка\)/.test(v)) return 'Опт';
  if (/Агрегатор \(отгрузка\)/.test(v)) return 'Агрегатор';
  if (/Корпоративные клиенты \(отгрузка\)/.test(v)) return 'Корпоративные клиенты';
  return null; // другие варианты (заказы/деньги) — дубликаты, не учитываем
}

function parseRu(num) {
  return parseFloat(String(num || '0').replace(/\s+/g, '').replace(',', '.')) || 0;
}

async function fetchPlanByVid(ym) {
  const base = (process.env[BASE_URL_ENV] || '').replace(/\/pull(\?.*)?$/, '');
  if (!base) throw new Error('UPP_PULL_URL не настроен');
  const url = `${base}/register?name=${encodeURIComponent('ф_ПланФактПоПродавцам')}&from=${ym}&to=${ym}&limit=999`;
  const data = await fetchUppPackage({
    url,
    username: process.env.UPP_PULL_USER,
    password: process.env.UPP_PULL_PASSWORD,
    period: ''
  });
  return data.rows || [];
}

// Возвращает дополнительный план «к СТС»: сколько добавить чтобы дашборд
// показывал полный план сети по всем направлениям.
async function computeExtraNetworkPlan(period) {
  const rows = await fetchPlanByVid(period);
  // Сгруппируем по primaryType, потом просуммируем
  const sums = new Map();
  for (const r of rows) {
    const primary = pickPrimary(r['ВидОперации']);
    if (!primary) continue;
    const plan = parseRu(r['План']);
    sums.set(primary, (sums.get(primary) || 0) + plan);
  }
  // Дополнительные направления (всё кроме СТС, который уже идёт через /pull)
  let extra = 0;
  const breakdown = [];
  for (const [name, sum] of sums) {
    if (name === 'СТС') continue;
    extra += sum;
    breakdown.push({ name, plan: Number(sum.toFixed(2)) });
  }
  return {
    period,
    extraPlan: Number(extra.toFixed(2)),
    stsPlan: Number((sums.get('СТС') || 0).toFixed(2)),
    breakdown: breakdown.sort((a, b) => b.plan - a.plan)
  };
}

module.exports = { computeExtraNetworkPlan };
