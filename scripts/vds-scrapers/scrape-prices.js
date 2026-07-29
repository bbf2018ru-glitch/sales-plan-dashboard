// Скрейпер цен конкурентов (Стефания/Этика/Cake Home) → /opt/marketing-data/prices.json.
// Запускается по cron ежедневно 04:30.
// stefanycake.ru вешает networkidle — используем domcontentloaded.
// v2 (05.06.2026): + tort_gotovyj у всех + поле unit ('кг'|'шт'|null).
// v3 (24.06.2026): категория-значение может быть объектом {path, filter, unit} —
//   тогда тащим пары имя+цена с карточек и фильтруем по имени (filter regex).
//   Так берём макаронс Стефании из общей страницы десертов (отдельной категории нет).
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const OUT = '/opt/marketing-data/prices.json';

const TARGETS = {
  stefania: {
    base: 'https://stefanycake.ru',
    site: 'stefanycake.ru',
    name: 'Стефания',
    cats: {
      tort_zakaz: '/catalog/torty-na-zakaz/',
      tort_gotovyj: '/catalog/gotovyy-bento-tort/', // «Торты на каждый день» (slug обманчив), цены ₽/кг
      bento: '/catalog/bento-torty/',
      desserts: '/catalog/deserty-pirozhnye/',
      macarons: { path: '/catalog/deserty-pirozhnye/', filter: 'макарон', unit: 'шт' } // отдельной категории нет — фильтруем десерты
    }
  },
  etika: {
    base: 'https://etikacakes.ru',
    site: 'etikacakes.ru',
    name: 'Этика',
    cats: {
      tort_zakaz: '/s/torty-na-zakaz_2179',
      tort_gotovyj: '/s/standartnye-torty_2181', // готовые целые, цены ₽/шт (1-1.6 кг)
      bento: '/s/bento-tort-na-zakaz_2174',
      pirozhnoe: '/s/pirojnye_2178',
      kusochki: '/s/kusochki-tortov_2172',
      macarons: '/s/makarons_2175'
    }
  },
  cakehome: {
    base: 'https://cakehome.ru',
    site: 'cakehome.ru',
    name: 'Cake Home',
    cats: {
      // главная страница рендерит карточки тортов с ₽/кг (по-домашнему)
      tort_zakaz: '/',
      tort_gotovyj: '/catalog/cakes/' // готовые торты, цены ₽/кг (бенто/макаронс на сайте НЕТ)
    }
  }
};

// Matcher поддерживает форматы: «1 800» (с пробелом/NBSP), «2090» (без пробела до 5 цифр),
// валюту «₽» или «руб.» или «р.». Lookbehind (?<!\d) защищает от «9 1 800» → «9» + «1 800».
function makeRe(suffixPattern) {
  const PRICE = '(?<!\\d)(\\d{1,5}(?:[ \\u00A0]\\d{3})*)';
  return new RegExp(PRICE + suffixPattern, 'g');
}
const CUR = '(?:₽|руб\\.?|р\\.)'; // ₽ / руб / руб. / р.
const RE_KG = makeRe('\\s*' + CUR + '\\s*\\/\\s*кг');
const RE_SHT = makeRe('\\s*' + CUR + '\\s*\\/\\s*шт');
const RE_ANY = makeRe('\\s*' + CUR);

function extractPrices(text, expectedUnit) {
  const re = expectedUnit === 'кг' ? RE_KG : (expectedUnit === 'шт' ? RE_SHT : RE_ANY);
  const out = [];
  let m; re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1].replace(/[\s ]/g, ''), 10);
    if (n > 0 && n < 100000) out.push(n);
  }
  return out;
}

function extractWithUnit(text, order) {
  for (const u of order) {
    const nums = extractPrices(text, u);
    if (nums.length) return { nums, unit: u === 'any' ? null : u };
  }
  return { nums: [], unit: null };
}

// Пары имя+цена с карточек (для фильтрованных категорий типа макаронс-в-десертах).
async function extractCards(page) {
  return await page.evaluate(() => {
    const out = [], seen = new Set();
    document.querySelectorAll('*').forEach(function (el) {
      if (el.children.length > 4) return;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 5 || t.length > 120) return;
      if (!/(₽|руб|р\.)/.test(t)) return;
      const m = t.match(/^(.{3,90}?)\s*(\d{1,3}(?:[  ]\d{3})*|\d{3,5})\s*(?:₽|руб\.?|р\.)/);
      if (!m) return;
      const name = m[1].trim(), price = parseInt(m[2].replace(/\D/g, ''), 10);
      if (!/[А-я]/.test(name) || !(price > 50 && price < 100000)) return;
      const k = name.toLowerCase(); if (seen.has(k)) return; seen.add(k);
      out.push({ name: name, price: price });
    });
    return out;
  });
}

function summarize(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  let filt = nums;
  if (med >= 100) filt = nums.filter(n => n >= 50); // отсекаем заведомо мелочёвку (доставка/копейки)
  if (!filt.length) filt = nums;
  const s = [...filt].sort((a, b) => a - b);
  return { min: s[0], max: s[s.length - 1], median: s[Math.floor(s.length / 2)], count: s.length };
}

function fmt(s) {
  if (!s) return 'н/д';
  const u = s.unit ? ' ₽/' + s.unit : ' ₽';
  if (s.min === s.max) return s.min + u;
  return s.min + '–' + s.max + u;
}

const UNIT_ORDER = {
  tort_zakaz: ['кг', 'any'],
  tort_gotovyj: ['кг', 'шт', 'any'],
  bento: ['шт', 'any'],
};
const UNIT_DEFAULT = ['шт', 'any'];

(async () => {
  const out = { scrapedAt: new Date().toISOString(), source: 'competitor-sites', competitors: {} };
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 2400 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });

  for (const [key, conf] of Object.entries(TARGETS)) {
    const comp = { name: conf.name, site: conf.site, categories: {} };
    for (const [cat, def] of Object.entries(conf.cats)) {
      const path = typeof def === 'string' ? def : def.path;
      const filterRe = (def && typeof def === 'object' && def.filter) ? new RegExp(def.filter, 'i') : null;
      const forceUnit = (def && typeof def === 'object' && def.unit) ? def.unit : null;
      const p = await ctx.newPage();
      try { await p.goto(conf.base + path, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { comp.categories[cat] = { error: 'goto: ' + e.message }; await p.close(); continue; }
      await p.waitForTimeout(3500);
      try { await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch (_) { }
      await p.waitForTimeout(2500);
      try { await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch (_) { }
      await p.waitForTimeout(1500);

      let s = null;
      if (filterRe) {
        // фильтрованная категория: тащим карточки имя+цена, оставляем подходящие по имени
        const items = await extractCards(p);
        const prices = items.filter(x => filterRe.test(x.name)).map(x => x.price);
        s = summarize(prices);
        if (s) s.unit = forceUnit || 'шт';
      } else {
        const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
        const { nums, unit } = extractWithUnit(body, UNIT_ORDER[cat] || UNIT_DEFAULT);
        s = summarize(nums);
        if (s) s.unit = unit;
      }
      await p.close();
      comp.categories[cat] = s;
    }
    out.competitors[key] = comp;
  }

  await b.close();
  try { fs.mkdirSync('/opt/marketing-data', { recursive: true }); } catch (_) { }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  const summary = {};
  for (const [k, c] of Object.entries(out.competitors)) {
    summary[k] = {};
    for (const [cat, s] of Object.entries(c.categories)) summary[k][cat] = fmt(s);
  }
  console.log(JSON.stringify({ ok: true, summary }));
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
