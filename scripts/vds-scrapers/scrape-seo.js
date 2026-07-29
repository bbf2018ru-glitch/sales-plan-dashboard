// SEO-скрейпер: позиции Мария и Стефания в Яндексе по топ-запросам Иркутска.
// Запускается по cron 1× в неделю → /opt/marketing-data/seo.json.
// Использует /opt/2gis-scraper/yandex-state.json (наша Яндекс-сессия пропускает капчу).
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const OUT = '/opt/marketing-data/seo.json';

const QUERIES = [
  // ── Основные ──────────────────────────────────────────────────────────────
  { q: 'торты иркутск', cat: 'main' },
  { q: 'торт на заказ иркутск', cat: 'main' },
  { q: 'кондитерская иркутск', cat: 'main' },
  { q: 'кондитерские иркутска', cat: 'main' },
  { q: 'купить торт иркутск', cat: 'main' },
  { q: 'доставка тортов иркутск', cat: 'main' },
  // ── Виды тортов ───────────────────────────────────────────────────────────
  { q: 'бенто торт иркутск', cat: 'cake-type' },
  { q: 'муссовый торт иркутск', cat: 'cake-type' },
  { q: 'медовик иркутск', cat: 'cake-type' },
  { q: 'наполеон иркутск', cat: 'cake-type' },
  { q: 'чизкейк иркутск', cat: 'cake-type' },
  { q: 'красный бархат иркутск', cat: 'cake-type' },
  { q: 'три шоколада торт иркутск', cat: 'cake-type' },
  // ── Целевые случаи ────────────────────────────────────────────────────────
  { q: 'свадебный торт иркутск', cat: 'occasion' },
  { q: 'детский торт иркутск', cat: 'occasion' },
  { q: 'торт на день рождения иркутск', cat: 'occasion' },
  { q: 'корпоративный торт иркутск', cat: 'occasion' },
  { q: 'торт для мальчика иркутск', cat: 'occasion' },
  { q: 'торт для девочки иркутск', cat: 'occasion' },
  // ── Десерты помимо тортов ─────────────────────────────────────────────────
  { q: 'пирожные иркутск', cat: 'dessert' },
  { q: 'эклеры иркутск', cat: 'dessert' },
  { q: 'макаронс иркутск', cat: 'dessert' },
  { q: 'капкейки иркутск', cat: 'dessert' },
  { q: 'круассаны иркутск', cat: 'dessert' },
  // ── Кафе и кофе ───────────────────────────────────────────────────────────
  { q: 'кофе с собой иркутск', cat: 'coffee' },
  { q: 'кофейня иркутск', cat: 'coffee' },
  { q: 'завтрак иркутск кафе', cat: 'coffee' },
  { q: 'ланч иркутск', cat: 'coffee' },
  // ── Локальные (микрорайоны) ───────────────────────────────────────────────
  { q: 'кондитерская солнечный иркутск', cat: 'geo' },
  { q: 'торт иркутск пушкина', cat: 'geo' },
  { q: 'торт иркутск ядринцева', cat: 'geo' },
  { q: 'кондитерская юбилейный иркутск', cat: 'geo' },
  // ── Брендовые (проверка на знание) ────────────────────────────────────────
  { q: 'мария кондитерская иркутск', cat: 'brand' },
  { q: 'maria irk', cat: 'brand' }
];

const DOMAINS = {
  'maria': /(?:^|\.)maria-irk\.ru/i,
  'stefania': /(?:^|\.)stefanycake\.ru/i,
  'cakehome': /(?:^|\.)cakehome\.ru/i,
  'etika': /(?:^|\.)etikacakes\.ru/i,
  'yahont': /(?:^|\.)yahontcake\.ru/i
};

function findRank(urls, re) {
  for (let i = 0; i < urls.length; i++) {
    try { const u = new URL(urls[i]); if (re.test(u.hostname)) return i + 1; } catch (_) {}
  }
  return null;
}

