// Помесячный скрейп 2ГИС «Присутствие в выдаче» — пресет «Год» отдаёт таблицу
// сразу по месяцам (13 точек: текущий + 12 назад). Пишет /opt/marketing-data/2gis-history.json.
//
// История версий:
//  v1: цикл по месяцам через ?competitionPeriod=URL — 2ГИС параметр ИГНОРИРУЕТ,
//      всегда отдаёт последние 30 дней → копились только текущие месяцы (2 шт).
//  v2 (05.06.2026): клик по пресету «Год» → «Показать таблицу» → строки-месяцы.
//      Одним заходом весь год. Позиция — средняя за месяц (мин/макс в годовом виде нет).
//  v3 (05.06.2026): + страница «Страница компании» (statistics/card) — 4 виджета,
//      у каждого свой пресет «Год»: действия/переходы на страницу, звонки/сайт/маршруты,
//      просмотры цен/товаров. Всё помесячно, мёржится в series по ym.
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const OUT = '/opt/marketing-data/2gis-history.json';
const ORG = '1548649242829424';

const num = s => parseFloat(String(s || '').replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.')) || 0;
const MONTHS = { 'январь': 1, 'февраль': 2, 'март': 3, 'апрель': 4, 'май': 5, 'июнь': 6, 'июль': 7, 'август': 8, 'сентябрь': 9, 'октябрь': 10, 'ноябрь': 11, 'декабрь': 12 };

(async () => {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ storageState: '/opt/2gis-scraper/2gis-state.json', locale: 'ru-RU', viewport: { width: 1500, height: 2400 } });
  const p = await ctx.newPage();

  await p.goto(`https://account.2gis.com/orgs/${ORG}/statistics/appearance`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(5000);
  if (/passport|auth|login/i.test(p.url()) || /account\.2gis\.com\/(?:\?|$)/.test(p.url())) {
    console.log(JSON.stringify({ ok: false, sessionExpired: true }));
    await b.close(); return; // НЕ перезаписываем хорошие данные при протухшей сессии
  }
  // SPA-виджет рендерится 7-15с+ — поллим до 40с (та же грабля, что в scrape-mkt)
  let widget = false;
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(2000);
    widget = await p.evaluate(() => /рубрик/i.test(document.body ? document.body.innerText : '')).catch(() => false);
    if (widget) break;
  }
  if (!widget) { console.log(JSON.stringify({ ok: false, error: 'widget_timeout' })); await b.close(); return; }

  // Пресет «Год» → таблица по месяцам
  try {
    await p.getByText('Год', { exact: true }).first().click({ timeout: 8000 });
    await p.waitForTimeout(5000);
  } catch (e) { console.log(JSON.stringify({ ok: false, error: 'year_click: ' + e.message.slice(0, 80) })); await b.close(); return; }

  // «Показать таблицу»
  try {
    const els = await p.$$('button,[role=button],a,span');
    for (const e of els) { const t = (await e.innerText().catch(() => '')) || ''; if (t.trim() === 'Показать таблицу') { await e.click(); await p.waitForTimeout(3000); break; } }
  } catch (_) {}

  const rows = await p.evaluate(() => {
    const t = [...document.querySelectorAll('table')].find(x => /Показы/.test(x.innerText));
    return t ? [...t.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('td,th')].map(c => c.innerText.trim())) : [];
  });

  const now = new Date();
  const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const series = [];
  for (const r of rows) {
    if (r.length < 2) continue;
    const m = /^([а-яё]+)\s+(\d{4})$/i.exec(r[0] || '');
    if (!m) continue;
    const mm = MONTHS[m[1].toLowerCase()];
    if (!mm) continue;
    const ym = `${m[2]}-${String(mm).padStart(2, '0')}`;
    const pos = r.length >= 3 ? num(r[2]) : 0;
    series.push({
      ym,
      impressions: Math.round(num(r[1])),
      days: ym === curYM ? Math.max(1, now.getDate() - 1) : null, // в годовой таблице дней нет; для текущего — прошедшие
      positionAvg: pos > 0 ? pos : null,
      positionMin: null, // годовой вид отдаёт только среднюю позицию
      positionMax: null,
      partial: ym === curYM || undefined
    });
  }
  if (!series.length) { console.log(JSON.stringify({ ok: false, error: 'no_rows' })); await b.close(); return; }

  // ── «Страница компании»: действия и переходы помесячно ──────────────────
  const byYm = new Map(series.map(s2 => [s2.ym, s2]));
  const HEAD_KEYS = {
    'Действия на странице': 'actions',
    'Переходы на страницу': 'pageVisits',
    'Звонки и просмотры телефона': 'calls',
    'Клики в адрес': 'addressClicks',
    'Переходы на сайт': 'siteClicks',
    'Построения маршрутов': 'routes',
    'Клики в соцсети': 'socialClicks',
    'Клики в мессенджеры': 'messengerClicks',
    'Переходы по рекламной ссылке': 'adClicks',
    'Просмотр цен': 'priceViews',
    'Открытие карточки товара': 'productViews'
  };
  try {
    await p.goto(`https://account.2gis.com/orgs/${ORG}/statistics/card`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 20; i++) { await p.waitForTimeout(2000); if ((await p.evaluate(() => document.body ? document.body.innerText.length : 0)) > 700) break; }
    // у каждого виджета свой пресет «Год» — кликаем все
    const years = p.getByText('Год', { exact: true });
    const n = await years.count();
    for (let i = 0; i < n; i++) { await years.nth(i).click({ timeout: 5000 }).catch(() => {}); await p.waitForTimeout(2500); }
    await p.waitForTimeout(3000);
    const els2 = await p.$$('button,[role=button],a,span');
    for (const e of els2) { const t = (await e.innerText().catch(() => '')) || ''; if (t.trim() === 'Показать таблицу') { await e.click().catch(() => {}); await p.waitForTimeout(1500); } }
    const tables = await p.evaluate(() => [...document.querySelectorAll('table')].map(t => [...t.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('td,th')].map(c => c.innerText.trim()))));
    for (const tbl of tables) {
      if (!tbl.length) continue;
      const head = tbl[0];
      const keys = head.map(h => HEAD_KEYS[h] || null);
      if (!keys.some(Boolean)) continue;
      for (const r of tbl.slice(1)) {
        const m = /^([а-яё]+)\s+(\d{4})$/i.exec(r[0] || '');
        if (!m) continue;
        const mm = MONTHS[m[1].toLowerCase()];
        if (!mm) continue;
        const ym = `${m[2]}-${String(mm).padStart(2, '0')}`;
        if (!byYm.has(ym)) { const e2 = { ym, impressions: null, days: null, positionAvg: null, positionMin: null, positionMax: null }; byYm.set(ym, e2); series.push(e2); }
        const entry = byYm.get(ym);
        for (let ci = 1; ci < keys.length; ci++) {
          if (keys[ci]) entry[keys[ci]] = Math.round(num(r[ci]));
        }
      }
    }
  } catch (e) { console.log('card warn:', e.message.slice(0, 80)); }

  series.sort((a, b2) => a.ym.localeCompare(b2.ym));
  fs.writeFileSync(OUT, JSON.stringify({ scrapedAt: new Date().toISOString(), source: '2gis-year', series }, null, 1));
  console.log(JSON.stringify({ ok: true, months: series.length, from: series[0].ym, to: series[series.length - 1].ym, withActions: series.filter(s2 => s2.actions != null).length }));
  await b.close();
})().catch(e => { console.log(JSON.stringify({ ok: false, error: e.message.slice(0, 120) })); process.exit(1); });
