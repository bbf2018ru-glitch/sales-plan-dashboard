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

function safeDivide(a, b) {
  return b > 0 ? a / b : 0;
}

function percent(value) {
  return Number((value * 100).toFixed(1));
}

function roundMetric(value) {
  return Number(value.toFixed(2));
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

  const candidateDates = [now];
  if (lastSaleAt) {
    const lastSaleDate = new Date(lastSaleAt);
    if (!Number.isNaN(lastSaleDate.getTime())) {
      candidateDates.push(lastSaleDate);
    }
  }

  const maxDay = Math.max(...candidateDates.map((date) => date.getDate()));
  return Math.min(Math.max(maxDay, 1), totalDays);
}

function forecastTone(value) {
  if (value >= 100) return 'good';
  if (value >= 90) return 'warn';
  return 'bad';
}

function buildSalesForecast(period, totalPlan, totalFact, lastSaleAt) {
  const totalDays = daysInPeriod(period);
  const elapsedDays = effectiveElapsedDays(period, lastSaleAt);
  const remainingDays = Math.max(totalDays - elapsedDays, 0);
  const averagePerDay = elapsedDays > 0 ? totalFact / elapsedDays : 0;
  const projectedFact = roundMetric(averagePerDay * totalDays);
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
  const marginDelta = roundMetric((currentTotals.margin || 0) - (previous.totals.margin || 0));

  return {
    previousPeriod: prevPeriod,
    hasData: true,
    factDelta,
    factDeltaPercent: previous.totals.fact > 0 ? percent(factDelta / previous.totals.fact) : 0,
    planDelta,
    completionDelta,
    quantityDelta,
    marginDelta,
    marginDeltaPercent: previous.totals.margin > 0 ? percent(marginDelta / previous.totals.margin) : 0,
    previousTotals: previous.totals,
    tone: factDelta >= 0 ? 'good' : 'bad'
  };
}

