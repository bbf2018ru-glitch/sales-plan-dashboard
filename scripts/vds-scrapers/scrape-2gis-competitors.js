// Рейтинги конкурентов из ПУБЛИЧНОГО 2ГИС (v3, 2026-06-08).
// v1 (кабинет) давал только «Марию»; v2 (поиск) недосчитывал филиалы (поиск отдаёт
// не весь список) → кривые рейтинг/точки/оценки. v3: для каждого бренда берём ПОЛНЫЙ
// список филиалов со страницы /branches/<orgId> (как discover-branches.js для «Марии»),
// парсим рейтинг + число оценок каждого филиала, агрегируем по бренду (рейтинг —
// средневзвешенный по числу оценок). orgId разведаны вручную (firm → ссылка «N филиалов»).
// Пишет /opt/marketing-data/competitors-2gis.json (shape: companies:[{name,rating,reviews,branches}]).
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const OUT = '/opt/marketing-data/competitors-2gis.json';
const MARIA_LATEST = '/opt/marketing-data/2gis-rating-latest.json';
const CITY = 'irkutsk';

// orgId 2ГИС (стабильны). Текст «N филиалов» — для справки на момент разведки 08.06.2026.
const COMPETITORS = [
  { name: 'Стефания',  org: '1548649242956763' }, // ~40 филиалов
  { name: 'Этика',     org: '70000001037696306' }, // ~7
  { name: 'Cake Home', org: '1548649243106929' }, // ~23
  { name: 'ЯХОНТ',     org: '1548649243003192' }, // ~19
];

async function bypassMuseum(page) {
  if (!page.url().includes('/museum')) return;
  for (const link of await page.$$('a')) {
    const t = (await link.textContent() || '').trim();
    if (/пропустить/i.test(t)) { await link.click().catch(() => {}); await page.waitForTimeout(2500); break; }
  }
}

function parseCard(text) {
  const m = text.match(/^([\d.,]+)\s*\n\s*(\d+)\s+оцен/m) || text.match(/(\d[.,]\d)\s+(\d+)\s+оцен/);
  return { rating: m ? parseFloat(m[1].replace(',', '.')) : null, ratingCount: m ? parseInt(m[2], 10) : null };
}

// Полный список филиалов бренда со страницы /branches/<orgId> (со скроллом до упора).
async function scrapeBranches(browser, comp) {
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 2200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' });
  await ctx.route('**/*', r => { const t = r.request().resourceType(); if (t === 'image' || t === 'font' || t === 'media') return r.abort(); return r.continue(); });
  const page = await ctx.newPage();
  try {
    await page.goto('https://2gis.ru/' + CITY + '/branches/' + comp.org, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500);
    await bypassMuseum(page);
    // Скроллим список филиалов до упора (lazy load) — копия логики discover-branches.
    let prev = 0, same = 0;
    for (let i = 0; i < 200; i++) {
      await page.evaluate(() => {
        let best = null, max = 0;
        for (const el of document.querySelectorAll('*')) {
          if (el.scrollHeight - el.clientHeight > 100) {
            const links = el.querySelectorAll('a[href*="/firm/"]').length;
            if (links > max) { max = links; best = el; }
          }
        }
        if (best) best.scrollBy(0, 1500);
        window.scrollBy(0, 1500);
      });
      try { await page.keyboard.press('PageDown'); } catch (_) {}
      await page.waitForTimeout(420);
      const cnt = await page.evaluate(() => new Set(Array.from(document.querySelectorAll('a[href*="/firm/"]')).map(a => (a.getAttribute('href').match(/\/firm\/(\d+)/) || [])[1]).filter(Boolean)).size);
      if (cnt === prev) { if (++same >= 20) break; } else same = 0;
      prev = cnt;
    }
    // По каждому firm-id поднимаемся к контейнеру-карточке и берём innerText.
    const cards = await page.evaluate(() => {
      const firmIdsOf = (el) => { const s = new Set(); for (const x of el.querySelectorAll('a[href*="/firm/"]')) { const m = (x.getAttribute('href') || '').match(/\/firm\/(\d+)/); if (m) s.add(m[1]); } return s; };
      const out = [], seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/firm/"]')) {
        const m = (a.getAttribute('href') || '').match(/\/firm\/(\d+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        let card = a, el = a.parentElement;
        for (let d = 0; d < 10 && el && el !== document.body; d++, el = el.parentElement) { if (firmIdsOf(el).size > 1) break; card = el; }
        out.push({ id: m[1], text: (card.innerText || '').trim() });
      }
      return out;
    });
    const rated = cards.map(c => parseCard(c.text)).filter(c => c.rating != null);
    console.error(`[${comp.name}] cards=${cards.length} rated=${rated.length}`);
    if (!rated.length) return { name: comp.name, rating: null, reviews: null, branches: 0, note: 'нет филиалов с рейтингом' };
    let wsum = 0, wn = 0, reviews = 0;
    for (const c of rated) { const w = c.ratingCount || 1; wsum += c.rating * w; wn += w; reviews += (c.ratingCount || 0); }
    return { name: comp.name, rating: Math.round(wsum / wn * 10) / 10, reviews, branches: rated.length };
  } catch (e) {
    return { name: comp.name, rating: null, reviews: null, branches: 0, error: String(e.message || e).slice(0, 80) };
  } finally { await ctx.close(); }
}

function mariaFromLatest() {
  try {
    const j = JSON.parse(fs.readFileSync(MARIA_LATEST, 'utf8'));
    const br = (j.branches || []).filter(b => b.rating != null);
    if (!br.length) return null;
    let wsum = 0, wn = 0, reviews = 0;
    for (const b of br) { const w = b.ratingCount || 1; wsum += b.rating * w; wn += w; reviews += (b.ratingCount || 0); }
    return { name: 'Мария, кафе-кондитерская', rating: Math.round(wsum / wn * 10) / 10, reviews, branches: br.length };
  } catch (_) { return null; }
}

(async () => {
  const out = { scrapedAt: new Date().toISOString(), source: '2gis-public-branches', city: CITY,
    method: 'полный список филиалов /branches/<orgId>; рейтинг — средневзвешенный по числу оценок', companies: [] };
  const maria = mariaFromLatest();
  if (maria) out.companies.push(maria);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  try {
    for (const comp of COMPETITORS) {
      let r = await scrapeBranches(browser, comp);
      if (r.rating == null) { await new Promise(z => setTimeout(z, 1500)); r = await scrapeBranches(browser, comp); }
      out.companies.push(r);
      console.log(comp.name, JSON.stringify({ rating: r.rating, reviews: r.reviews, branches: r.branches, err: r.error || r.note }));
    }
  } catch (e) { out.error = String(e.message || e); }
  finally { await browser.close(); }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('WROTE', OUT, 'companies:', out.companies.length);
})().catch(e => console.log('FATAL', e.message));