(async () => {
  const out = { scrapedAt: new Date().toISOString(), source: 'yandex-serp', region: 'Иркутск (lr=63)' };
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({
    storageState: '/opt/2gis-scraper/yandex-state.json',
    locale: 'ru-RU', viewport: { width: 1440, height: 1800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  const queries = [];
  let captchaCount = 0;

  for (const item of QUERIES) {
    const q = item.q, cat = item.cat;
    const p = await ctx.newPage();
    const url = 'https://yandex.ru/search/?text=' + encodeURIComponent(q) + '&lr=63';
    try { await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 }); } catch (e) { }
    await p.waitForTimeout(4500);
    if (/showcaptcha|captcha/i.test(p.url())) {
      captchaCount++; queries.push({ q, cat, captcha: true });
      await p.close();
      // увеличенный sleep между запросами после капчи — снижает риск её снова
      await new Promise(r => setTimeout(r, 8000));
      continue;
    }

    // organic results — отбрасываем рекламу и yandex-сервисы
    const urls = await p.evaluate(() => {
      const links = Array.from(document.querySelectorAll('li.serp-item a.organic__url, li.serp-item a.OrganicTitle-Link'));
      const out = [];
      const seen = new Set();
      for (const a of links) {
        const h = a.href;
        if (!h || seen.has(h)) continue;
        if (/yandex\.ru|ya\.ru|yandex\.net/i.test(h)) continue;
        seen.add(h); out.push(h);
        if (out.length >= 15) break;
      }
      return out;
    }).catch(() => []);

    const ranks = {};
    for (const [name, re] of Object.entries(DOMAINS)) {
      ranks[name] = findRank(urls, re);
    }
    queries.push({
      q, cat, ranks,
      top1: urls[0] ? new URL(urls[0]).hostname.replace(/^www\./, '') : null,
      resultsCount: urls.length
    });
    await p.close();
    await new Promise(r => setTimeout(r, 3500));
  }

  // Агрегаты: по бренду — top10 count и avg
  const aggForBrand = (brand) => {
    const arr = queries.filter(q => q.ranks && q.ranks[brand] != null).map(q => q.ranks[brand]);
    const top10 = arr.filter(r => r <= 10).length;
    const top3  = arr.filter(r => r <= 3).length;
    const avg   = arr.length ? Math.round((arr.reduce((s, r) => s + r, 0) / arr.length) * 10) / 10 : null;
    return { found: arr.length, top10, top3, avg };
  };

  // Группировка по категории (avg ranking Марии в каждой)
  const cats = {};
  for (const q of queries) {
    const c = q.cat || 'other';
    if (!cats[c]) cats[c] = { total: 0, mariaRanks: [], captcha: 0 };
    cats[c].total += 1;
    if (q.captcha) cats[c].captcha += 1;
    else if (q.ranks && q.ranks.maria != null) cats[c].mariaRanks.push(q.ranks.maria);
  }
  const byCategory = Object.entries(cats).map(([cat, v]) => ({
    cat, total: v.total, captcha: v.captcha, mariaInTop10: v.mariaRanks.filter(r => r <= 10).length,
    avgRankMaria: v.mariaRanks.length ? Math.round((v.mariaRanks.reduce((s,r)=>s+r,0) / v.mariaRanks.length) * 10) / 10 : null,
  }));

  out.summary = {
    queriesTotal: QUERIES.length,
    captchaCount,
    maria: aggForBrand('maria'),
    stefania: aggForBrand('stefania'),
    cakehome: aggForBrand('cakehome'),
    etika: aggForBrand('etika'),
    yahont: aggForBrand('yahont'),
    // back-compat
    mariaTop10: aggForBrand('maria').top10,
    stefaniaTop10: aggForBrand('stefania').top10,
    avgRankMaria: aggForBrand('maria').avg,
    avgRankStefania: aggForBrand('stefania').avg
  };
  out.queries = queries;
  out.byCategory = byCategory;
  await b.close();

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('[scrape-seo] done queries=' + queries.length + ' captcha=' + captchaCount + ' top10maria=' + aggForBrand('maria').top10);
})();