function buildTrend(db, period, windowSize = 6) {
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
      margin: roundMetric(summary.totals.margin),
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

function buildExecutiveSummary(summary, marketing) {
  const headlines = [];
  const priorities = [];
  const alerts = [];

  headlines.push(`Факт ${summary.totals.fact.toFixed(0)} ₽ при плане ${summary.totals.plan.toFixed(0)} ₽. Выполнение ${summary.totals.completion}%.`);
  headlines.push(`Прогноз на конец месяца ${summary.forecast.projectedFact.toFixed(0)} ₽, это ${summary.forecast.projectedCompletion}% от плана.`);
  if (summary.totals.margin > 0) {
    headlines.push(`Маржа: ${summary.totals.margin.toFixed(0)} ₽ (${summary.totals.marginPct}% от выручки).`);
  }

  if (summary.comparison?.hasData) {
    headlines.push(`К прошлому периоду факт изменился на ${summary.comparison.factDelta >= 0 ? '+' : ''}${summary.comparison.factDelta.toFixed(0)} ₽.`);
  }

  if (summary.forecast.projectedCompletion < 100) {
    alerts.push(`Если темп не изменится, план месяца не будет выполнен. Нужно ${summary.forecast.requiredPerDayToPlan.toFixed(0)} ₽ в день.`);
    priorities.push('Усилить продажи в точках с минимальным процентом выполнения и вывести отдельный план действий по каждой точке.');
  } else {
    priorities.push('Зафиксировать рабочий темп и удерживать текущий объем продаж до конца периода.');
  }

  if (summary.lagger) {
    alerts.push(`Наибольший риск у точки ${summary.lagger.storeName}: выполнение ${summary.lagger.percent}% и разрыв ${summary.lagger.gap.toFixed(0)} ₽.`);
  }

  if (marketing?.bestChannel) {
    headlines.push(`Лучший маркетинговый канал: ${marketing.bestChannel.channelName}, ROAS ${marketing.bestChannel.roas}.`);
    priorities.push(`Масштабировать ${marketing.bestChannel.channelName}, пока канал держит ROAS выше среднего.`);
  }

  if (marketing?.worstChannel) {
    alerts.push(`Проблемный маркетинговый канал: ${marketing.worstChannel.channelName}, CAC ${marketing.worstChannel.cac.toFixed(0)} ₽.`);
    priorities.push(`Пересобрать оффер или сократить бюджет в ${marketing.worstChannel.channelName}.`);
  }

  const topProduct = summary.products[0] || null;
  if (topProduct) {
    headlines.push(`Главный драйвер выручки: ${topProduct.productName}, факт ${topProduct.fact.toFixed(0)} ₽.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    headlines,
    priorities,
    alerts
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
    comments: Array.isArray(db.comments) ? db.comments : []
  };
}

function aggregatePeriodCore(db, period) {
  const stores = new Map(db.stores.map((item) => [item.id, item]));
  const products = new Map(db.products.map((item) => [item.id, item]));
  const plans = db.plans.filter((item) => item.period === period && item.storeId !== 'undefined' && item.productId !== 'undefined');
  const sales = db.sales.filter((item) => item.period === period && item.storeId !== 'undefined' && item.productId !== 'undefined');

  const byStore = new Map();
  const byProduct = new Map();

  for (const store of stores.values()) {
    byStore.set(store.id, {
      storeId: store.id,
      storeName: store.name,
      region: store.region || '',
      plan: 0,
      fact: 0,
      cost: 0,
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
      quantity: 0
    });
  }

  for (const row of plans) {
    if (!byStore.has(row.storeId)) {
      byStore.set(row.storeId, {
        storeId: row.storeId,
        storeName: row.storeId,
        region: '',
        plan: 0,
        fact: 0,
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
        plan: 0,
        fact: 0,
        cost: 0,
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
        quantity: 0
      });
    }
    byStore.get(row.storeId).fact += toNumber(row.amount);
    byStore.get(row.storeId).cost += toNumber(row.cost);
    byStore.get(row.storeId).quantity += toNumber(row.quantity);
    byProduct.get(row.productId).fact += toNumber(row.amount);
    byProduct.get(row.productId).cost += toNumber(row.cost);
    byProduct.get(row.productId).quantity += toNumber(row.quantity);
  }

  const storesList = Array.from(byStore.values())
    .map((item) => {
      const margin = item.fact - item.cost;
      return {
        ...item,
        margin: roundMetric(margin),
        marginPct: item.fact > 0 ? percent(margin / item.fact) : 0,
        percent: item.plan > 0 ? percent(item.fact / item.plan) : 0,
        gap: item.fact - item.plan
      };
    })
    .sort((a, b) => b.percent - a.percent);

  const productsList = Array.from(byProduct.values())
    .map((item) => {
      const margin = item.fact - item.cost;
      return {
        ...item,
        margin: roundMetric(margin),
        marginPct: item.fact > 0 ? percent(margin / item.fact) : 0,
        percent: item.plan > 0 ? percent(item.fact / item.plan) : 0,
        gap: item.fact - item.plan
      };
    })
    .sort((a, b) => b.fact - a.fact);

  const totalPlan = storesList.reduce((sum, item) => sum + item.plan, 0);
  const totalFact = storesList.reduce((sum, item) => sum + item.fact, 0);
  const totalCost = storesList.reduce((sum, item) => sum + item.cost, 0);
  const totalMargin = totalFact - totalCost;
  const totalQuantity = storesList.reduce((sum, item) => sum + item.quantity, 0);
  const completion = totalPlan > 0 ? percent(totalFact / totalPlan) : 0;
  const leader = storesList[0] || null;
  const lagger = [...storesList].sort((a, b) => a.percent - b.percent)[0] || null;
  const lastSaleAt = sales.map((item) => item.soldAt).filter(Boolean).sort().at(-1) || null;
  const forecast = buildSalesForecast(period, totalPlan, totalFact, lastSaleAt);
  const daily = buildDailySeries(period, plans, sales);

  return {
    period,
    totals: {
      plan: totalPlan,
      fact: totalFact,
      cost: roundMetric(totalCost),
      margin: roundMetric(totalMargin),
      marginPct: totalFact > 0 ? percent(totalMargin / totalFact) : 0,
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

function aggregateDashboard(db, period) {
  const summary = aggregatePeriodCore(db, period);
  const marketing = aggregateMarketing(db, period);
  return {
    ...summary,
    comparison: buildPeriodComparison(db, period, summary.totals),
    trend: buildTrend(db, period),
    executive: buildExecutiveSummary(summary, marketing)
  };
}

function storeDetails(db, period, storeId) {
  const store = db.stores.find((item) => item.id === storeId) || { id: storeId, name: storeId };
  const productMap = new Map(db.products.map((item) => [item.id, item]));
  const plans = db.plans.filter((item) => item.period === period && item.storeId === storeId);
  const sales = db.sales.filter((item) => item.period === period && item.storeId === storeId);
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
        quantity: 0
      });
    }
    const item = rows.get(row.productId);
    item.fact += toNumber(row.amount);
    item.cost += toNumber(row.cost);
    item.quantity += toNumber(row.quantity);
  }

  const items = Array.from(rows.values())
    .map((item) => {
      const margin = item.fact - item.cost;
      return {
        ...item,
        margin: roundMetric(margin),
        marginPct: item.fact > 0 ? percent(margin / item.fact) : 0,
        percent: item.plan > 0 ? percent(item.fact / item.plan) : 0,
        gap: item.fact - item.plan
      };
    })
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

function aggregateMarketing(db, period) {
  const rows = db.marketing.filter((item) => item.period === period);
  const channelMap = new Map();

  for (const row of rows) {
    const channelId = String(row.channelId || 'unknown');
    if (!channelMap.has(channelId)) {
      channelMap.set(channelId, {
        channelId,
        channelName: row.channelName || channelId,
        spend: 0,
        leads: 0,
        orders: 0,
        revenue: 0,
        impressions: 0,
        clicks: 0,
        sessions: 0
      });
    }

    const item = channelMap.get(channelId);
    item.spend += toNumber(row.spend);
    item.leads += toNumber(row.leads);
    item.orders += toNumber(row.orders);
    item.revenue += toNumber(row.revenue);
    item.impressions += toNumber(row.impressions);
    item.clicks += toNumber(row.clicks);
    item.sessions += toNumber(row.sessions);
  }

  const channels = Array.from(channelMap.values())
    .map((item) => ({
      ...item,
      roas: roundMetric(safeDivide(item.revenue, item.spend)),
      ctr: percent(safeDivide(item.clicks, item.impressions)),
      cvr: percent(safeDivide(item.orders, item.clicks)),
      cpl: roundMetric(safeDivide(item.spend, item.leads)),
      cac: roundMetric(safeDivide(item.spend, item.orders)),
      aov: roundMetric(safeDivide(item.revenue, item.orders))
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const totals = channels.reduce(
    (acc, item) => {
      acc.spend += item.spend;
      acc.leads += item.leads;
      acc.orders += item.orders;
      acc.revenue += item.revenue;
      acc.impressions += item.impressions;
      acc.clicks += item.clicks;
      acc.sessions += item.sessions;
      return acc;
    },
    {
      spend: 0,
      leads: 0,
      orders: 0,
      revenue: 0,
      impressions: 0,
      clicks: 0,
      sessions: 0
    }
  );

  totals.roas = roundMetric(safeDivide(totals.revenue, totals.spend));
  totals.ctr = percent(safeDivide(totals.clicks, totals.impressions));
  totals.cvr = percent(safeDivide(totals.orders, totals.clicks));
  totals.cpl = roundMetric(safeDivide(totals.spend, totals.leads));
  totals.cac = roundMetric(safeDivide(totals.spend, totals.orders));
  totals.aov = roundMetric(safeDivide(totals.revenue, totals.orders));

  const salesSummary = aggregatePeriodCore(db, period);
  const bestChannel = [...channels].sort((a, b) => b.roas - a.roas || b.revenue - a.revenue)[0] || null;
  const worstChannel = [...channels].sort((a, b) => a.roas - b.roas || b.spend - a.spend)[0] || null;

  return {
    period,
    totals,
    channels,
    bestChannel,
    worstChannel,
    salesShare: salesSummary.totals.fact > 0 ? percent(totals.revenue / salesSummary.totals.fact) : 0,
    generatedAt: new Date().toISOString()
  };
}

function buildMarketingAnalysis(db, period) {
  const marketing = aggregateMarketing(db, period);
  const sales = aggregateDashboard(db, period);
  const insights = [];
  const recommendations = [];
  const warnings = [];

  if (!marketing.channels.length) {
    return {
      period,
      generatedAt: new Date().toISOString(),
      summary: 'Нет маркетинговых данных за выбранный период.',
      insights: ['Загрузите данные по рекламным каналам через `/api/ingest/marketing`, чтобы получить анализ.'],
      recommendations: ['Начните с выгрузки spend, leads, orders, revenue, impressions и clicks по каналам.'],
      warnings: [],
      metrics: marketing,
      sales
    };
  }

  insights.push(`Маркетинг принес ${marketing.totals.revenue.toFixed(0)} ₽ выручки при расходах ${marketing.totals.spend.toFixed(0)} ₽. ROAS = ${marketing.totals.roas}.`);
  insights.push(`Доля маркетингово-атрибутированной выручки от общего факта продаж за ${period}: ${marketing.salesShare}%.`);

  if (marketing.bestChannel) {
    insights.push(`Лучший канал сейчас: ${marketing.bestChannel.channelName}. ROAS ${marketing.bestChannel.roas}, выручка ${marketing.bestChannel.revenue.toFixed(0)} ₽.`);
  }

  if (marketing.worstChannel) {
    warnings.push(`Слабое звено: ${marketing.worstChannel.channelName}. ROAS ${marketing.worstChannel.roas}, CAC ${marketing.worstChannel.cac.toFixed(0)} ₽.`);
  }

  if (sales.totals.completion < 85) {
    warnings.push(`План продаж выполнен только на ${sales.totals.completion}%. Нужно усиливать каналы, которые дают быстрые заказы.`);
  } else if (sales.totals.completion >= 100) {
    insights.push(`План продаж перевыполнен: ${sales.totals.completion}% от плана.`);
  }

  insights.push(`Прогноз на конец месяца: ${sales.forecast.projectedFact.toFixed(0)} ₽, это ${sales.forecast.projectedCompletion}% от плана.`);

  if (sales.forecast.remainingDays > 0) {
    warnings.push(`До конца периода осталось ${sales.forecast.remainingDays} дн. Для выхода в план нужно в среднем ${sales.forecast.requiredPerDayToPlan.toFixed(0)} ₽ в день.`);
  }

  if (sales.forecast.projectedCompletion < 100) {
    recommendations.push(`Нарастите среднедневную выручку минимум до ${sales.forecast.requiredPerDayToPlan.toFixed(0)} ₽, сейчас средний темп ${sales.forecast.averagePerDay.toFixed(0)} ₽ в день.`);
  }

  if (sales.comparison?.hasData) {
    insights.push(`К прошлому периоду ${sales.comparison.previousPeriod} факт продаж изменился на ${sales.comparison.factDelta >= 0 ? '+' : ''}${sales.comparison.factDelta.toFixed(0)} ₽.`);
  }

  if (marketing.totals.roas < 3) {
    recommendations.push('Сократите бюджет в каналах с низким ROAS и перераспределите его в каналы с уже доказанной окупаемостью.');
  } else {
    recommendations.push('Сохраняйте текущий уровень инвестиций в эффективные каналы и масштабируйте их постепенно на 10-15% в неделю.');
  }

  if (marketing.totals.ctr < 1.5) {
    recommendations.push('CTR низкий. Проверьте креативы, офферы и первые экраны объявлений: вероятно, проблема в сообщении или сегментации.');
  } else {
    insights.push(`CTR ${marketing.totals.ctr}% находится в рабочем диапазоне для базового performance-контроля.`);
  }

  if (marketing.totals.cvr < 2) {
    recommendations.push('Конверсия в заказ низкая. Проверьте посадочные страницы, скорость ответа менеджеров и наличие дефицита товара.');
  } else {
    insights.push(`Конверсия из клика в заказ составляет ${marketing.totals.cvr}%.`);
  }

  const overpricedChannels = marketing.channels.filter((item) => item.roas > 0 && item.roas < 2);
  if (overpricedChannels.length) {
    recommendations.push(`Отдельно пересмотрите ${overpricedChannels.map((item) => item.channelName).join(', ')}: там есть расход без достаточной окупаемости.`);
  }

  const highPotentialChannels = marketing.channels.filter((item) => item.roas >= marketing.totals.roas && item.orders >= 10);
  if (highPotentialChannels.length) {
    recommendations.push(`Кандидаты на масштабирование: ${highPotentialChannels.map((item) => item.channelName).join(', ')}.`);
  }

  return {
    period,
    generatedAt: new Date().toISOString(),
    summary: `Маркетинговый анализ за ${period}: ROAS ${marketing.totals.roas}, CPL ${marketing.totals.cpl.toFixed(0)} ₽, CAC ${marketing.totals.cac.toFixed(0)} ₽, выполнение плана продаж ${sales.totals.completion}%.`,
    insights,
    recommendations,
    warnings,
    metrics: marketing,
    sales
  };
}

function buildStoreProductMatrix(db, period) {
  const stores = db.stores;
  const products = db.products;
  const plans = db.plans.filter(r => r.period === period);
  const sales = db.sales.filter(r => r.period === period);

  const cells = {};
  for (const s of stores) {
    cells[s.id] = {};
    for (const p of products) {
      cells[s.id][p.id] = { plan: 0, fact: 0, cost: 0, quantity: 0 };
    }
  }

  for (const row of plans) {
    if (!cells[row.storeId]) cells[row.storeId] = {};
    if (!cells[row.storeId][row.productId]) {
      cells[row.storeId][row.productId] = { plan: 0, fact: 0, cost: 0, quantity: 0 };
    }
    cells[row.storeId][row.productId].plan += toNumber(row.amount);
  }

  for (const row of sales) {
    if (!cells[row.storeId]) cells[row.storeId] = {};
    if (!cells[row.storeId][row.productId]) {
      cells[row.storeId][row.productId] = { plan: 0, fact: 0, cost: 0, quantity: 0 };
    }
    cells[row.storeId][row.productId].fact += toNumber(row.amount);
    cells[row.storeId][row.productId].cost += toNumber(row.cost);
    cells[row.storeId][row.productId].quantity += toNumber(row.quantity);
  }

  for (const sid of Object.keys(cells)) {
    for (const pid of Object.keys(cells[sid])) {
      const c = cells[sid][pid];
      c.percent = c.plan > 0 ? percent(c.fact / c.plan) : null;
      c.margin = roundMetric(c.fact - c.cost);
    }
  }

  const storeTotals = {};
  for (const s of stores) {
    const sc = cells[s.id] || {};
    const tf = Object.values(sc).reduce((a, c) => a + c.fact, 0);
    const tp = Object.values(sc).reduce((a, c) => a + c.plan, 0);
    storeTotals[s.id] = {
      fact: roundMetric(tf),
      plan: roundMetric(tp),
      percent: tp > 0 ? percent(tf / tp) : 0
    };
  }

  const productTotals = {};
  for (const p of products) {
    let tf = 0, tp = 0;
    for (const sid of Object.keys(cells)) {
      const c = cells[sid][p.id];
      if (c) { tf += c.fact; tp += c.plan; }
    }
    productTotals[p.id] = {
      fact: roundMetric(tf),
      plan: roundMetric(tp),
      percent: tp > 0 ? percent(tf / tp) : 0
    };
  }

  const storesSorted = [...stores].sort(
    (a, b) => (storeTotals[b.id]?.fact || 0) - (storeTotals[a.id]?.fact || 0)
  );

  return {
    period,
    stores: storesSorted.map(s => ({ id: s.id, name: s.name, region: s.region || '' })),
    products: products.map(p => ({ id: p.id, name: p.name, category: p.category || '' })),
    cells,
    storeTotals,
    productTotals
  };
}

function buildProductForecast(db, period) {
  const summary = aggregatePeriodCore(db, period);
  const { elapsedDays, remainingDays, totalDays } = summary.forecast;
  return {
    period,
    elapsedDays,
    remainingDays,
    totalDays,
    products: summary.products.map(p => {
      const avgPerDay = elapsedDays > 0 ? p.fact / elapsedDays : 0;
      const projected = Math.round(avgPerDay * totalDays);
      const projPct = p.plan > 0 ? Math.round(projected / p.plan * 100) : 0;
      const reqPerDay = remainingDays > 0 ? Math.max(p.plan - p.fact, 0) / remainingDays : 0;
      return {
        productId: p.productId,
        productName: p.productName,
        category: p.category,
        fact: p.fact,
        plan: p.plan,
        percent: p.percent,
        margin: p.margin,
        marginPct: p.marginPct,
        quantity: p.quantity,
        projected,
        projPct,
        reqPerDay: Math.round(reqPerDay),
        gap: projected - p.plan,
        status: projPct >= 100 ? 'good' : projPct >= 90 ? 'warn' : 'bad'
      };
    })
  };
}

function listPeriods(db) {
  const values = new Set();
  for (const row of db.plans) values.add(row.period);
  for (const row of db.sales) values.add(row.period);
  for (const row of db.marketing) values.add(row.period);
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
      quantity: toNumber(item.quantity),
      soldAt: item.soldAt || new Date().toISOString()
    });
  }

  return period;
}

function replaceMarketing(db, body) {
  const period = monthKey(body.period);
  if (!Array.isArray(body.metrics)) {
    throw new Error('metrics must be an array');
  }

  db.marketing = db.marketing.filter((item) => item.period !== period);

  for (const item of body.metrics) {
    if (!item.channelId) {
      throw new Error('Each marketing row must include channelId');
    }
    db.marketing.push({
      period,
      channelId: String(item.channelId),
      channelName: item.channelName || String(item.channelId),
      spend: toNumber(item.spend),
      leads: toNumber(item.leads),
      orders: toNumber(item.orders),
      revenue: toNumber(item.revenue),
      impressions: toNumber(item.impressions),
      clicks: toNumber(item.clicks),
      sessions: toNumber(item.sessions)
    });
  }

  return period;
}

module.exports = {
  appendSales,
  aggregateDashboard,
  aggregateMarketing,
  buildMarketingAnalysis,
  buildProductForecast,
  buildStoreProductMatrix,
  listPeriods,
  monthKey,
  normalizeDb,
  replaceMarketing,
  replacePlans,
  storeDetails
};
