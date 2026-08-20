// Единый Campaign P&L: затраты периода → измеримый результат → валовая прибыль.
//
// Это управленческий отчёт, а не бухгалтерская проводка. Кассовые оплаты из 1С
// показываются отдельно и сверяются с затратами периода: предоплата договора в
// одном месяце не должна автоматически становиться стоимостью кампании этого месяца.

const marketingBudget = require('./marketing-budget');
const paidCosts = require('./paid-costs');
const smsAttribution = require('./sms-attribution');
const grossProfit = require('./gross-profit');
const sourcesHealth = require('./sources-health');

function round(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function pct(value) { return value == null || !isFinite(value) ? null : Math.round(value * 10) / 10; }

function withEconomics(row, grossMarginRate) {
  const cost = round(row.cost);
  const revenue = row.revenue == null ? null : round(row.revenue);
  const orders = row.orders == null ? null : Number(row.orders);
  const estimatedGrossProfit = revenue == null || grossMarginRate == null
    ? null
    : round(revenue * grossMarginRate);
  return Object.assign({}, row, {
    cost,
    revenue,
    orders,
    cac: orders > 0 ? round(cost / orders) : null,
    avgCheck: orders > 0 && revenue != null ? round(revenue / orders) : null,
    estimatedGrossProfit,
    romiPct: cost > 0 && estimatedGrossProfit != null
      ? pct((estimatedGrossProfit - cost) / cost * 100)
      : null
  });
}

function smsRevenueBasis(campaign) {
  // Для офферов с базовым периодом используем только прирост сверх обычной
  // покупки этих же клиентов. Если baseline не посчитан, оставляем выручку окна,
  // но понижаем уверенность и явно подписываем метод.
  if (campaign.type === 'A' || campaign.type === 'A*') {
    if (campaign.incRevenue != null) {
      return {
        revenue: Number(campaign.incRevenue) || 0,
        orders: Number(campaign.incremental) || 0,
        attribution: 'estimated',
        method: 'прирост к обычному уровню тех же получателей'
      };
    }
  }
  if (campaign.revenue != null && !campaign.isClicks) {
    return {
      revenue: Number(campaign.revenue) || 0,
      orders: Number(campaign.buyers) || 0,
      attribution: 'weak',
      method: 'покупки в окне оффера; прирост не отделён'
    };
  }
  return {
    revenue: null,
    orders: null,
    attribution: campaign.buyers != null ? 'traffic-only' : 'missing',
    method: campaign.isClicks ? 'переходы по ссылке' : 'нет измеримого результата'
  };
}

function buildCampaignPerformance({ period, revenue, budget, channelCosts, sms, gross, health }) {
  const cogs = gross && gross.cogsByMonth && gross.cogsByMonth[period];
  const rawMarginRate = revenue > 0 && cogs > 0 ? (revenue - cogs) / revenue : null;
  const grossMarginRate = rawMarginRate != null && rawMarginRate >= 0.5 && rawMarginRate <= 0.9
    ? rawMarginRate
    : null;
  const channels = channelCosts && channelCosts.channels || [];
  const byKey = Object.fromEntries(channels.map((row) => [row.key, row]));
  const rows = [];

  const direct = byKey.context;
  if (direct) {
    rows.push(withEconomics({
      id: `direct:${period}`,
      channel: 'Яндекс.Директ',
      campaign: 'Все ecommerce-кампании месяца',
      date: period,
      cost: direct.cost,
      costSource: direct.costSource,
      costNote: direct.costNote,
      orders: direct.orders,
      revenue: direct.revenue,
      actions: direct.actions,
      actionLabel: 'кликов',
      attribution: direct.attribution,
      method: 'ecommerce-покупки по источнику Яндекс.Директ',
      sourcePeriod: direct.sourcePeriod,
      periodAligned: direct.periodAligned
    }, grossMarginRate));
  }

  const gis = byKey.gis;
  if (gis) {
    rows.push(withEconomics({
      id: `2gis:${period}`,
      channel: '2ГИС',
      campaign: 'UTM 2ГИС · онлайн-заказы',
      date: period,
      cost: gis.cost,
      costSource: gis.costSource,
      costNote: gis.costNote,
      orders: gis.orders,
      revenue: gis.revenue,
      actions: gis.actions,
      actionLabel: 'показов',
      attribution: gis.attribution,
      method: 'ecommerce-покупки по UTM 2ГИС; офлайн не входит',
      sourcePeriod: gis.sourcePeriod,
      periodAligned: gis.periodAligned
    }, grossMarginRate));
  }

  for (const [index, campaign] of ((sms && sms.campaigns) || []).entries()) {
    const basis = smsRevenueBasis(campaign);
    rows.push(withEconomics({
      id: `sms:${period}:${index + 1}`,
      channel: 'SMS',
      campaign: campaign.text || campaign.theme || `Кампания ${index + 1}`,
      date: campaign.firstDate || period,
      cost: campaign.cost,
      costSource: campaign.recipientsApprox ? 'estimated' : 'calculated',
      costNote: `${campaign.recipients || 0} уник. получателей × ${sms.smsPrice || 0} ₽`,
      orders: basis.orders,
      revenue: basis.revenue,
      actions: campaign.isClicks ? campaign.buyers : campaign.recipients,
      actionLabel: campaign.isClicks ? 'переходов' : 'получателей',
      attribution: basis.attribution,
      method: basis.method,
      sourcePeriod: period,
      periodAligned: true,
      product: campaign.product || null,
      metric: campaign.metric || null,
      error: campaign.error || null
    }, grossMarginRate));
  }

  // Каналы, где стоимость периода известна, но покупка пока не связана с
  // источником. Они остаются в P&L с пустыми CAC/ROMI — отсутствие атрибуции
  // нельзя маскировать нулевой выручкой.
  for (const key of ['seo', 'yabusiness', 'vk']) {
    const channel = byKey[key];
    if (!channel) continue;
    rows.push(withEconomics({
      id: `${key}:${period}`,
      channel: channel.name,
      campaign: 'Все активности месяца',
      date: period,
      cost: channel.cost,
      costSource: channel.costSource,
      costNote: channel.costNote,
      orders: null,
      revenue: null,
      actions: channel.actions,
      actionLabel: key === 'seo' ? 'визитов' : null,
      attribution: channel.attribution,
      method: channel.result,
      sourcePeriod: channel.sourcePeriod,
      periodAligned: channel.periodAligned
    }, grossMarginRate));
  }

  const sum = (list, field) => round(list.reduce((total, row) => total + (Number(row[field]) || 0), 0));
  const attributedRows = rows.filter((row) => row.revenue != null);
  const periodCost = sum(rows, 'cost');
  const attributedCost = sum(attributedRows, 'cost');
  const reportedRevenue = sum(attributedRows, 'revenue');
  const estimatedGrossProfit = grossMarginRate == null ? null : sum(attributedRows, 'estimatedGrossProfit');
  const actualCashPaid = budget && budget.paid && budget.paid.available ? round(budget.paid.total) : null;
  const cashGap = actualCashPaid == null ? null : round(actualCashPaid - periodCost);
  const sourceProblems = (health && health.sources || []).filter((source) => source.status !== 'ok');

  const issues = [];
  if (grossMarginRate == null) issues.push({ level: 'error', code: 'gross-margin-missing', text: 'Себестоимость месяца не закрыта: валовая прибыль и ROMI пока не рассчитываются.' });
  if (actualCashPaid != null && Math.abs(cashGap) >= Math.max(10000, actualCashPaid * 0.1)) {
    issues.push({
      level: 'warn', code: 'cash-period-gap',
      text: `Кассовые оплаты отличаются от затрат периода на ${Math.round(Math.abs(cashGap)).toLocaleString('ru-RU')} ₽. Причины: предоплаты, оплаты прошлых месяцев и неразмеченные услуги.`
    });
  }
  if (budget && budget.paid && budget.paid.deduplicatedAmount > 0) {
    issues.push({
      level: 'info', code: 'cash-deduplicated',
      text: `Убрано подтверждённое задвоение РКО/авансового отчёта: ${Math.round(budget.paid.deduplicatedAmount).toLocaleString('ru-RU')} ₽.`
    });
  }
  for (const warning of (budget && budget.plan && budget.plan.warnings || [])) {
    issues.push({ level: 'warn', code: 'plan-warning', text: warning });
  }
  if (sourceProblems.length) {
    issues.push({
      level: sourceProblems.some((source) => source.status === 'dead') ? 'error' : 'warn',
      code: 'stale-sources',
      text: `Источники требуют внимания: ${sourceProblems.slice(0, 6).map((source) => `${source.name} (${source.ageText})`).join(', ')}.`
    });
  }
  issues.push({
    level: 'info', code: 'revenue-overlap',
    text: 'Выручка каналов показана без межканальной дедупликации: один заказ может встретиться в SMS и в last-click источнике. Итог — диагностический, не бухгалтерский.'
  });

  const tracking = [
    { key: 'direct-ecommerce', name: 'Директ → ecommerce-заказ', status: direct && direct.revenue != null ? 'ready' : 'missing' },
    { key: '2gis-ecommerce', name: '2ГИС → ecommerce-заказ', status: gis && gis.revenue != null ? 'ready' : 'missing' },
    { key: 'sms-loyalty', name: 'SMS → покупка по карте', status: sms && sms.campaigns && sms.campaigns.length ? 'ready' : 'missing' },
    { key: 'offline', name: 'Офлайн → чек по QR/промокоду', status: 'missing' },
    { key: 'calls', name: 'Звонок → заказ (call-tracking)', status: 'missing' },
    { key: 'social', name: 'VK/блогер → заказ по UTM/промокоду', status: 'missing' },
    { key: 'invoice-map', name: 'Счёт/платёж → кампания и месяц услуги', status: 'missing' }
  ];

  return {
    period,
    rows,
    summary: {
      actualCashPaid,
      plan: budget && budget.totals ? round(budget.totals.plan) : null,
      approved: budget && budget.totals ? round(budget.totals.approved) : null,
      periodCost,
      cashGap,
      attributedCost,
      attributedCostPct: periodCost > 0 ? pct(attributedCost / periodCost * 100) : null,
      reportedRevenue,
      estimatedGrossProfit,
      romiPct: attributedCost > 0 && estimatedGrossProfit != null
        ? pct((estimatedGrossProfit - attributedCost) / attributedCost * 100)
        : null,
      grossMarginPct: grossMarginRate == null ? null : pct(grossMarginRate * 100),
      campaigns: rows.length,
      campaignsWithRevenue: attributedRows.length,
      nonDeduplicatedRevenue: true
    },
    issues,
    tracking,
    notes: {
      cash: 'Оплачено — движения денег в 1С. Затраты периода — стоимость активности выбранного месяца; эти базы могут расходиться из-за предоплат и закрывающих документов.',
      grossProfit: 'Валовая прибыль кампании — оценка: атрибутированная выручка × фактическая валовая маржа месяца.',
      romi: 'ROMI = (оценочная валовая прибыль − стоимость кампании) / стоимость кампании. ФОТ и общехозяйственные затраты сюда не распределяются.',
      attribution: 'CAC и ROMI считаются только там, где есть связь покупки с каналом. Пустое значение означает отсутствие данных, а не нулевой результат.'
    },
    refreshedAt: new Date().toISOString()
  };
}

async function getCampaignPerformance(period, revenue) {
  const [budget, channelCosts, sms, gross] = await Promise.all([
    marketingBudget.getMarketingBudget(period),
    paidCosts.getPaidCosts(period),
    smsAttribution.getSmsAttribution(period).catch((error) => ({ error: error.message, campaigns: [] })),
    grossProfit.getGrossProfitCogs(period)
  ]);
  return buildCampaignPerformance({
    period,
    revenue: Number(revenue) || 0,
    budget,
    channelCosts,
    sms,
    gross,
    health: sourcesHealth.getSourcesHealth()
  });
}

module.exports = { getCampaignPerformance, buildCampaignPerformance, smsRevenueBasis };
