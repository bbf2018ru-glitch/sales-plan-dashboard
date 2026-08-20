// Затраты платных каналов за ВЫБРАННЫЙ месяц + измеримый результат.
//
// Важное правило: исторический месяц никогда не подменяется текущим live-снимком.
// Расход Директа берётся из direct-history.json, покупки Директа и 2ГИС — из
// direct-ecommerce-history.json, показатели 2ГИС — из 2gis-history.json.
// Фиксированные месячные договоры явно помечены как оценки.

const fs = require('fs');
const upp = require('./upp-client');
const smsAttribution = require('./sms-attribution');

const EXT_DIR = process.env.MARKETING_DATA_DIR || '/opt/marketing-data';
const cache = upp.makeCache(6 * 60 * 60 * 1000, 'paid-costs');

function readExt(file) {
  try { return JSON.parse(fs.readFileSync(EXT_DIR + '/' + file, 'utf8')); } catch (_) { return null; }
}
function num(v, def) { const n = parseFloat(v); return isFinite(n) ? n : def; }
function money(v) { return Math.round((Number(v) || 0) * 100) / 100; }

function costs() {
  return {
    smsPrice: num(process.env.MKT_SMS_PRICE, 8.5),
    gisMonthly: num(process.env.MKT_GIS_MONTHLY, 100000),
    directAgency: num(process.env.MKT_DIRECT_AGENCY, 60000),
    seoMonthly: num(process.env.MKT_SEO_MONTHLY, 46000),
    yaBusinessMonthly: num(process.env.MKT_YABUSINESS_MONTHLY, 26200),
    vkTargetMonthly: num(process.env.MKT_VK_MONTHLY, 10500)
  };
}

function rowsOf(data, key) {
  if (Array.isArray(data)) return data;
  return data && Array.isArray(data[key]) ? data[key] : [];
}
function monthRow(data, key, period) {
  return rowsOf(data, key).find((row) => row && row.ym === period) || null;
}
function ecommerceRows(data) {
  return Array.isArray(data) ? data : rowsOf(data, 'months');
}

