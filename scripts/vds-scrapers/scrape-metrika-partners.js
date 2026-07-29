// Скрейп переходов по партнёрам из Метрики 43949414 (цель partner_click).
// Сниппет на сайте шлёт {partner: <hostname ссылки>} → значение лежит в ym:s:paramsLevel2.
// Группируем по paramsLevel2, метрики visits+goalReaches, период last_month (rolling 30д,
// включает свежие клики), полный набор URL-параметров + waitForFunction (как рабочий
// scrape-metrika.js, иначе SPA-грид не рендерится). Матч с partners.json по ДОМЕНУ
// (hostname из targetUrl). READ-MODIFY-WRITE: базу партнёров (Bitrix) не трогаем.
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const OUT = '/opt/marketing-data/partner-clicks.json';
const PARTNERS = '/opt/marketing-data/partners.json';
const COUNTER = '43949414';

function hostOf(u) {
  try { return new URL(String(u).trim().replace(/&amp;/g, '&')).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_) { return null; }
}

(async () => {
  const out = { scrapedAt: new Date().toISOString(), counter: COUNTER, source: 'metrika-goals', goal: 'partner_click' };
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ storageState: '/opt/2gis-scraper/yandex-state.json', locale: 'ru-RU', viewport: { width: 1600, height: 2000 } });
  const p = await ctx.newPage();

  // Prewarm SSO (без этого первый /stat/new часто не рендерит грид)
  try {
    await p.goto('https://metrika.yandex.ru/list', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p.waitForTimeout(4000);
  } catch (e) { out.prewarmError = e.message; }
  if (/passport\.yandex/.test(p.url())) { out.sessionExpired = true; fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(JSON.stringify({ ok: false, sessionExpired: true })); await b.close(); return; }

  // Полный набор параметров (как scrape-metrika.js) + dim=paramsLevel2 + goalReaches + фильтр цели.
  const URL = 'https://metrika.yandex.ru/stat/new?id=' + COUNTER +
    '&period=month&group=day' +
    '&selectedDimensionKeys=' + encodeURIComponent('[["ym:s:paramsLevel2"]]') +
    '&tableMetrics=' + encodeURIComponent('[["ym:s:visits"],["ym:s:goalReaches"]]') +
    '&filters=' + encodeURIComponent('["ym:s:goalDimension==\\"partner_click\\""]') +
    '&view=Linear&chartView=Line&table=visits' +
    '&attr=%7B%22attributionId%22%3A%22LastSign%22%2C%22isCrossDevice%22%3Atrue%7D' +
    '&sortBy=-ym%3As%3Avisits&showTotal=true' +
    '&isMinSamplingEnabled=false&currency=RUB&isUndefinedEnabled=false' +
    '&chartMetrics=%5B%5B%22ym%3As%3Avisits%22%5D%5D&metricValueMode=Absolute&screenMode=Default';

  // Множество доменов партнёров — чтобы из отчёта брать ТОЛЬКО их (отсечь шапку сайта/счётчик).
  const partnerDomains = new Set();
  let partnersDoc = null;
  try {
    partnersDoc = JSON.parse(fs.readFileSync(PARTNERS, 'utf8'));
    for (const pr of partnersDoc.partners) {
      const d = hostOf(pr.targetUrl || (pr.props && Object.values(pr.props).find(v => /^\s*https?:\/\//.test(v))) || '');
      if (d) partnerDomains.add(d);
    }
  } catch (e) { out.partnersReadError = e.message; }

  try { await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { out.error = 'goto: ' + e.message; }
  // Ждём грид ЛИБО «нет данных»
  try {
    await p.waitForFunction(() => {
      const t = (document.body && document.body.innerText) || '';
      if (/Нет данных|Данные не найдены|Недостаточно данных/i.test(t)) return true;
      return /Итого и средние/i.test(t) && t.length > 500;
    }, { timeout: 55000 });
  } catch (_) { out.gridTimeout = true; }
  for (let i = 0; i < 6; i++) { await p.evaluate(() => window.scrollBy(0, 600)).catch(() => {}); await p.waitForTimeout(400); }
  await p.waitForTimeout(2000);

  const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
  out.bodyLen = body.length;
  out.periodShown = (body.match(/\d{1,2}\s+\S+\s+—\s+\d{1,2}\s+\S+/) || [null])[0];
  const noData = /Нет данных|Данные не найдены|Недостаточно данных/i.test(body);
  out.noData = noData;

  // Парсим: после «Итого и средние» идёт TOTAL, «100,00 %», затем триплеты value, count, «XX,XX %».
  // Значения — домены (hostname). Берём пары: <домен-подобная строка> + следующее целое.
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean);
  const byDomain = {};
  const domainRe = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;
  for (let i = 0; i < lines.length; i++) {
    const dom = lines[i].toLowerCase().replace(/^www\./, '');
    // Берём только домены, реально присутствующие среди партнёров — отсекает шапку
    // (www.maria-irk.ru) и номер счётчика, который иначе ловится как «количество».
    if (domainRe.test(lines[i]) && partnerDomains.has(dom)) {
      const n = parseInt((lines[i + 1] || '').replace(/[\s ]/g, ''), 10);
      if (isFinite(n) && n >= 0 && n < 1e6) byDomain[dom] = Math.max(byDomain[dom] || 0, n);
    }
  }
  out.byDomain = byDomain;
  out.partnerDomainsKnown = partnerDomains.size;
  // Итого по цели
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^Итого и средние$/i.test(lines[i])) { const t = parseInt((lines[i + 1] || '').replace(/[\s ]/g, ''), 10); if (isFinite(t)) total = t; break; }
  }
  out.totalClicks = noData ? 0 : (total || Object.values(byDomain).reduce((a, c) => a + c, 0));

  // Мердж в partners.json по домену (READ-MODIFY-WRITE; базу Bitrix сохраняем).
  let merged = 0;
  try {
    const partners = partnersDoc || JSON.parse(fs.readFileSync(PARTNERS, 'utf8'));
    for (const pr of partners.partners) {
      const dom = hostOf(pr.targetUrl || (pr.props && Object.values(pr.props).find(v => /^\s*https?:\/\//.test(v))) || '');
      pr.domain = dom;
      pr.metrikaClicks = dom && byDomain[dom] != null ? byDomain[dom] : 0;
      if (pr.metrikaClicks > 0) merged++;
    }
    partners.metrikaClicksUpdatedAt = out.scrapedAt;
    partners.metrikaClicksPeriod = out.periodShown || 'last 30d';
    fs.writeFileSync(PARTNERS, JSON.stringify(partners, null, 2));
    out.mergedPartners = merged;
    out.matchedTotal = Object.keys(byDomain).length;
  } catch (e) { out.mergeError = e.message; }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: !out.gridTimeout || noData, totalClicks: out.totalClicks, byDomain, merged, periodShown: out.periodShown, bodyLen: out.bodyLen, gridTimeout: !!out.gridTimeout }, null, 2));
  await b.close();
})().catch(e => { console.log('ERR', e.message); });
