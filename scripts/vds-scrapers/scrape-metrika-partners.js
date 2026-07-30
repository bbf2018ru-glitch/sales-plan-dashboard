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
  // ВАЖНО (2026-07-29): page.waitForFunction на тяжёлом SPA Метрики стабильно
  // таймаутит (rAF-поллинг голодает на занятом main thread), при этом обычный
  // evaluate-поллинг видит те же строки за ~13с. Поэтому ждём ВРУЧНУЮ.
  const pollBody = async (checkFn, timeoutMs, stepMs = 1500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const t = await p.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
      if (checkFn(t)) return true;
      await p.waitForTimeout(stepMs);
    }
    return false;
  };
  const gridReady = await pollBody(t =>
    /Нет данных|Данные не найдены|Недостаточно данных/i.test(t) || /Итого и средние/i.test(t), 90000);
  if (!gridReady) out.gridTimeout = true;
  for (let i = 0; i < 6; i++) { await p.evaluate(() => window.scrollBy(0, 600)).catch(() => {}); await p.waitForTimeout(400); }
  await p.waitForTimeout(2000);

  const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
  out.bodyLen = body.length;
  out.periodShown = (body.match(/\d{1,2}\s+\S+\s+—\s+\d{1,2}\s+\S+/) || [null])[0];
  const noData = /Нет данных|Данные не найдены|Недостаточно данных/i.test(body);
  out.noData = noData;

  // ФИКС 2026-07-29: URL-фильтр по цели SPA молча выбрасывает («Цель: Не выбрана»),
  // отчёт показывает ВСЕ paramsLevel2 (SMS-коды и пр.), а виртуализация грида прячет
  // домены с малым числом кликов ниже фолда. Поэтому: каждый партнёрский домен ищем
  // ТОЧЕЧНО через поле «Найти по названию» — грид фильтруется, строка домена всегда
  // видима. Значение = визиты с параметром partner=<домен> (шлёт только сниппет клика).
  const byDomain = {};
  if (!noData) {
    // «Найти по названию» — КНОПКА (span.button__text); поле ввода появляется после клика.
    const openBtn = p.locator('span.button__text', { hasText: 'Найти по названию' }).first();
    if (await openBtn.count().catch(() => 0)) { await openBtn.click({ force: true }).catch(() => {}); await p.waitForTimeout(1200); }
    const search = p.locator('input.text-input__control:visible, input[type="text"]:visible, input[type="search"]:visible').first();
    const searchOk = await search.count().catch(() => 0);
    if (!searchOk) out.searchBoxMissing = true;
    const readDomainRow = async (dom) => {
      const ls = ((await p.evaluate(() => document.body.innerText || '')) || '').split('\n').map(s => s.trim());
      const idx = ls.findIndex(s => s.toLowerCase().replace(/^www\./, '') === dom);
      if (idx >= 0) {
        const n = parseInt((ls[idx + 1] || '').replace(/[\s ]/g, ''), 10);
        if (isFinite(n) && n >= 0 && n < 1e6) return n;
      }
      return /Нет данных|Данные не найдены/i.test(ls.join('\n')) ? 0 : null; // null = грид не подтвердил ни строку, ни пустоту
    };
    // Два прохода: первый домен списка стабильно гонится с только что открытым гридом
    // (2 cron-прогона подряд теряли pryanikov38) — на 2-м проходе грид уже тёплый.
    for (let pass = 0; pass < 2; pass++) {
      for (const dom of partnerDomains) {
        if (!searchOk) break;
        if (byDomain[dom] != null) continue;
        try {
          // до 2 попыток внутри прохода: нулю с 1-й попытки не верим — перепроверяем
          for (let attempt = 0; attempt < 2 && byDomain[dom] == null; attempt++) {
            await search.fill('', { timeout: 8000 }).catch(() => {});
            await p.waitForTimeout(600);
            await search.fill(dom, { timeout: 8000 });
            await pollBody(t =>
              t.split('\n').some(s => s.trim().toLowerCase().replace(/^www\./, '') === dom) ||
              /Нет данных|Данные не найдены/i.test(t), 20000, 1200);
            await p.waitForTimeout(1500);
            const n = await readDomainRow(dom);
            if (n != null && (n > 0 || attempt === 1 || pass === 1)) byDomain[dom] = n;
          }
        } catch (e) { out['searchErr_' + dom] = String(e.message || e).slice(0, 80); }
      }
    }
    await search.fill('').catch(() => {});
  }
  out.byDomain = byDomain;
  out.partnerDomainsKnown = partnerDomains.size;
  // totalClicks = СУММА по партнёрским доменам. «Итого и средние» таблицы НЕ используем —
  // это все params визитов (в т.ч. SMS-коды), к партнёрам отношения не имеет.
  out.totalClicks = Object.values(byDomain).reduce((a, c) => a + c, 0);

  // Мердж в partners.json по домену (READ-MODIFY-WRITE; базу Bitrix сохраняем).
  let merged = 0;
  try {
    const partners = partnersDoc || JSON.parse(fs.readFileSync(PARTNERS, 'utf8'));
    for (const pr of partners.partners) {
      const dom = hostOf(pr.targetUrl || (pr.props && Object.values(pr.props).find(v => /^\s*https?:\/\//.test(v))) || '');
      pr.domain = dom;
      // непроверенный домен (byDomain нет ключа) НЕ обнуляем — оставляем прошлое значение
      pr.metrikaClicks = dom && byDomain[dom] != null ? byDomain[dom] : (pr.metrikaClicks || 0);
      if (pr.metrikaClicks > 0) merged++;
    }
    partners.metrikaClicksUpdatedAt = out.scrapedAt;
    partners.metrikaClicksPeriod = out.periodShown || 'last 30d';
    fs.writeFileSync(PARTNERS, JSON.stringify(partners, null, 2));
    out.mergedPartners = merged;
    out.matchedTotal = Object.keys(byDomain).length;
  } catch (e) { out.mergeError = e.message; }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  // ok = каждый известный партнёрский домен реально поискан (число или честный 0)
  const allSearched = noData || (!out.searchBoxMissing && Object.keys(byDomain).length === partnerDomains.size);
  console.log(JSON.stringify({ ok: allSearched, totalClicks: out.totalClicks, byDomain, merged, periodShown: out.periodShown, bodyLen: out.bodyLen, gridTimeout: !!out.gridTimeout }, null, 2));
  await b.close();
})().catch(e => { console.log('ERR', e.message); });
