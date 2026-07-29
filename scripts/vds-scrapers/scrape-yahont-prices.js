// Скрейпер цен ЯХОНТа из карточки 2ГИС (своего сайта нет). Вкладка /tab/prices.
// Запуск на VDS (чистый РФ-IP). Пишет /opt/marketing-data/yahont-prices.json
// в той же форме, что competitors в prices.json: {categories:{key:{min,max,unit,count}}}.
// Аргумент --dry — только печать разбора, без записи файла.
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const ORG = '1548649243003192', CITY = 'irkutsk';
const FALLBACK_FIRM = '1548640653153753'; // разведан 24.06.2026; если discovery не сработает
const OUT = '/opt/marketing-data/yahont-prices.json';
const DRY = process.argv.includes('--dry');

async function museum(page) { if (!page.url().includes('/museum')) return; for (const l of await page.$$('a')) { const t = (await l.textContent() || '').trim(); if (/пропустить/i.test(t)) { await l.click().catch(() => {}); await page.waitForTimeout(2500); break; } } }
async function scrollAll(page, n) { for (let i = 0; i < n; i++) { await page.evaluate(() => { window.scrollBy(0, 1800); for (const el of document.querySelectorAll('*')) { if (el.scrollHeight - el.clientHeight > 100) el.scrollBy(0, 1500); } }); await page.waitForTimeout(420); } }

function categorize(name) {
  const s = name.toLowerCase();
  if (/макарон/.test(s)) return 'macarons';
  if (/бенто/.test(s)) return 'bento';
  if (/пирожн|кусоч|эклер|капкейк|маффин|десерт/.test(s)) return 'kusochki';
  if (/торт|медовик|наполеон|чизкейк|прага|муравейник|графск|мусс/.test(s)) return 'tort';
  return 'other';
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 2200 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' });
  await ctx.route('**/*', r => { const t = r.request().resourceType(); if (t === 'image' || t === 'font' || t === 'media') return r.abort(); return r.continue(); });
  const page = await ctx.newPage();
  let firmId = null;
  try {
    await page.goto('https://2gis.ru/' + CITY + '/branches/' + ORG, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500); await museum(page);
    await scrollAll(page, 15);
    const ids = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/firm/"]')).map(a => (a.getAttribute('href').match(/\/firm\/(\d+)/) || [])[1]).filter(Boolean))));
    firmId = ids[0] || FALLBACK_FIRM;
  } catch (e) { firmId = FALLBACK_FIRM; }

  async function grab(fid) {
    await page.goto('https://2gis.ru/' + CITY + '/firm/' + fid + '/tab/prices', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500); await museum(page);
    await scrollAll(page, 18);
    return await page.evaluate(() => {
      const out = [], seen = new Set();
      document.querySelectorAll('*').forEach(function (el) {
        if (el.children.length > 4) return;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length < 5 || t.length > 110) return;
        if ((t.match(/₽/g) || []).length !== 1) return; // ровно одна цена = строка-товар
        const m = t.match(/^(.{3,90}?)\s*(\d[\d\s]{1,7})\s*₽/);
        if (!m) return;
        const name = m[1].trim();
        const price = parseInt(m[2].replace(/\D/g, ''), 10);
        if (!/[А-я]/.test(name) || !(price > 50 && price < 100000)) return;
        const key = name.toLowerCase();
        if (seen.has(key)) return; seen.add(key);
        out.push({ name: name, price: price });
      });
      return out;
    });
  }

  let items = await grab(firmId);
  if (items.length < 3 && firmId !== FALLBACK_FIRM) items = await grab(FALLBACK_FIRM);
  await browser.close();

  const byCat = {};
  for (const it of items) { const c = categorize(it.name); (byCat[c] = byCat[c] || []).push(it.price); }
  function rng(arr) { if (!arr || !arr.length) return null; return { min: Math.min.apply(0, arr), max: Math.max.apply(0, arr), unit: 'шт', count: arr.length }; }
  const cats = {};
  if (byCat.tort) { cats.tort_zakaz = rng(byCat.tort); cats.tort_gotovyj = rng(byCat.tort); }
  if (byCat.bento) cats.bento = rng(byCat.bento);
  if (byCat.kusochki) cats.kusochki = rng(byCat.kusochki);
  if (byCat.macarons) cats.macarons = rng(byCat.macarons);

  const result = { scrapedAt: new Date().toISOString(), source: '2gis-firm-prices', org: ORG, firmId: firmId, itemsParsed: items.length, categories: cats };

  console.log('=== ЯХОНТ price scrape ===');
  console.log('firmId:', firmId, '| позиций:', items.length);
  console.log('по категориям:', JSON.stringify(Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, v.length]))));
  console.log('CATEGORIES:', JSON.stringify(cats));
  console.log('SAMPLE:', items.slice(0, 30).map(x => x.name + '=' + x.price).join(' | '));

  if (DRY) { console.log('(--dry: файл не записан)'); return; }
  if (items.length < 3) { console.log('МАЛО позиций — НЕ перезаписываю файл (защита от пустого)'); return; }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('WROTE', OUT);
})().catch(e => console.log('FATAL', e.message));
