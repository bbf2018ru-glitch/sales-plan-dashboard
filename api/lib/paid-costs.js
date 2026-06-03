// Затраты на платные каналы маркетинга + отдача (стоимость результата).
// Цифры затрат — от Маши (2026-06-03), настраиваемые через env (дефолты — реальные):
//   MKT_SMS_PRICE (₽/SMS), MKT_GIS_MONTHLY, MKT_DIRECT_AGENCY, MKT_SEO_MONTHLY,
//   MKT_YABUSINESS_MONTHLY, MKT_VK_MONTHLY.
// Источники результата: Директ-расход/конверсии — direct.json (live-снимок месяца);
// SMS отправлено — /query (фактич. кол-во рассылок «Реклама» × цена); SEO-визиты —
// metrika.json; показы 2ГИС — 2gis.json. Фикс-платы (2ГИС/SEO/Я.Бизнес/ВК) — месячные.

const fs = require('fs');
const upp = require('./upp-client');

const EXT_DIR = process.env.MARKETING_DATA_DIR || '/opt/marketing-data';
const cache = upp.makeCache(6 * 60 * 60 * 1000);

function readExt(file) {
  try { return JSON.parse(fs.readFileSync(EXT_DIR + '/' + file, 'utf8')); } catch (_) { return null; }
}
function num(v, def) { const n = parseFloat(v); return isFinite(n) ? n : def; }

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

function bounds(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { y, m, ny: next[0], nm: next[1] };
}

// Кол-во отправленных маркетинговых SMS («Реклама») за месяц (1 строка Получатели = 1 SMS).
async function smsSentMarketing(period) {
  const b = bounds(period);
  const q = 'ВЫБРАТЬ П.Ссылка.Тема КАК Тема, КОЛИЧЕСТВО(*) КАК Строк'
    + ' ИЗ Документ.SMSСообщение.Получатели КАК П'
    + ` ГДЕ П.Ссылка.Дата >= ДАТАВРЕМЯ(${b.y},${b.m},1) И П.Ссылка.Дата < ДАТАВРЕМЯ(${b.ny},${b.nm},1)`
    + ' СГРУППИРОВАТЬ ПО П.Ссылка.Тема';
  try {
    const r = await upp.callQuery(q, { timeoutMs: 40000 });
    const rows = (r && r.rows) || [];
    const mkt = rows.filter((x) => /реклам|акци|подар|бонус|промо|рассылк/i.test(x.Тема || ''));
    const all = rows.reduce((s, x) => s + upp.parseRu(x.Строк), 0);
    return { marketing: mkt.reduce((s, x) => s + upp.parseRu(x.Строк), 0), all };
  } catch (_) { return { marketing: 0, all: 0, error: true }; }
}

async function compute(period) {
  const c = costs();
  const direct = readExt('direct.json');
  const metrika = readExt('metrika.json');
  const gis = readExt('2gis.json');
  const sms = await smsSentMarketing(period);

  const directSpend = (direct && direct.totals && direct.totals.spend) || 0;
  const directConv = (direct && direct.totals && direct.totals.conversions) || 0;
  const directClicks = (direct && direct.totals && direct.totals.clicks) || 0;
  const seoSrc = (metrika && metrika.sources || []).find((s) => /поиск|seo/i.test(s.name));
  const seoVisits = (seoSrc && seoSrc.visits) || 0;
  const gisImpr = (gis && gis.appearance && gis.appearance.impressions) || 0;

  const smsCost = Math.round(sms.marketing * c.smsPrice);
  const contextCost = Math.round(directSpend + c.directAgency);

  const ch = [];
  ch.push({
    key: 'context', name: 'Контекст (Я.Директ)', cost: contextCost,
    costNote: 'расход ' + Math.round(directSpend) + ' ₽ + агентство ' + c.directAgency + ' ₽',
    result: directConv ? directConv + ' конверсий · ' + directClicks + ' кликов' : (directClicks + ' кликов'),
    cpr: directConv ? 'CPA ' + Math.round(contextCost / directConv) + ' ₽' : null,
    live: true
  });
  ch.push({
    key: 'sms', name: 'SMS-рассылки (Реклама)', cost: smsCost,
    costNote: sms.marketing + ' отправлено × ' + c.smsPrice + ' ₽' + (sms.error ? ' (оценка)' : ''),
    result: sms.marketing + ' SMS', cpr: null, live: true
  });
  ch.push({
    key: 'gis', name: '2ГИС — приоритет в выдаче', cost: c.gisMonthly,
    costNote: 'месячная плата', result: gisImpr ? gisImpr + ' показов/мес' : 'н/д',
    cpr: gisImpr ? Math.round(c.gisMonthly / gisImpr * 1000) + ' ₽ / 1000 показов' : null, live: !!gisImpr
  });
  ch.push({
    key: 'seo', name: 'SEO (продвижение сайта)', cost: c.seoMonthly,
    costNote: 'месячная плата подрядчику', result: seoVisits ? seoVisits + ' визитов/мес' : 'н/д',
    cpr: seoVisits ? Math.round(c.seoMonthly / seoVisits) + ' ₽ / визит' : null, live: !!seoVisits
  });
  ch.push({
    key: 'yabusiness', name: 'Яндекс.Бизнес (приоритет)', cost: c.yaBusinessMonthly,
    costNote: 'месячная плата', result: 'отдельной метрики нет', cpr: null, live: false
  });
  ch.push({
    key: 'vk', name: 'ВК таргет (ведение)', cost: c.vkTargetMonthly,
    costNote: 'месячная плата агентству', result: 'отдельной метрики нет', cpr: null, live: false
  });

  const totalMonthly = ch.reduce((s, x) => s + (x.cost || 0), 0);

  return {
    period, costs: c, channels: ch,
    totalMonthly,
    directScrapedAt: direct && direct.scrapedAt || null,
    note: 'Фикс-платы (2ГИС / SEO / Я.Бизнес / ВК) — месячные. Расход Директа — live-снимок текущего месяца из кабинета. SMS — фактич. отправки «Реклама» × ' + c.smsPrice + ' ₽. Я.Бизнес и ВК — без отдельной live-метрики результата.',
    refreshedAt: new Date().toISOString()
  };
}

function getPaidCosts(period) {
  const p = period || upp.nowYM();
  return cache.wrap('paidcosts:' + p, () => compute(p));
}

module.exports = { getPaidCosts };
