// Изолированный скрейп ТОЛЬКО reviews — merge в существующий 2gis.json
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const ORG = '1548649242829424';
const BASE = `https://account.2gis.com/orgs/${ORG}/`;
const TARGET = '/opt/marketing-data/2gis.json';

(async () => {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ storageState: '/opt/2gis-scraper/2gis-state.json', locale: 'ru-RU', viewport: { width: 1500, height: 2400 } });
  const p = await ctx.newPage();

  try {
    await p.goto(BASE + 'branches', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(7000);
    const branchUrl = p.url();
    const branchIdM = branchUrl.match(/\/branches\/(\d+)/);
    if (!branchIdM) { console.log('no branch id'); await b.close(); return; }
    const reviewsUrl = `${BASE}branches/${branchIdM[1]}/reviews`;
    await p.goto(reviewsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(8000);
    for (let i = 0; i < 6; i++) { try { await p.evaluate(() => window.scrollBy(0, 600)); } catch (_) {} await p.waitForTimeout(500); }
    await p.waitForTimeout(2000);

    const rbody = await p.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    const rlines = rbody.split('\n').map(s => s.trim()).filter(Boolean);
    // Теги
    const tagBlock = rlines.findIndex(l => l === 'Торты');
    const tags = [];
    if (tagBlock >= 0) {
      for (let i = tagBlock; i < Math.min(tagBlock + 15, rlines.length); i++) {
        const l = rlines[i];
        if (/^[А-ЯЁ][а-яё]{2,15}$/.test(l) && l.length < 25) tags.push(l);
        else if (i > tagBlock + 2 && !/[А-ЯЁ][а-яё]+/.test(l)) break;
      }
    }
    // Google maps reviews count
    const gmM = rbody.match(/(\d[\d\s ]*)\s+отзыв\w*\s+в\s+Google/i);
    const googleMapsReviews = gmM ? parseInt(gmM[1].replace(/[\s ]/g, ''), 10) : null;

    // Парсим отзывы
    const reviews = [];
    const PLATFORMS = /^(2GIS|Google maps|2ГИС\.\s*Отзывы Про|Otello|Flamp|Booking)/i;
    const isDate = l => /^\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+20\d{2}$/.test(l);
    for (let i = 0; i < rlines.length - 3; i++) {
      if (PLATFORMS.test(rlines[i + 1] || '') && isDate(rlines[i + 2] || '')) {
        const author = rlines[i];
        const platform = rlines[i + 1];
        const date = rlines[i + 2];
        const text = rlines[i + 3] || '';
        if (text.length > 20 && !PLATFORMS.test(text)) {
          reviews.push({ author: author.slice(0, 60), platform, date, text: text.slice(0, 500) });
        }
      }
    }
    console.log('reviews parsed:', reviews.length, '| tags:', tags.length, '| gmReviews:', googleMapsReviews);

    // Merge в существующий 2gis.json
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(TARGET, 'utf8')); } catch (_) {}
    existing.reviews = {
      items: reviews.slice(0, 30),
      total: reviews.length,
      googleMapsReviews,
      tags,
      scrapedAt: new Date().toISOString()
    };
    fs.writeFileSync(TARGET, JSON.stringify(existing, null, 2));
    console.log('✓ merged into', TARGET);
  } catch (e) { console.log('ERR:', e.message); }
  await b.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
