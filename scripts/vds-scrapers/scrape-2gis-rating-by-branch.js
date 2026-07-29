// 2ГИС рейтинг по всем филиалам — из сводной таблицы на странице /branches/<any>/reviews
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const ORG = '1548649242829424';
const OUT = '/opt/marketing-data/2gis-rating-by-branch.json';
const HISTORY = '/opt/marketing-data/2gis-rating-history.json';

(async () => {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ storageState: '/opt/2gis-scraper/2gis-state.json', locale: 'ru-RU', viewport: { width: 1500, height: 2400 } });
  const p = await ctx.newPage();

  // /branches → редирект на первый филиал
  await p.goto(`https://account.2gis.com/orgs/${ORG}/branches`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(6000);
  const u = p.url();
  const m = u.match(/\/branches\/(\d+)/);
  if (!m) { console.log('NO branch in url:', u); await b.close(); return; }
  const firstBranchId = m[1];

  // Идём на /reviews — там сводная таблица «Все филиалы»
  await p.goto(`https://account.2gis.com/orgs/${ORG}/branches/${firstBranchId}/reviews`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(8000);

  // Прокрутим страницу — sometimes table lazy-loads
  for (let i = 0; i < 5; i++) { try { await p.evaluate(() => window.scrollBy(0, 400)); } catch (_) {} await p.waitForTimeout(400); }
  await p.waitForTimeout(2000);

  // Пробуем кликнуть «Все филиалы» если есть expand-button
  try {
    const allBtn = p.getByText('Все филиалы', { exact: true });
    if (await allBtn.count() > 0) { await allBtn.first().click({ timeout: 4000 }); await p.waitForTimeout(3000); }
  } catch (_) {}

  // Парсим body text — после блока «Все филиалы / Филиал / Оценка / Без ответа» идут строки
  const body = await p.evaluate(() => document.body ? document.body.innerText : '');
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean);
  const idxStart = lines.findIndex((l, i) =>
    /^Все филиалы$/i.test(l) && lines[i + 1] === 'Филиал' && /Оценк/i.test(lines[i + 2] || '')
  );
  const table = { headerText: idxStart >= 0 ? 'found-at-' + idxStart : 'not-found', rows: [] };
  if (idxStart >= 0) {
    // После заголовков идут строки филиалов. Каждая строка = «<адрес>», «<оценка 4,X>», «<без ответа>».
    for (let i = idxStart + 4; i < lines.length - 1; i++) {
      const l = lines[i];
      // конец таблицы — следующий H2-block («Популярные мнения», «Выбрано N площадок» внутри тоже встретится)
      if (/^(Популярные мнения|Запросите отзывы|Выбрано|Все мнения)/i.test(l)) break;
      // Адрес: содержит улица/проспект/микрорайон/цифру дома
      if (/(улиц|проспект|микрорайон|пр-т|переулок|шоссе|бульвар|\d{1,3}[-]?[йя])/i.test(l) || /^\d/.test(l)) {
        const next1 = lines[i + 1] || '';
        const next2 = lines[i + 2] || '';
        const ratingM = next1.match(/^([1-5][.,]\d)$/);
        const replyM = next2.match(/^(\d+)$/);
        if (ratingM) {
          table.rows.push([l, ratingM[1], replyM ? replyM[1] : '']);
          i += 2;
        }
      }
    }
  }

  console.log('table found:', !!table);
  console.log('rows:', table.rows.length);
  if (table.rows.length) {
    console.log('sample rows:');
    table.rows.slice(0, 5).forEach(r => console.log(' ', JSON.stringify(r)));
  }

  // Парсим строки
  const branches = [];
  for (const row of table.rows) {
    if (!row || row.length < 2) continue;
    const filial = row[0];
    if (!filial || /Филиал|filial/i.test(filial)) continue;
    // Оценка в одной из ячеек, формат 4,5 / 4.5
    let rating = null;
    for (const cell of row) {
      const rm = String(cell).match(/^([1-5][.,]\d)$/);
      if (rm) { rating = parseFloat(rm[1].replace(',', '.')); break; }
    }
    // Кол-во «без ответа»
    let withoutReply = null;
    for (const cell of row) {
      if (/^\d+$/.test(String(cell))) { withoutReply = parseInt(cell, 10); break; }
    }
    branches.push({ name: filial, rating, withoutReply });
  }

  // Также вытащим общий рейтинг компании если виден на странице
  const bodyText = await p.evaluate(() => document.body ? document.body.innerText : '');
  const overallM = bodyText.match(/(?:Оценка компании|Средняя оценка|Рейтинг компании)\s*[:\-]?\s*([1-5][.,]\d)/i);
  const overall = overallM ? parseFloat(overallM[1].replace(',', '.')) : null;

  const result = { scrapedAt: new Date().toISOString(), source: '2gis-rating-by-branch', firstBranchId, overall, branches, raw: { headerText: table.headerText, rowsCount: table.rows.length } };
  const withRating = branches.filter(b => b.rating != null);
  result.summary = {
    branchesTotal: branches.length,
    branchesWithRating: withRating.length,
    avgRating: withRating.length ? Math.round(withRating.reduce((s, b) => s + b.rating, 0) / withRating.length * 100) / 100 : null,
    totalWithoutReply: branches.reduce((s, b) => s + (b.withoutReply || 0), 0)
  };

  try { fs.mkdirSync('/opt/marketing-data', { recursive: true }); } catch (_) {}
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

  // History
  const today = new Date().toISOString().slice(0, 10);
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch (_) {}
  const idx = history.findIndex(h => h.date === today);
  const entry = { date: today, scrapedAt: result.scrapedAt, summary: result.summary, perBranch: branches };
  if (idx >= 0) history[idx] = entry; else history.push(entry);
  history.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2));

  await b.close();
  console.log(JSON.stringify({ ok: true, ...result.summary }));
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
