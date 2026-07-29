// Серверный скрейпер Я.Директа (живёт на VDS: /opt/2gis-scraper/scrape-direct.js).
// По cron 1× в день → /opt/marketing-data/direct.json.
// Сессия: /opt/2gis-scraper/yandex-state.json (перенесена с PC, привязки к IP не было).
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const OUT = '/opt/marketing-data/direct.json';
// Без &state=NNN: сохранённый отчёт state=4362658 умер 06.2026 («Не удалось открыть отчёт»),
// свежий отчёт открывается с пустым периодом — период выставляем пресетом «30 дней» ниже.
const REPORT_URL = 'https://direct.yandex.ru/dna/reports/library/performance-campaigns/?ulogin=porg-mcw4s7ni';
const STATE_FILE = '/opt/2gis-scraper/yandex-state.json';

// Самолечение сессии: паспорт периодически требует «освежить» вход в Директ (cause=auth)
// и показывает список аккаунтов, хотя сессия жива (Метрика с тем же state работает).
// Кликаем свой аккаунт и пересохраняем storageState. Фикс 2026-07-29.
async function ensureAuth(p, ctx, out) {
  if (!/passport\.yandex|\/auth\//.test(p.url())) return true;
  const acc = p.locator('text=fabrika.mari').first();
  if (!(await acc.count().catch(() => 0))) { out.sessionExpired = true; return false; }
  await acc.click().catch(() => {});
  await p.waitForTimeout(9000);
  if (/direct\.yandex\.ru/.test(p.url())) {
    try { fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak'); } catch (_) {}
    await ctx.storageState({ path: STATE_FILE });
    out.reloggedIn = true;
    return true;
  }
  out.sessionExpired = true;
  return false;
}

function parseNum(s) {
  if (!s) return null;
  const m = String(s).replace(/ /g, ' ').match(/-?\d[\d\s]*(?:[.,]\d+)?/);
  if (!m) return null;
  return parseFloat(m[0].replace(/\s/g, '').replace(',', '.')) || null;
}

// helper для парсинга одной числовой строки в SPA-гриде
function parseOne(s) {
  if (!s) return null;
  const m = String(s).replace(/[^\d.,\- ]/g, ' ').match(/-?\d[\d ]*(?:[.,]\d+)?/);
  return m ? parseFloat(m[0].replace(/ /g, '').replace(',', '.')) : null;
}

// —— Календарь периода (порт из scrape-direct-history.js, 2026-07-29) ——
// Дашборд ждёт от direct.json ИМЕННО month-to-date текущего месяца (см. web/app.js
// «ВАЖНО: снимок direct.json — ВСЕГДА текущий месяц»), поэтому свежему отчёту
// (без сохранённого state) период выставляем календарём: 1-е число .. сегодня.
const NOM = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const clickSel = (p, sel) => p.locator(sel).first().click({ force: true, noWaitAfter: true, timeout: 5000 }).then(() => true).catch(() => false);
const NEXT = '[data-testid="DateRangeSelect.RangeCalendarWithButton.RangeCalendar.next"]';
const PREV = '[data-testid="DateRangeSelect.RangeCalendarWithButton.RangeCalendar.prev"]';
const CALBTN = '[data-testid="DateRangeSelect.RangeCalendarWithButton.Calendar"]';
const monthsVisible = p => p.evaluate(() => [...document.querySelectorAll('table.dc-CalendarGrid')].map(t => t.getAttribute('aria-label') || ''));
const isDisabled = (p, sel) => p.evaluate(s => { const e = document.querySelector(s); return !e || e.disabled || /_disabled/.test(e.className); }, sel);

async function setMonthRange(p, m, lastDay) {
  const yr = new Date().getFullYear();
  if (!(await clickSel(p, CALBTN))) return false;
  await p.waitForTimeout(800);
  let g = 0; while (g++ < 14) { if (await isDisabled(p, NEXT)) break; await clickSel(p, NEXT); await p.waitForTimeout(450); }
  let found = false; g = 0;
  while (g++ < 14) {
    const ms = await monthsVisible(p);
    if (ms.some(x => new RegExp('^' + NOM[m] + ' ' + yr, 'i').test(x.trim()))) { found = true; break; }
    await clickSel(p, PREV); await p.waitForTimeout(450);
  }
  if (!found) { await p.keyboard.press('Escape').catch(() => {}); return false; }
  const tbl = `table.dc-CalendarGrid[aria-label*="${NOM[m]} ${yr}"]`;
  const c1 = await clickSel(p, `${tbl} [aria-label*=", 1 ${GEN[m]} ${yr} г."]`); await p.waitForTimeout(450);
  const c2 = await clickSel(p, `${tbl} [aria-label*=", ${lastDay} ${GEN[m]} ${yr} г."]`); await p.waitForTimeout(700);
  await p.keyboard.press('Escape').catch(() => {});
  if (!c1 || !c2) return false;
  const mm = String(m + 1).padStart(2, '0');
  const ok = await p.waitForFunction((mm) => {
    const t = document.body.innerText || ''; const i = t.indexOf('Итого');
    return i >= 0 && /\d[\d  ]*[.,]?\d*\s*₽/.test(t.slice(i, i + 200)) && new RegExp('\\.' + mm + '\\.' + new Date().getFullYear() + ',').test(t);
  }, mm, { timeout: 22000 }).then(() => true).catch(() => false);
  await p.waitForTimeout(1200);
  return ok;
}

(async () => {
  const out = { scrapedAt: new Date().toISOString(), source: 'yandex-direct' };
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ storageState: '/opt/2gis-scraper/yandex-state.json', locale: 'ru-RU', viewport: { width: 1500, height: 1800 } });
  const p = await ctx.newPage();
  try { await p.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { out.error = 'goto: ' + e.message; }
  await p.waitForTimeout(5000);
  const authed = await ensureAuth(p, ctx, out);
  if (authed) {
    // свежий отчёт открывается с пустым периодом — выставляем календарём
    // month-to-date (1-е..сегодня): дашборд ждёт от direct.json текущий месяц
    const now = new Date();
    out.rangeApplied = await setMonthRange(p, now.getMonth(), now.getDate());
    // ждём пока SPA-грид нарисует строку «Итого» И число с ₽ после неё —
    // иначе SPA отрисовал только плейсхолдер
    try {
      await p.waitForFunction(() => {
        const t = document.body && document.body.innerText || '';
        const i = t.indexOf('Итого');
        return i >= 0 && /\d[\d  ]*[.,]?\d*\s*₽/.test(t.slice(i, i + 600));
      }, { timeout: 40000 });
    } catch (_) { out.gridTimeout = true; }
    await p.waitForTimeout(2500);
  }
  if (!authed) { /* sessionExpired уже выставлен в ensureAuth */ }
  else {
    // Из body тянем «Итого» строку: «<period> Итого <расход> <показы> <клики> <конверсии> <CR%> <CPA>»
    const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
    out.bodyLen = body.length;
    // Период наверху отчёта: «01 – 26 мая 2026» или «01.05 – 26.05.2026»
    const periodM = body.match(/(\d{1,2}[ .]\D*\d{0,2}\D*\d{4})\s*–\s*(\d{1,2}[ .]\D*\d{0,2}\D*\d{4})/) || body.match(/(\d{2}\.\d{2}\.\d{4})\s*–\s*(\d{2}\.\d{2}\.\d{4})/);
    if (periodM) out.period = periodM[0];
    // Итого: ищем строку «Итого» и забираем 6 чисел после неё (расход ₽, показы, клики, конверсии, CR%, CPA ₽)
    const it = body.indexOf('Итого');
    if (it >= 0) {
      const tail = body.slice(it, it + 600).replace(/ /g, ' ');
      // Числа отрендерены каждое на отдельной строке. Берём первые 6 «числовых» строк.
      const lineNum = /^\s*-?\d[\d ]*(?:[.,]\d+)?\s*(?:₽|%)?\s*$/;
      const rawNums = tail.split('\n').map(s => s.trim()).filter(s => lineNum.test(s)).slice(0, 6);
      const parseOne = (s) => { if (!s) return null; const m = String(s).match(/-?\d[\d ]*(?:[.,]\d+)?/); return m ? parseFloat(m[0].replace(/ /g, '').replace(',', '.')) : null; };
      out.totals = { raw: rawNums };
      out.totals.spend = parseOne(rawNums[0]);
      out.totals.impressions = parseOne(rawNums[1]);
      out.totals.clicks = parseOne(rawNums[2]);
      out.totals.conversions = parseOne(rawNums[3]);
      out.totals.crPct = parseOne(rawNums[4]);
      out.totals.cpa = parseOne(rawNums[5]);
      if (out.totals.spend && out.totals.clicks) out.totals.cpc = Math.round(out.totals.spend / out.totals.clicks * 100) / 100;
      if (out.totals.clicks && out.totals.impressions) out.totals.ctrPct = Math.round(out.totals.clicks / out.totals.impressions * 1000) / 10;
    }
    // Баланс счёта обычно в верху страницы — «<число> ₽» рядом с «Пополнить» / username
    const balM = body.match(/(\d[\d\s]*[.,]\d{2})\s*₽/);
    if (balM) out.balance = parseNum(balM[1]);

    // По кампаниям: инкрементально скроллим виртуализованный грид, собираем все «day×campaign» строки.
    // Каждый блок ровно 10 строк: дата / id / имя / статус / расход / показы / клики / конверсии / CR / CPA
    const seen = new Map(); // ключ = дата+id (чтобы не дублировать при перекрытии)
    function parseRows(body) {
      const lines = body.split('\n').map(s => s.trim());
      for (let i = 0; i < lines.length - 9; i++) {
        if (!/^\d{2}\.\d{2}\.\d{4},/.test(lines[i])) continue;
        // Порядок колонок гуляет: старый сохранённый отчёт = «дата/№/имя/статус»,
        // свежий (2026-07) = «дата/имя/№/статус». Определяем id по 8+ цифрам.
        let id, name;
        if (/^\d{8,}$/.test(lines[i + 1])) { id = lines[i + 1]; name = lines[i + 2]; }
        else if (/^\d{8,}$/.test(lines[i + 2])) { name = lines[i + 1]; id = lines[i + 2]; }
        else continue;
        const key = lines[i] + '|' + id;
        if (seen.has(key)) continue;
        seen.set(key, {
          date: lines[i], id, name, status: lines[i + 3],
          spend: parseOne(lines[i + 4]), impressions: parseOne(lines[i + 5]),
          clicks: parseOne(lines[i + 6]), conversions: parseOne(lines[i + 7]),
          crPct: parseOne(lines[i + 8]), cpa: parseOne(lines[i + 9])
        });
      }
    }
    parseRows(body);
    let attempts = 0, lastSize = -1, scrolls = 0;
    while (scrolls < 40 && attempts < 5) {
      const grew = await p.evaluate(() => {
        const els = [...document.querySelectorAll('*')].filter(el => {
          const s = window.getComputedStyle(el);
          return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 100;
        });
        els.sort((a, b) => b.scrollHeight - a.scrollHeight);
        let did = false;
        for (const el of els.slice(0, 3)) {
          const before = el.scrollTop;
          el.scrollTop += Math.round(el.clientHeight * 0.7);
          if (el.scrollTop > before) did = true;
        }
        window.scrollBy(0, 800);
        return did;
      });
      await p.waitForTimeout(1400);
      const b2 = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
      parseRows(b2);
      scrolls += 1;
      if (seen.size === lastSize) attempts += 1; else attempts = 0;
      lastSize = seen.size;
      if (!grew) attempts += 1;
    }
    out.dayCampaignRows = seen.size;

    // Аггрегируем по кампаниям
    const camp = new Map();
    for (const r of seen.values()) {
      if (!camp.has(r.id)) camp.set(r.id, { id: r.id, name: r.name, status: r.status, spend: 0, impressions: 0, clicks: 0, conversions: 0, days: 0 });
      const a = camp.get(r.id);
      a.spend += r.spend || 0; a.impressions += r.impressions || 0; a.clicks += r.clicks || 0; a.conversions += r.conversions || 0; a.days += 1;
    }
    out.campaigns = [...camp.values()].map(c => ({
      ...c,
      spend: Math.round(c.spend * 100) / 100,
      cpa: c.conversions ? Math.round(c.spend / c.conversions) : null,
      cpc: c.clicks ? Math.round(c.spend / c.clicks * 100) / 100 : null,
      ctrPct: c.impressions ? Math.round(c.clicks / c.impressions * 1000) / 10 : null,
      crPct: c.clicks ? Math.round(c.conversions / c.clicks * 1000) / 10 : null
    })).sort((a, b) => b.spend - a.spend);
  }
  await b.close();
  try { fs.mkdirSync('/opt/marketing-data', { recursive: true }); } catch (_) {}
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, sessionExpired: !!out.sessionExpired, period: out.period || null, totals: out.totals || null, balance: out.balance || null, dayCampaignRows: out.dayCampaignRows || 0, campaigns: (out.campaigns || []).length, error: out.error || null }));
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
