// Скрейп публичной поисковой выдачи 2ГИС: рейтинг + оценки + отзывы по всем филиалам Марии.
// Не требует auth. Копит history по дням → даёт динамику рейтинга со временем (П.8).
// Cron: ежедневно. Для исторических данных за янв 2025 — 2ГИС не отдаёт, начинаем копить с сегодня.
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const HISTORY = '/opt/marketing-data/2gis-rating-history.json';
const LATEST = '/opt/marketing-data/2gis-rating-latest.json';

const SEARCH_URL = 'https://2gis.ru/irkutsk/search/%D0%9C%D0%B0%D1%80%D0%B8%D1%8F%20%D0%BA%D0%BE%D0%BD%D0%B4%D0%B8%D1%82%D0%B5%D1%80%D1%81%D0%BA%D0%B0%D1%8F';

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const result = { scrapedAt: new Date().toISOString(), date: today, branches: [] };
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 2400 } });
  const p = await ctx.newPage();
  try {
    await p.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p.waitForTimeout(6000);
    // Скроллим список — 2ГИС лоадит больше карточек
    try { await p.evaluate(() => { const el = document.querySelector('[data-paginator-list]') || document.querySelector('[data-results]'); if (el) el.scrollBy(0, 5000); }); } catch (_) {}
    await p.waitForTimeout(2000);
    // Извлекаем карточки. У 2ГИС класс хешированный, поэтому ищем по «рейтинг» текстуру.
    const cards = await p.evaluate(() => {
      const out = [];
      // Каждая карточка фирмы — это контейнер с названием «Мария» и где-то рядом текст рейтинга
      const containers = Array.from(document.querySelectorAll('[itemprop="name"]'))
        .map(el => el.closest('[data-source="results"]') || el.closest('article') || el.closest('div'))
        .filter(Boolean);
      const seen = new Set();
      for (const c of containers) {
        if (seen.has(c)) continue;
        seen.add(c);
        const text = (c.innerText || '').replace(/\s+/g, ' ').trim();
        if (!/мария/i.test(text)) continue;
        // Имя — первый кусок до перевода строки или 60 символов
        const lines = (c.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        const name = lines.find(l => /мария/i.test(l)) || lines[0] || '?';
        // Адрес обычно идёт через 1-2 строки после имени, начинается с улицы
        const addr = lines.find(l => /(улиц|проспект|переулок|микрорайон|пер\.|ул\.|пр\.|шоссе|бульвар)/i.test(l)) || '';
        // Рейтинг — паттерн «4.4» или «4,4» с диапазоном 1-5
        const ratingM = text.match(/(?:^|\s)([1-5](?:[.,]\d))(?=\s|$)/);
        const rating = ratingM ? parseFloat(ratingM[1].replace(',', '.')) : null;
        // Количество оценок: «153 оценки» / «23 оценок» / «1 оценка»
        const oM = text.match(/(\d[\d\s]*)\s*оцен/i);
        const ratingsCount = oM ? parseInt(oM[1].replace(/\s/g, ''), 10) : null;
        // Отзывы: «5 отзывов» / «1 отзыв»
        const rM = text.match(/(\d[\d\s]*)\s*отзыв/i);
        const reviewsCount = rM ? parseInt(rM[1].replace(/\s/g, ''), 10) : null;
        // URL карточки
        const link = c.querySelector('a[href*="/firm/"]');
        const url = link ? link.href : null;
        out.push({ name, addr, rating, ratingsCount, reviewsCount, url });
      }
      return out;
    });
    result.branches = cards;
  } catch (e) { result.error = e.message; }
  await b.close();

  // Дедуп по URL (если 2ГИС дублирует)
  const seen = new Set();
  result.branches = result.branches.filter(b => {
    const k = b.url || (b.name + '|' + b.addr);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const valid = result.branches.filter(b => b.rating != null);
  result.summary = {
    branchesScraped: result.branches.length,
    branchesWithRating: valid.length,
    avgRating: valid.length ? Math.round(valid.reduce((s, b) => s + b.rating, 0) / valid.length * 100) / 100 : null,
    totalRatingsCount: valid.reduce((s, b) => s + (b.ratingsCount || 0), 0),
    totalReviewsCount: valid.reduce((s, b) => s + (b.reviewsCount || 0), 0)
  };

  try { fs.mkdirSync('/opt/marketing-data', { recursive: true }); } catch (_) {}
  fs.writeFileSync(LATEST, JSON.stringify(result, null, 2));

  // history: upsert per day
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch (_) {}
  const idx = history.findIndex(h => h.date === today);
  const histEntry = {
    date: today,
    scrapedAt: result.scrapedAt,
    summary: result.summary,
    perBranch: result.branches.map(b => ({ name: b.name, addr: b.addr, rating: b.rating, ratingsCount: b.ratingsCount, reviewsCount: b.reviewsCount }))
  };
  if (idx >= 0) history[idx] = histEntry; else history.push(histEntry);
  history.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2));

  console.log(JSON.stringify({ ok: true, date: today, ...result.summary, error: result.error || null }));
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