async function compute(period) {
  const c = costs();
  const directHistory = readExt('direct-history.json');
  const ecommerceHistory = readExt('direct-ecommerce-history.json');
  const gisHistory = readExt('2gis-history.json');
  const metrikaHistory = readExt('metrika-history.json');

  const direct = monthRow(directHistory, 'months', period);
  const ecommerce = ecommerceRows(ecommerceHistory).find((row) => row && row.ym === period) || null;
  const gis = monthRow(gisHistory, 'series', period);
  const metrika = monthRow(metrikaHistory, 'months', period);
  const directEcom = ecommerce && (ecommerce.direct || ecommerce);
  const gisEcom = ecommerce && ecommerce.utm2gis;

  // SMS-затраты — уникальные получатели кампаний × договорная цена. Повторные
  // отправки не увеличивают чистую стоимость в управленческом отчёте.
  let sms = null;
  try { sms = await smsAttribution.getSmsAttribution(period); } catch (_) {}
  const st = sms && sms.totals || {};
  const smsReach = Number(st.recipients) || 0;
  const smsCost = st.cost == null ? money(smsReach * c.smsPrice) : money(st.cost);

  const directSpend = money(direct && direct.spend);
  const directClicks = Number(direct && direct.clicks) || 0;
  const directOrders = Number(directEcom && directEcom.purchases) || 0;
  const directRevenue = money(directEcom && directEcom.purchaseRevenue);
  const contextCost = money(directSpend + c.directAgency);
  const gisImpressions = Number(gis && gis.impressions) || 0;
  const gisOrders = Number(gisEcom && gisEcom.purchases) || 0;
  const gisRevenue = money(gisEcom && gisEcom.purchaseRevenue);
  const seoSource = metrika && Array.isArray(metrika.sources)
    ? metrika.sources.find((row) => /поиск|seo/i.test(row.name || ''))
    : null;
  const seoVisits = Number(seoSource && seoSource.visits) || 0;

  const channels = [
    {
      key: 'context', name: 'Контекст (Я.Директ)', cost: contextCost,
      costSource: 'mixed', costBasis: 'period', sourcePeriod: direct && direct.ym || null,
      periodAligned: !!direct,
      costNote: direct
        ? `расход кабинета за ${period}: ${Math.round(directSpend)} ₽ + норматив агентства ${c.directAgency} ₽`
        : `нет расхода кабинета за ${period}; включён только норматив агентства ${c.directAgency} ₽`,
      result: directEcom
        ? `${directOrders} ecommerce-покупок · ${Math.round(directRevenue)} ₽ выручки · ${directClicks} кликов`
        : (directClicks ? `${directClicks} кликов · покупки н/д` : 'нет помесячных данных'),
      orders: directEcom ? directOrders : null,
      revenue: directEcom ? directRevenue : null,
      actions: directClicks || null,
      cpr: directOrders ? `CAC с агентством ${Math.round(contextCost / directOrders)} ₽` : null,
      attribution: directEcom ? 'measured' : 'missing',
      live: !!directEcom
    },
    {
      key: 'sms', name: 'SMS-рассылки (Реклама)', cost: smsCost,
      costSource: 'estimated', costBasis: 'period', sourcePeriod: period,
      periodAligned: !!sms,
      costNote: `${smsReach} уник. получателей × ${st.smsPrice || c.smsPrice} ₽`,
      result: sms
        ? `${Number(st.incremental) || 0} приростных покупателей · ${Math.round(Number(st.incRevenue) || 0)} ₽ приростной выручки`
        : 'атрибуция SMS недоступна',
      orders: sms ? (Number(st.incremental) || 0) : null,
      revenue: sms ? money(st.incRevenue) : null,
      actions: smsReach || null,
      cpr: st.incremental ? `CAC по приросту ${Math.round(smsCost / st.incremental)} ₽` : null,
      attribution: sms ? 'estimated' : 'missing',
      live: !!sms
    },
    {
      key: 'gis', name: '2ГИС — приоритет в выдаче', cost: money(c.gisMonthly),
      costSource: 'estimated', costBasis: 'period', sourcePeriod: gis && gis.ym || null,
      periodAligned: !!gis,
      costNote: `норматив месячной платы ${c.gisMonthly} ₽; кассовая оплата договора сверяется отдельно`,
      result: gisEcom
        ? `${gisOrders} ecommerce-покупок по UTM · ${Math.round(gisRevenue)} ₽ выручки · ${gisImpressions} показов`
        : (gisImpressions ? `${gisImpressions} показов · покупки по UTM н/д` : 'нет помесячных данных'),
      orders: gisEcom ? gisOrders : null,
      revenue: gisEcom ? gisRevenue : null,
      actions: gisImpressions || null,
      cpr: gisOrders ? `CAC ${Math.round(c.gisMonthly / gisOrders)} ₽` : null,
      attribution: gisEcom ? 'measured' : 'missing',
      live: !!gisEcom
    },
    {
      key: 'seo', name: 'SEO (продвижение сайта)', cost: money(c.seoMonthly),
      costSource: 'estimated', costBasis: 'period', sourcePeriod: metrika && metrika.ym || null,
      periodAligned: !!seoSource,
      costNote: 'норматив месячной платы подрядчику',
      result: seoVisits ? `${seoVisits} визитов из поиска` : `визиты за ${period} не выгружены`,
      orders: null, revenue: null, actions: seoVisits || null,
      cpr: seoVisits ? `${Math.round(c.seoMonthly / seoVisits)} ₽ / визит` : null,
      attribution: seoVisits ? 'traffic-only' : 'missing', live: !!seoVisits
    },
    {
      key: 'yabusiness', name: 'Яндекс.Бизнес (приоритет)', cost: money(c.yaBusinessMonthly),
      costSource: 'estimated', costBasis: 'period', sourcePeriod: period, periodAligned: true,
      costNote: 'норматив месячной платы', result: 'отдельной метрики и UTM нет',
      orders: null, revenue: null, actions: null, cpr: null, attribution: 'missing', live: false
    },
    {
      key: 'vk', name: 'ВК таргет (ведение)', cost: money(c.vkTargetMonthly),
      costSource: 'estimated', costBasis: 'period', sourcePeriod: period, periodAligned: true,
      costNote: 'норматив месячной платы агентству', result: 'покупки с UTM не выгружены',
      orders: null, revenue: null, actions: null, cpr: null, attribution: 'missing', live: false
    }
  ];

  const issues = [];
  if (!direct) issues.push(`Нет истории расхода Директа за ${period}.`);
  if (!directEcom) issues.push(`Нет ecommerce-атрибуции Директа за ${period}.`);
  if (!gis) issues.push(`Нет помесячной статистики 2ГИС за ${period}.`);
  if (!gisEcom) issues.push(`Нет ecommerce-покупок 2ГИС по UTM за ${period}.`);
  if (!seoSource) issues.push(`Метрика не содержит корректной помесячной SEO-выгрузки за ${period}.`);

  return {
    period,
    costs: c,
    channels,
    totalMonthly: money(channels.reduce((sum, row) => sum + (row.cost || 0), 0)),
    dataQuality: { periodAligned: channels.every((row) => row.periodAligned), issues },
    directHistoryScrapedAt: directHistory && directHistory.scrapedAt || null,
    ecommerceScrapedAt: ecommerce && ecommerce.scrapedAt || null,
    gisHistoryScrapedAt: gisHistory && gisHistory.scrapedAt || null,
    note: `Все результаты относятся к ${period}. Текущие live-снимки другого месяца не подставляются. Директ: расход кабинета + норматив агентства; SMS: уникальные получатели × цена; 2ГИС, SEO, Я.Бизнес и ВК: нормативы месяца.`,
    refreshedAt: new Date().toISOString()
  };
}

function getPaidCosts(period) {
  const p = period || upp.nowYM();
  return cache.wrap('paidcosts3:' + p, () => compute(p));
}

module.exports = { getPaidCosts };
