function monthKey(input) {
  if (typeof input === 'string' && /^\d{4}-\d{2}$/.test(input)) {
    return input;
  }
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${now.getFullYear()}-${month}`;
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

// Корректировка себестоимости. Проблема: 1С присылает СтоимостьРасход из
// ПартииТоваровНаСкладах — это себестоимость СПИСАННОГО товара (включая
// списания брака, дегустации, перемещения). Отчёт «Валовая прибыль» в 1С
// считает себестоимость ПРОДАННОГО. Без коррекции маржа на дашборде
// занижена на ~1 млн ₽/мес.
//
// Логика приоритета:
//   1) Per-store markup из STORE_MARKUPS_JSON (или storeMarkups в opts)
//      Применяется как: cost_max = fact / (1 + markup/100)
//      Markup % берётся из колонки "Процент наценки" отчёта «Валовая прибыль».
//   2) Глобальный cap COST_CAP_RATIO (fallback): cost ≤ fact × ratio
//   3) Без капа: cost как пришёл от 1С
//
// Cap всегда применяется как ВЕРХНЯЯ граница — если фактический cost меньше
// расчётного maxCost (что нормально), оставляем как есть. Это не маскировка,
// а защита от лишних списаний в БД, которые не относятся к продажам периода.

function parseStoreMarkups(json) {
  if (!json) return {};
  try {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    const out = {};
    for (const [id, pct] of Object.entries(obj)) {
      const n = Number(pct);
      if (Number.isFinite(n) && n > 0) out[String(id)] = n;
    }
    return out;
  } catch (_) { return {}; }
}

function getStoreMarkups(override) {
  if (override && typeof override === 'object') return parseStoreMarkups(override);
  return parseStoreMarkups(process.env.STORE_MARKUPS_JSON);
}

function getCostCapRatio(override) {
  if (override !== undefined && override !== null && override !== '') {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromEnv = Number(process.env.COST_CAP_RATIO);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 1.0;
}

function capCost(amount, cost, ratio, storeId, storeMarkups) {
  const f = toNumber(amount);
  const c = toNumber(cost);
  if (c <= 0) return 0;
  // Приоритет: per-store markup из 1С (точная цель — отчёт «Валовая прибыль»)
  if (storeId && storeMarkups && storeMarkups[storeId]) {
    const markup = storeMarkups[storeId];
    const maxCost = f / (1 + markup / 100);
    return c > maxCost ? maxCost : c;
  }
  // Fallback: глобальный ratio
  const r = ratio === undefined ? 1.0 : Number(ratio);
  const maxCost = f * (Number.isFinite(r) && r > 0 ? r : 1.0);
  return c > maxCost ? maxCost : c;
}

function percent(value) {
  return Number((value * 100).toFixed(1));
}

function roundMetric(value) {
  return Number(value.toFixed(2));
}

// Маржа корректна только если 1С прислала валовую прибыль ИЛИ ненулевую
// себестоимость. Иначе возвращаем null — на UI это превращается в «—».
// Если просто посчитать (fact - cost) при cost=0, маржа окажется = факту,
// что вводит в заблуждение.
function computeMargin({ fact, cost, grossProfit }) {
  const f = Number(fact || 0);
  const c = Number(cost || 0);
  const gp = Number(grossProfit || 0);
  if (gp > 0) return gp;
  if (c > 0) return f - c;
  return null;
}

function marginFields(item) {
  const margin = computeMargin(item);
  if (margin === null) {
    return { margin: null, marginPct: null };
  }
  return {
    margin: roundMetric(margin),
    marginPct: item.fact > 0 ? percent(margin / item.fact) : null
  };
}

function parsePeriod(period) {
  const [year, month] = String(period).split('-').map(Number);
  if (!year || !month) {
    return null;
  }
  return { year, month };
}

function comparePeriods(left, right) {
  if (left.year !== right.year) {
    return left.year - right.year;
  }
  return left.month - right.month;
}

function daysInPeriod(period) {
  const parsed = parsePeriod(period);
  if (!parsed) {
    return 30;
  }
  return new Date(parsed.year, parsed.month, 0).getDate();
}

function previousPeriod(period) {
  const parsed = parsePeriod(period);
  if (!parsed) {
    return null;
  }

  const previousMonth = parsed.month === 1 ? 12 : parsed.month - 1;
  const previousYear = parsed.month === 1 ? parsed.year - 1 : parsed.year;
  return `${previousYear}-${String(previousMonth).padStart(2, '0')}`;
}

function shiftPeriod(period, offset) {
  const parsed = parsePeriod(period);
  if (!parsed) {
    return null;
  }

  const absoluteMonth = parsed.year * 12 + (parsed.month - 1) + offset;
  const year = Math.floor(absoluteMonth / 12);
  const month = (absoluteMonth % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function effectiveElapsedDays(period, lastSaleAt) {
  const parsedPeriod = parsePeriod(period);
  if (!parsedPeriod) {
    return 0;
  }

  const now = new Date();
  const currentPeriod = { year: now.getFullYear(), month: now.getMonth() + 1 };
  const relative = comparePeriods(parsedPeriod, currentPeriod);
  const totalDays = daysInPeriod(period);

  if (relative < 0) {
    return totalDays;
  }

  if (relative > 0) {
    if (!lastSaleAt) {
      return 0;
    }
    const lastSaleDate = new Date(lastSaleAt);
    return Number.isNaN(lastSaleDate.getTime()) ? 0 : Math.min(lastSaleDate.getDate(), totalDays);
  }

  // Текущий период: учитываем только сегодняшнюю дату.
  // Старая логика брала max(now.getDate(), lastSaleAt.getDate()), но если
  // в 1С BSL soldAt = дата выгрузки (а не реальная дата чека), то lastSaleAt
  // мог быть из ПРЕДЫДУЩЕГО месяца с днём 30 — и elapsedDays некорректно
  // прыгал на 30 при 4-м числе текущего месяца.
  // Учитываем lastSaleAt только если он попадает в этот же месяц И позже сегодня.
  let day = now.getDate();
  if (lastSaleAt) {
    const lastSaleDate = new Date(lastSaleAt);
    if (!Number.isNaN(lastSaleDate.getTime())) {
      const sameMonth = lastSaleDate.getFullYear() === parsedPeriod.year
        && lastSaleDate.getMonth() + 1 === parsedPeriod.month;
      if (sameMonth) {
        day = Math.max(day, lastSaleDate.getDate());
      }
    }
  }
  return Math.min(Math.max(day, 1), totalDays);
}

function forecastTone(value) {
  if (value >= 100) return 'good';
  if (value >= 90) return 'warn';
  return 'bad';
}

// Считает коэффициенты по дням недели из истории продаж (последние ~120 дней).
// Возвращает массив [7] где индекс — день недели (0=вс, 1=пн, ..., 6=сб),
// значение = относительная активность к "среднему дню" (1.0 = средний).
// Если истории мало или дисперсия низкая — возвращает null (вызов использует
// fallback на равномерный прогноз).
function computeDayOfWeekFactors(sales) {
  if (!sales || sales.length < 100) return null;
  const cutoff = Date.now() - 120 * 86400 * 1000;
  const byDay = new Map(); // dateKey → total
  for (const s of sales) {
    const at = s.soldAt || s.sold_at;
    if (!at) continue;
    const t = new Date(at).getTime();
    if (!t || t < cutoff) continue;
    const d = new Date(t);
    const dateKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    byDay.set(dateKey, (byDay.get(dateKey) || 0) + Number(s.amount || 0));
  }
  if (byDay.size < 30) return null;
  // Группируем по DoW
  const dowSum = [0,0,0,0,0,0,0];
  const dowCount = [0,0,0,0,0,0,0];
  for (const [k, v] of byDay) {
    const [y, m, d] = k.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
    dowSum[dow] += v;
    dowCount[dow] += 1;
  }
  const dowAvg = dowSum.map((s, i) => dowCount[i] > 0 ? s / dowCount[i] : 0);
  // Все DoW должны иметь хотя бы один день, иначе прогноз будет искажен
  if (dowCount.some((c) => c === 0)) return null;
  const overall = dowAvg.reduce((s, v) => s + v, 0) / 7;
  if (overall <= 0) return null;
  return dowAvg.map((v) => v / overall);
}

// YoY-прогноз: для каждого оставшегося дня берём факт того же дня в
// прошлом году (или 2 года назад если за прошлый год пусто), масштабируем
// на коэффициент роста (current_elapsed_fact / base_elapsed_fact).
//
// Автоматически учитывает:
//   - Праздники: 8 марта 2024 был всплеск → 8 марта 2026 в baseRemaining
//     уже содержит этот всплеск, прогноз поднимается.
//   - Сезонность: майские/декабрьские пики отражаются.
//
// НЕ учитывает (TODO):
//   - Новые точки (открытые после baseline) — их вклад занижается, т.к.
//     в base их не было. Для них можно добавить linear-доля.
//   - Сильные изменения ассортимента/тарифов (товар прошлого года уже снят).
function buildYoyForecast(period, totalFact, elapsedDays, totalDays, allSales) {
  // Ищем baseline — тот же месяц год назад, потом 2 года назад.
  let basePeriod = null;
  for (const back of [12, 24, 36]) {
    const candidate = shiftPeriod(period, -back);
    if (!candidate) continue;
    const hasData = allSales.some(s => s.period === candidate);
    if (hasData) { basePeriod = candidate; break; }
  }
  if (!basePeriod) return null;

  // Считаем факт по дням месяца в baseline.
  const baseDailyFact = new Map();
  for (const s of allSales) {
    if (s.period !== basePeriod) continue;
    const at = s.soldAt || s.sold_at;
    if (!at) continue;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) continue;
    const day = d.getUTCDate();
    baseDailyFact.set(day, (baseDailyFact.get(day) || 0) + Number(s.amount || 0));
  }
  if (baseDailyFact.size < 5) return null; // слишком мало данных

  // Факт baseline за прошедшие дни этого месяца
  let baseElapsed = 0;
  for (let day = 1; day <= elapsedDays; day++) baseElapsed += baseDailyFact.get(day) || 0;
  if (baseElapsed <= 0) return null;

  // Факт baseline за оставшиеся дни
  let baseRemaining = 0;
  for (let day = elapsedDays + 1; day <= totalDays; day++) baseRemaining += baseDailyFact.get(day) || 0;
  if (baseRemaining <= 0) return null;

  const growthRate = totalFact / baseElapsed;
  // Sanity-check: если baseline очень старый (например 24 мес назад) и сеть
  // с тех пор сильно выросла (новые точки, рост среднего чека), growthRate
  // получается 5-8× — YoY становится бесполезным (сеть из 2024 не такая
  // как из 2026). Реальный YoY-рост кондитерской ~1.1-1.5× в год; рост >3×
  // означает что baseline не годится для прогноза.
  if (growthRate < 0.3 || growthRate > 3.0) {
    return null;
  }
  const remainingProjection = baseRemaining * growthRate;
  return {
    projectedFact: roundMetric(totalFact + remainingProjection),
    method: 'yoy',
    basePeriod,
    growthRate: Number(growthRate.toFixed(3)),
    baseElapsed: roundMetric(baseElapsed),
    baseRemaining: roundMetric(baseRemaining)
  };
}

// Per-store прогноз. Раньше "новые точки" детектировались через день первой
// продажи в периоде — но sold_at в БД это время pull'а, а не реальная дата
// продажи, поэтому детекция врала ("4 новых точек" когда на самом деле нет).
//
// Новая логика: "новый магазин = факт в ПРЕДЫДУЩЕМ периоде равен 0".
// Это надёжный сигнал — если магазин в апреле не продавал, в мае он либо
// открылся, либо закрыт и снова открыт. В обоих случаях его текущий темп
// нельзя экстраполировать на 1-21 мая (он не работал с 1-го).
//
// Для таких точек считаем averagePerDay за половину прошедших дней —
// грубое приближение что они активны "вторую половину месяца".
// Для старых точек — averagePerDay за все elapsedDays.
function buildPerStoreForecast(period, totalDays, elapsedDays, allSales, allPlans) {
  if (!allSales || allSales.length === 0 || elapsedDays <= 0) return null;
  const remainingDays = Math.max(totalDays - elapsedDays, 0);
  if (remainingDays <= 0) return null;

  // Только магазины с планом > 0 в текущем периоде — реальные торговые точки.
  // Иначе попадают служебные каналы (склад/онлайн/корпоратив/UTF-8-битые id)
  // которые не должны влиять на прогноз сети.
  const storesWithPlan = new Map();
  for (const p of allPlans || []) {
    if (p.period !== period) continue;
    const sid = p.storeId;
    if (!sid || sid === 'undefined' || /^__/.test(sid)) continue;
    storesWithPlan.set(sid, (storesWithPlan.get(sid) || 0) + Number(p.amount || 0));
  }
  // Магазины с реальным планом
  const realStoreIds = new Set(Array.from(storesWithPlan.entries()).filter(([, plan]) => plan > 0).map(([id]) => id));
  if (realStoreIds.size < 3) return null;

  // Предыдущий период для детекции новых точек.
  const [yy, mm] = period.split('-').map(Number);
  const prevPeriod = mm === 1
    ? `${yy - 1}-12`
    : `${yy}-${String(mm - 1).padStart(2, '0')}`;
  const storesInPrev = new Set();
  for (const s of allSales) {
    if (s.period !== prevPeriod) continue;
    if (Number(s.amount || 0) <= 0) continue;
    const sid = s.storeId || s.store_id;
    if (realStoreIds.has(sid)) storesInPrev.add(sid);
  }

  // Группируем факт текущего периода по магазинам (только реальные торговые).
  const byStore = new Map();
  for (const s of allSales) {
    if (s.period !== period) continue;
    const sid = s.storeId || s.store_id;
    if (!realStoreIds.has(sid)) continue;
    if (!byStore.has(sid)) byStore.set(sid, { storeId: sid, fact: 0 });
    byStore.get(sid).fact += Number(s.amount || 0);
  }
  if (byStore.size < 3) return null;

  // Если в БД нет предыдущего периода — детекция новых невозможна,
  // per-store linear даст результат равный общему linear → пользы нет.
  if (storesInPrev.size === 0) return null;

  let projectedFact = 0;
  let newStoresCount = 0;
  for (const x of byStore.values()) {
    const isNew = !storesInPrev.has(x.storeId);
    // Для новых точек грубо считаем что они работали половину периода.
    const actualElapsed = isNew ? Math.max(elapsedDays / 2, 1) : elapsedDays;
    const averagePerDay = x.fact / actualElapsed;
    const remainingProjection = averagePerDay * remainingDays;
    projectedFact += x.fact + remainingProjection;
    if (isNew) newStoresCount += 1;
  }
  return {
    projectedFact: roundMetric(projectedFact),
    method: 'per-store-linear',
    storesCount: byStore.size,
    newStoresCount,
    prevPeriod
  };
}

function buildSalesForecast(period, totalPlan, totalFact, lastSaleAt, sales, plans) {
  const totalDays = daysInPeriod(period);
  const elapsedDays = effectiveElapsedDays(period, lastSaleAt);
  const remainingDays = Math.max(totalDays - elapsedDays, 0);
  const averagePerDay = elapsedDays > 0 ? totalFact / elapsedDays : 0;

  let projectedFact;
  let projectionMethod = 'linear';
  let projectionMeta = null;

  // Приоритет 1: YoY (учитывает праздники и сезонность реального прошлого).
  if (elapsedDays > 0 && remainingDays > 0) {
    const yoy = buildYoyForecast(period, totalFact, elapsedDays, totalDays, sales);
    if (yoy) {
      projectedFact = yoy.projectedFact;
      projectionMethod = 'yoy';
      projectionMeta = { basePeriod: yoy.basePeriod, growthRate: yoy.growthRate };
    }
  }

  // Приоритет 2: per-store linear (учитывает новые точки открытые после
  // начала месяца). Лучше общего линейного прогноза для растущей сети.
  if (projectedFact === undefined && elapsedDays > 0 && remainingDays > 0) {
    const perStore = buildPerStoreForecast(period, totalDays, elapsedDays, sales, plans);
    if (perStore) {
      projectedFact = perStore.projectedFact;
      projectionMethod = 'per-store-linear';
      projectionMeta = { storesCount: perStore.storesCount, newStoresCount: perStore.newStoresCount };
    }
  }

  // Приоритет 3: seasonal-dow (если YoY нет, но есть >120 дней истории).
  if (projectedFact === undefined) {
    const dowFactors = computeDayOfWeekFactors(sales);
    if (dowFactors && elapsedDays > 0 && remainingDays > 0) {
      const parsedPeriod = parsePeriod(period);
      if (parsedPeriod) {
        let elapsedFactorSum = 0;
        for (let day = 1; day <= elapsedDays; day++) {
          const dow = new Date(Date.UTC(parsedPeriod.year, parsedPeriod.month - 1, day)).getUTCDay();
          elapsedFactorSum += dowFactors[dow];
        }
        let remainingFactorSum = 0;
        for (let day = elapsedDays + 1; day <= totalDays; day++) {
          const dow = new Date(Date.UTC(parsedPeriod.year, parsedPeriod.month - 1, day)).getUTCDay();
          remainingFactorSum += dowFactors[dow];
        }
        const neutralDaily = elapsedFactorSum > 0 ? totalFact / elapsedFactorSum : averagePerDay;
        const remainingProjection = neutralDaily * remainingFactorSum;
        projectedFact = roundMetric(totalFact + remainingProjection);
        projectionMethod = 'seasonal-dow';
      }
    }
  }

  // Приоритет 4: линейный (последний fallback).
  if (projectedFact === undefined) {
    projectedFact = roundMetric(averagePerDay * totalDays);
    projectionMethod = 'linear';
  }

  const projectedCompletion = totalPlan > 0 ? percent(projectedFact / totalPlan) : 0;
  const requiredPerDayToPlan = remainingDays > 0 ? roundMetric(Math.max(totalPlan - totalFact, 0) / remainingDays) : 0;
  const planPerDay = totalDays > 0 ? totalPlan / totalDays : 0;
  const paceVsPlan = planPerDay > 0 ? percent(averagePerDay / planPerDay) : 0;
  const runwayGap = roundMetric(projectedFact - totalPlan);

  return {
    totalDays,
    elapsedDays,
    remainingDays,
    averagePerDay: roundMetric(averagePerDay),
    requiredPerDayToPlan,
    projectedFact,
    projectedCompletion,
    planPerDay: roundMetric(planPerDay),
    paceVsPlan,
    runwayGap,
    projectionMethod,
    projectionMeta,
    tone: forecastTone(projectedCompletion),
    status:
      projectedCompletion >= 100
        ? 'План закрывается по текущему темпу'
        : requiredPerDayToPlan > averagePerDay
          ? 'Текущего темпа недостаточно'
          : 'План достижим при сохранении темпа'
  };
}

function buildDailySeries(period, plans, sales) {
  const totalDays = daysInPeriod(period);
  const dailyPlan = Array.from({ length: totalDays }, () => 0);
  const dailyFact = Array.from({ length: totalDays }, () => 0);
  const totalPlan = plans.reduce((sum, item) => sum + toNumber(item.amount), 0);
  const planPerDay = totalDays > 0 ? totalPlan / totalDays : 0;

  for (let index = 0; index < totalDays; index += 1) {
    dailyPlan[index] = planPerDay;
  }

  for (const row of sales) {
    const soldAt = new Date(row.soldAt);
    if (Number.isNaN(soldAt.getTime())) {
      continue;
    }
    const dayIndex = soldAt.getDate() - 1;
    if (dayIndex >= 0 && dayIndex < totalDays) {
      dailyFact[dayIndex] += toNumber(row.amount);
    }
  }

  let cumulativePlan = 0;
  let cumulativeFact = 0;

  return Array.from({ length: totalDays }, (_, index) => {
    cumulativePlan += dailyPlan[index];
    cumulativeFact += dailyFact[index];
    const gap = roundMetric(cumulativeFact - cumulativePlan);
    return {
      day: index + 1,
      plan: roundMetric(dailyPlan[index]),
      fact: roundMetric(dailyFact[index]),
      cumulativePlan: roundMetric(cumulativePlan),
      cumulativeFact: roundMetric(cumulativeFact),
      gap,
      percent: cumulativePlan > 0 ? percent(cumulativeFact / cumulativePlan) : 0
    };
  });
}

function buildPeriodComparison(db, period, currentTotals) {
  const prevPeriod = previousPeriod(period);
  if (!prevPeriod) {
    return null;
  }

  const previous = aggregatePeriodCore(db, prevPeriod);
  const hasPreviousData = previous.totals.plan > 0 || previous.totals.fact > 0;

  if (!hasPreviousData) {
    return {
      previousPeriod: prevPeriod,
      hasData: false
    };
  }

  const factDelta = roundMetric(currentTotals.fact - previous.totals.fact);
  const planDelta = roundMetric(currentTotals.plan - previous.totals.plan);
  const completionDelta = roundMetric(currentTotals.completion - previous.totals.completion);
  const quantityDelta = roundMetric(currentTotals.quantity - previous.totals.quantity);

  const haveBothMargins = currentTotals.margin !== null && previous.totals.margin !== null;
  const marginDelta = haveBothMargins ? roundMetric(currentTotals.margin - previous.totals.margin) : null;
  const marginDeltaPercent = haveBothMargins && previous.totals.margin > 0
    ? percent(marginDelta / previous.totals.margin)
    : null;

  return {
    previousPeriod: prevPeriod,
    hasData: true,
    factDelta,
    factDeltaPercent: previous.totals.fact > 0 ? percent(factDelta / previous.totals.fact) : 0,
    planDelta,
    completionDelta,
    quantityDelta,
    marginDelta,
    marginDeltaPercent,
    previousTotals: previous.totals,
    tone: factDelta >= 0 ? 'good' : 'bad'
  };
}

function buildYoYComparison(db, period, currentTotals) {
  // Ищем тот же месяц год назад, потом 2 года назад (если нет данных за прошлый
  // год — частая ситуация у нас, есть май 2024 но нет мая 2025).
  let yoyPeriod = null;
  let previous = null;
  let yearsBack = 0;
  for (const back of [12, 24, 36]) {
    const candidate = shiftPeriod(period, -back);
    if (!candidate) continue;
    const agg = aggregatePeriodCore(db, candidate);
    if (agg.totals.plan > 0 || agg.totals.fact > 0) {
      yoyPeriod = candidate;
      previous = agg;
      yearsBack = back / 12;
      break;
    }
  }
  if (!previous) {
    return { previousPeriod: shiftPeriod(period, -12), hasData: false };
  }

  const factDelta = roundMetric(currentTotals.fact - previous.totals.fact);
  const completionDelta = roundMetric(currentTotals.completion - previous.totals.completion);
  const quantityDelta = roundMetric(currentTotals.quantity - previous.totals.quantity);
  const haveBothMargins = currentTotals.margin !== null && previous.totals.margin !== null;
  const marginDelta = haveBothMargins ? roundMetric(currentTotals.margin - previous.totals.margin) : null;

  // Per-store yoy: процент выполнения каждого магазина в YoY-периоде.
  // Использует storeId как ключ, фронтенд накладывает на текущую таблицу
  // магазинов для колонки «vs год назад».
  const storesPercent = Object.fromEntries((previous.stores || []).map(s => [s.storeId, s.percent]));
  const storesFact = Object.fromEntries((previous.stores || []).map(s => [s.storeId, s.fact]));

  return {
    previousPeriod: yoyPeriod,
    yearsBack,
    hasData: true,
    factDelta,
    factDeltaPercent: previous.totals.fact > 0 ? percent(factDelta / previous.totals.fact) : 0,
    completionDelta,
    quantityDelta,
    marginDelta,
    previousTotals: previous.totals,
    storesPercent,
    storesFact,
    tone: factDelta >= 0 ? 'good' : 'bad'
  };
}

function buildTrend(db, period, windowSize = 12) {
  const periods = [];

  for (let index = windowSize - 1; index >= 0; index -= 1) {
    const currentPeriod = shiftPeriod(period, -index);
    if (!currentPeriod) {
      continue;
    }

    const summary = aggregatePeriodCore(db, currentPeriod);
    periods.push({
      period: currentPeriod,
      plan: roundMetric(summary.totals.plan),
      fact: roundMetric(summary.totals.fact),
      margin: summary.totals.margin === null ? null : roundMetric(summary.totals.margin),
      marginPct: summary.totals.marginPct,
      completion: summary.totals.completion,
      gap: roundMetric(summary.totals.gap),
      quantity: roundMetric(summary.totals.quantity)
    });
  }

  const activePeriods = periods.filter((item) => item.plan > 0 || item.fact > 0);
  const latest = activePeriods.at(-1) || null;
  const previous = activePeriods.length > 1 ? activePeriods.at(-2) : null;

  return {
    periods,
    latest,
    previous,
    factDeltaFromPrevious: latest && previous ? roundMetric(latest.fact - previous.fact) : 0,
    completionDeltaFromPrevious: latest && previous ? roundMetric(latest.completion - previous.completion) : 0
  };
}

function upsertEntities(list, incoming) {
  const map = new Map(list.map((item) => [item.id, item]));
  for (const item of incoming) {
    map.set(item.id, { ...(map.get(item.id) || {}), ...item });
  }
  return Array.from(map.values());
}

function normalizeDb(db) {
  return {
    stores: Array.isArray(db.stores) ? db.stores : [],
    products: Array.isArray(db.products) ? db.products : [],
    plans: Array.isArray(db.plans) ? db.plans : [],
    sales: Array.isArray(db.sales) ? db.sales : [],
    marketing: Array.isArray(db.marketing) ? db.marketing : [],
    ingestRuns: Array.isArray(db.ingestRuns) ? db.ingestRuns : [],
    rawUppPayloads: Array.isArray(db.rawUppPayloads) ? db.rawUppPayloads : [],
    comments: Array.isArray(db.comments) ? db.comments : [],
    users: Array.isArray(db.users) ? db.users : []
  };
}

/**
 * Возвращает view БД, отфильтрованный под пользователя.
 * admin (или null) — без изменений. manager — только привязанные точки.
 */
function scopeDbForUser(db, user) {
  if (!user || user.role === 'admin') return db;
  const allowed = new Set(user.stores || []);
  if (allowed.size === 0) {
    return { ...db, stores: [], plans: [], sales: [] };
  }
  return {
    ...db,
    stores: db.stores.filter((s) => allowed.has(s.id)),
    plans: db.plans.filter((p) => allowed.has(p.storeId)),
    sales: db.sales.filter((s) => allowed.has(s.storeId))
  };
}

function aggregatePeriodCore(db, period, opts = {}) {
  const costCapRatio = getCostCapRatio(opts.costCapRatio);
  const storeMarkups = getStoreMarkups(opts.storeMarkups);
  const stores = new Map(db.stores.map((item) => [item.id, item]));
  const products = new Map(db.products.map((item) => [item.id, item]));
  const plans = db.plans.filter((item) => item.period === period && item.storeId !== 'undefined' && item.productId !== 'undefined');
  const sales = db.sales.filter((item) => item.period === period && item.storeId !== 'undefined' && item.productId !== 'undefined');

  // Pre-pass: для каждого магазина с заданным markup считаем scale-фактор,
  // приводящий суммарный cost магазина к целевому (fact / (1 + markup/100)).
  // Это даёт точное совпадение тоталов по магазину с отчётом «Валовая прибыль»,
  // сохраняя распределение cost между товарами.
  //
  // Fallback на storeMarkupFallback: если BSL /pull не передал себестоимость
  // (cost=0 на всех строках), а markup для магазина задан — считаем cost
  // прямо из факта в per-row loop. Иначе marginPct=null и блок «Маржа»
  // на дашборде показывает «—», что неинформативно.
  const storeCostScale = new Map();
  const storeMarkupFallback = new Map();
  if (Object.keys(storeMarkups).length > 0) {
    const rawByStore = new Map();
    for (const row of sales) {
      const cur = rawByStore.get(row.storeId) || { fact: 0, cost: 0 };
      cur.fact += toNumber(row.amount);
      cur.cost += toNumber(row.cost);
      rawByStore.set(row.storeId, cur);
    }
    for (const [sid, { fact, cost }] of rawByStore) {
      const markup = storeMarkups[sid];
      if (!markup) continue;
      if (cost > 0) {
        const targetCost = fact / (1 + markup / 100);
        // Применяем scale только если он уменьшает cost (никогда не наращиваем).
        const scale = targetCost / cost;
        storeCostScale.set(sid, scale < 1 ? scale : 1);
      } else if (fact > 0) {
        storeMarkupFallback.set(sid, markup);
      }
    }
  }

  const byStore = new Map();
  const byProduct = new Map();

  for (const store of stores.values()) {
    byStore.set(store.id, {
      storeId: store.id,
      storeName: store.name,
      region: store.region || '',
      source: store.source || '',
      plan: 0,
      fact: 0,
      cost: 0,
      grossProfit: 0,
      quantity: 0
    });
  }

  for (const product of products.values()) {
    byProduct.set(product.id, {
      productId: product.id,
      productName: product.name,
      category: product.category || '',
      plan: 0,
      fact: 0,
      cost: 0,
      grossProfit: 0,
      quantity: 0
    });
  }

  for (const row of plans) {
    if (!byStore.has(row.storeId)) {
      byStore.set(row.storeId, {
        storeId: row.storeId,
        storeName: row.storeId,
        region: '',
        source: '',
        plan: 0,
        fact: 0,
        cost: 0,
        grossProfit: 0,
        quantity: 0
      });
    }
    if (!byProduct.has(row.productId)) {
      byProduct.set(row.productId, {
        productId: row.productId,
        productName: row.productId,
        category: '',
        plan: 0,
        fact: 0,
        cost: 0,
        grossProfit: 0,
        quantity: 0
      });
    }
    byStore.get(row.storeId).plan += toNumber(row.amount);
    byProduct.get(row.productId).plan += toNumber(row.amount);
  }

  for (const row of sales) {
    if (!byStore.has(row.storeId)) {
      byStore.set(row.storeId, {
        storeId: row.storeId,
        storeName: row.storeId,
        region: '',
        source: '',
        plan: 0,
        fact: 0,
        cost: 0,
        grossProfit: 0,
        quantity: 0
      });
    }
    if (!byProduct.has(row.productId)) {
      byProduct.set(row.productId, {
        productId: row.productId,
        productName: row.productId,
        category: '',
        plan: 0,
        fact: 0,
        cost: 0,
        grossProfit: 0,
        quantity: 0
      });
    }
    const scale = storeCostScale.get(row.storeId);
    const markupFallback = storeMarkupFallback.get(row.storeId);
    let cappedRowCost;
    if (scale !== undefined) {
      cappedRowCost = toNumber(row.cost) * scale;
    } else if (markupFallback !== undefined && toNumber(row.cost) === 0) {
      // 1С не передал себестоимость — реконструируем через markup магазина
      cappedRowCost = toNumber(row.amount) / (1 + markupFallback / 100);
    } else {
      cappedRowCost = capCost(row.amount, row.cost, costCapRatio);
    }
    byStore.get(row.storeId).fact += toNumber(row.amount);
    byStore.get(row.storeId).cost += cappedRowCost;
    byStore.get(row.storeId).grossProfit += toNumber(row.grossProfit);
    byStore.get(row.storeId).quantity += toNumber(row.quantity);
    byProduct.get(row.productId).fact += toNumber(row.amount);
    byProduct.get(row.productId).cost += cappedRowCost;
    byProduct.get(row.productId).grossProfit += toNumber(row.grossProfit);
    byProduct.get(row.productId).quantity += toNumber(row.quantity);
  }

  const allStoresList = Array.from(byStore.values())
    .filter((item) => item.plan > 0 || item.fact > 0)
    .map((item) => ({
      ...item,
      ...marginFields(item),
      percent: item.plan > 0 ? percent(item.fact / item.plan) : 0,
      gap: item.fact - item.plan
    }))
    .sort((a, b) => b.percent - a.percent);

  // Виртуальные store-id (например __extra_directions__) скрываем из таблицы
  // магазинов, но их план учитывается в totals.plan через allStoresList.
  const storesList = allStoresList.filter((s) => !String(s.storeId).startsWith('__'));

  const productsList = Array.from(byProduct.values())
    .filter((item) => item.plan > 0 || item.fact > 0)
    .map((item) => ({
      ...item,
      ...marginFields(item),
      percent: item.plan > 0 ? percent(item.fact / item.plan) : 0,
      gap: item.fact - item.plan
    }))
    .sort((a, b) => b.fact - a.fact);

  // totals = только настоящие магазины (без виртуальных __* записей).
  // План = сумма планов 1С (СТС, как было раньше).
  const totalPlan = storesList.reduce((sum, item) => sum + item.plan, 0);
  const totalFact = storesList.reduce((sum, item) => sum + item.fact, 0);
  const totalCost = storesList.reduce((sum, item) => sum + item.cost, 0);
  const totalGrossProfit = storesList.reduce((sum, item) => sum + Number(item.grossProfit || 0), 0);
  const totalMargin = computeMargin({ fact: totalFact, cost: totalCost, grossProfit: totalGrossProfit });
  const totalQuantity = storesList.reduce((sum, item) => sum + item.quantity, 0);
  const completion = totalPlan > 0 ? percent(totalFact / totalPlan) : 0;
  // Лидер/Отстающий для карточек-героев на главной. Применяем те же фильтры
  // что в insights.js (LEADER_PLAN_MIN, LEADER_PERCENT_MAX) и исключаем точки
  // без плана из отстающих — иначе:
  //   - лидером оказывается «Солнечный 11/4» с планом 100К и факт 660К (661%),
  //     это план-аномалия а не лидерство;
  //   - отстающим — «Пятая армия» с plan=0 и percent=0, что не информативно.
  // Когда настоящего лидера по проценту нет (типично в середине месяца —
  // все 50-70%), показываем топ по абсолютной выручке с пометкой leaderKind.
  const LEADER_PLAN_MIN = 500000;
  const LEADER_PERCENT_MAX = 200;
  const leaderByPercent = storesList.find((s) =>
    s.plan >= LEADER_PLAN_MIN &&
    s.percent >= 100 &&
    s.percent <= LEADER_PERCENT_MAX
  );
  const leaderByRevenue = [...storesList]
    .filter((s) => s.fact > 0)
    .sort((a, b) => (b.fact || 0) - (a.fact || 0))[0];
  const leader = leaderByPercent
    ? { ...leaderByPercent, leaderKind: 'percent' }
    : (leaderByRevenue ? { ...leaderByRevenue, leaderKind: 'revenue' } : null);
  const lagger = [...storesList]
    .filter((s) => s.plan > 0)
    .sort((a, b) => a.percent - b.percent)[0] || null;
  const lastSaleAt = sales.map((item) => item.soldAt).filter(Boolean).sort().at(-1) || null;
  // Для DoW-сезонности передаём все продажи (не только за текущий period) —
  // тогда последние 120 дней попадают в расчёт независимо от того где они
  // (текущий или прошлый месяц).
  const forecast = buildSalesForecast(period, totalPlan, totalFact, lastSaleAt, db.sales, db.plans);
  const daily = buildDailySeries(period, plans, sales);

  return {
    period,
    totals: {
      plan: totalPlan,
      fact: totalFact,
      cost: roundMetric(totalCost),
      margin: totalMargin === null ? null : roundMetric(totalMargin),
      marginPct: totalMargin === null || totalFact <= 0 ? null : percent(totalMargin / totalFact),
      gap: totalFact - totalPlan,
      quantity: totalQuantity,
      completion
    },
    stores: storesList,
    products: productsList,
    forecast,
    daily,
    leader,
    lagger,
    lastSaleAt
  };
}

// Накопленный факт за период до дня <=cutoffDay (включительно).
// Используется чтобы сравнить «факт на N-й день этого месяца» с тем же N-м днём прошлого года.
function factSumUntilDay(db, period, cutoffDay) {
  let sum = 0;
  for (const s of db.sales || []) {
    if (s.period !== period) continue;
    const at = s.soldAt || s.sold_at;
    if (!at) continue;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) continue;
    if (d.getUTCDate() > cutoffDay) continue;
    sum += Number(s.amount || 0);
  }
  return sum;
}

function aggregateDashboard(db, period, opts = {}) {
  const summary = aggregatePeriodCore(db, period, opts);
  const trendWindow = opts.trendWindow || 12;
  const f = summary.forecast || {};

  // Метрики «на сегодня»: план-до-сегодня + факт прошлого года на тот же день.
  // Для ТЕКУЩЕГО месяца считаем план дробно — с учётом которая часть сегодняшнего
  // дня прошла (по Иркутскому времени UTC+8). Иначе сравнение факта с планом
  // на КОНЕЦ сегодняшнего дня вводит в заблуждение: к 13:00 факт сделал 50%
  // дня, а план уже 100% — выходит, что выполнили план хотя на самом деле нет.
  const elapsedDays = f.elapsedDays || 0;
  const irkNow = new Date(Date.now() + 8 * 3600 * 1000);
  const todayMonthKey = `${irkNow.getUTCFullYear()}-${String(irkNow.getUTCMonth() + 1).padStart(2, '0')}`;
  const isCurrentMonth = period === todayMonthKey;
  let elapsedDaysEffective = elapsedDays;
  if (isCurrentMonth && elapsedDays > 0) {
    const hoursToday = irkNow.getUTCHours() + irkNow.getUTCMinutes() / 60;
    elapsedDaysEffective = Math.max(0, elapsedDays - 1 + hoursToday / 24);
  }
  const planToDate = (f.planPerDay || 0) * elapsedDaysEffective;
  let yoyTodayFact = null;
  let yoyTodayPeriod = null;
  let yoyTodayYearsBack = 0;
  if (elapsedDays > 0) {
    // Ищем тот же день за прошлый год, потом 2/3 года назад если нет
    for (const back of [12, 24, 36]) {
      const yp = shiftPeriod(period, -back);
      if (!yp) continue;
      const fact = factSumUntilDay(db, yp, elapsedDays);
      // Проверяем что в этом периоде вообще есть какие-то sales (иначе пропускаем)
      const hasAny = (db.sales || []).some(s => s.period === yp);
      if (hasAny) {
        yoyTodayFact = Number(fact.toFixed(2));
        yoyTodayPeriod = yp;
        yoyTodayYearsBack = back / 12;
        break;
      }
    }
  }

  return {
    ...summary,
    today: {
      elapsedDays,
      elapsedDaysFractional: Number(elapsedDaysEffective.toFixed(3)),
      isCurrentMonth,
      planToDate: Number(planToDate.toFixed(2)),
      factToDate: Number((summary.totals.fact || 0).toFixed(2)),
      gapToDate: Number((planToDate - (summary.totals.fact || 0)).toFixed(2)),
      yoyTodayFact,
      yoyTodayPeriod,
      yoyTodayYearsBack
    },
    comparison: buildPeriodComparison(db, period, summary.totals),
    yoy: buildYoYComparison(db, period, summary.totals),
    trend: buildTrend(db, period, trendWindow),
    planHealth: assessPlanHealth(db, period, summary.totals.plan)
  };
}

// Эвристика «неполный план»: план на текущий месяц похож на накопительный
// (сумма с начала месяца до сегодня), а не на полный месячный.
// Срабатывает когда currentPlan ≈ previousPlan × (elapsedDays / daysInMonth).
function assessPlanHealth(db, period, currentPlan) {
  const now = new Date();
  const todayMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const isCurrentMonth = period === todayMonth;
  if (!isCurrentMonth || !currentPlan || currentPlan <= 0) {
    return { ok: true };
  }

  const prevPeriod = previousPeriod(period);
  const prev = aggregatePeriodCore(db, prevPeriod);
  const previousPlan = prev?.totals?.plan || 0;
  if (previousPlan <= 0) return { ok: true };

  const daysInMonth = daysInPeriod(period);
  const elapsedDays = Math.max(now.getUTCDate(), 1);
  const elapsedRatio = Math.min(elapsedDays / daysInMonth, 1);

  // Если план "съёжен" и совпадает с долей прошедших дней от прошлого плана —
  // это явный признак накопительного плана от 1С.
  const expectedAccumulated = previousPlan * elapsedRatio;
  const matchAccumulated = currentPlan / Math.max(expectedAccumulated, 1);
  const ratioVsPrev = currentPlan / previousPlan;

  if (matchAccumulated >= 0.6 && matchAccumulated <= 1.4 && ratioVsPrev < 0.6 && elapsedRatio < 0.7) {
    return {
      ok: false,
      kind: 'accumulated',
      currentPlan: roundMetric(currentPlan),
      previousPlan: roundMetric(previousPlan),
      expectedFullPlan: roundMetric(previousPlan),
      elapsedRatio: roundMetric(elapsedRatio * 100),
      message: 'План на текущий месяц похож на накопительный (только за прошедшие дни). Проверьте, что в 1С запрос плана берёт обороты за весь месяц, а не до текущей даты.'
    };
  }

  return { ok: true };
}

function storeDetails(db, period, storeId, opts = {}) {
  const costCapRatio = getCostCapRatio(opts.costCapRatio);
  const storeMarkups = getStoreMarkups(opts.storeMarkups);
  const store = db.stores.find((item) => item.id === storeId) || { id: storeId, name: storeId };
  const productMap = new Map(db.products.map((item) => [item.id, item]));
  const plans = db.plans.filter((item) => item.period === period && item.storeId === storeId);
  const sales = db.sales.filter((item) => item.period === period && item.storeId === storeId);

  // Pre-pass scale (как в aggregatePeriodCore) — для того же магазина.
  // Если cost=0 на всех строках (1С не передал себестоимость), но markup
  // задан — fallback на расчёт через markup в per-row loop ниже.
  let storeCostScale;
  let storeMarkupFallback;
  const markup = storeMarkups[storeId];
  if (markup) {
    let rawFact = 0, rawCost = 0;
    for (const row of sales) { rawFact += toNumber(row.amount); rawCost += toNumber(row.cost); }
    if (rawCost > 0) {
      const targetCost = rawFact / (1 + markup / 100);
      const sc = targetCost / rawCost;
      if (sc < 1) storeCostScale = sc;
    } else if (rawFact > 0) {
      storeMarkupFallback = markup;
    }
  }
  const rows = new Map();

  for (const row of plans) {
    const product = productMap.get(row.productId);
    rows.set(row.productId, {
      productId: row.productId,
      productName: product?.name || row.productId,
      category: product?.category || '',
      plan: toNumber(row.amount),
      fact: 0,
      cost: 0,
      grossProfit: 0,
      quantity: 0
    });
  }

  for (const row of sales) {
    const product = productMap.get(row.productId);
    if (!rows.has(row.productId)) {
      rows.set(row.productId, {
        productId: row.productId,
        productName: product?.name || row.productId,
        category: product?.category || '',
        plan: 0,
        fact: 0,
        cost: 0,
        grossProfit: 0,
        quantity: 0
      });
    }
    const item = rows.get(row.productId);
    item.fact += toNumber(row.amount);
    if (storeCostScale !== undefined) {
      item.cost += toNumber(row.cost) * storeCostScale;
    } else if (storeMarkupFallback !== undefined && toNumber(row.cost) === 0) {
      item.cost += toNumber(row.amount) / (1 + storeMarkupFallback / 100);
    } else {
      item.cost += capCost(row.amount, row.cost, costCapRatio);
    }
    item.grossProfit += toNumber(row.grossProfit);
    item.quantity += toNumber(row.quantity);
  }

  const items = Array.from(rows.values())
    .map((item) => ({
      ...item,
      ...marginFields(item),
      percent: item.plan > 0 ? percent(item.fact / item.plan) : 0,
      gap: item.fact - item.plan
    }))
    .sort((a, b) => b.fact - a.fact);

  return {
    period,
    store: {
      id: store.id,
      name: store.name,
      region: store.region || ''
    },
    items
  };
}

function listPeriods(db) {
  const values = new Set();
  for (const row of db.plans) values.add(row.period);
  for (const row of db.sales) values.add(row.period);
  return Array.from(values).sort().reverse();
}

function replacePlans(db, body) {
  const period = monthKey(body.period);
  if (!Array.isArray(body.plans)) {
    throw new Error('plans must be an array');
  }

  db.stores = upsertEntities(db.stores, Array.isArray(body.stores) ? body.stores : []);
  db.products = upsertEntities(db.products, Array.isArray(body.products) ? body.products : []);
  db.plans = db.plans.filter((item) => item.period !== period);

  for (const item of body.plans) {
    if (!item.storeId || !item.productId) {
      throw new Error('Each plan row must include storeId and productId');
    }
    db.plans.push({
      period,
      storeId: String(item.storeId),
      productId: String(item.productId),
      amount: toNumber(item.amount)
    });
  }

  return period;
}

function appendSales(db, body) {
  const period = monthKey(body.period);
  if (!Array.isArray(body.sales)) {
    throw new Error('sales must be an array');
  }

  db.stores = upsertEntities(db.stores, Array.isArray(body.stores) ? body.stores : []);
  db.products = upsertEntities(db.products, Array.isArray(body.products) ? body.products : []);

  if (body.replace) {
    db.sales = db.sales.filter((item) => item.period !== period);
  }

  for (const item of body.sales) {
    if (!item.storeId || !item.productId) {
      throw new Error('Each sales row must include storeId and productId');
    }
    db.sales.push({
      period,
      storeId: String(item.storeId),
      productId: String(item.productId),
      amount: toNumber(item.amount),
      cost: toNumber(item.cost),
      grossProfit: toNumber(item.grossProfit),
      quantity: toNumber(item.quantity),
      soldAt: item.soldAt || new Date().toISOString()
    });
  }

  return period;
}

module.exports = {
  appendSales,
  aggregateDashboard,
  listPeriods,
  monthKey,
  normalizeDb,
  replacePlans,
  scopeDbForUser,
  storeDetails
};
