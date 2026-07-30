// Серверный скрейпер Я.Метрики (живёт на VDS: /opt/2gis-scraper/scrape-metrika.js).
// Режимы:
//   - без ENV → текущий период (last_four_weeks), пишет metrika.json + добавляет в history
//   - METRIKA_PERIOD=YYYY-MM → конкретный месяц, пишет ТОЛЬКО в metrika-history.json
//     (используется warm-loop'ом для подкачки истории с янв 2025)
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const OUT_LATEST = '/opt/marketing-data/metrika.json';
const OUT_HISTORY = '/opt/marketing-data/metrika-history.json';
const COUNTER = '43949414'; // Фабрика Мария

function periodFourWeeks() {
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const startD = new Date(today.getTime() - 27 * 24 * 3600 * 1000);
  return { start: startD.toISOString().slice(0, 10), end, preset: 'four_weeks', label: 'последние 28 дней', ym: end.slice(0, 7) };
}

function periodForMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  // последний день месяца
  const last = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { start, end, preset: 'manual', label: ym, ym };
}

function parseVisits(s) {
  if (!s) return null;
  const t = String(s).trim();
  const m1 = t.match(/^([\d,.]+)\s*тыс\.?$/i);
  if (m1) return Math.round(parseFloat(m1[1].replace(',', '.')) * 1000);
  const m2 = t.match(/^([\d,.]+)\s*млн\.?$/i);
  if (m2) return Math.round(parseFloat(m2[1].replace(',', '.')) * 1000000);
  const m3 = t.match(/^([\d\s ]+)$/);
  if (m3) { const n = parseInt(m3[1].replace(/[\s ]/g, ''), 10); return isFinite(n) ? n : null; }
  return null;
}
function parseNum(s) { return parseVisits(s); }

function normalizeSource(name) {
  const s = (name || '').toLowerCase();
  if (/поиск/.test(s)) return 'Поиск (SEO)';
  if (/прям/.test(s)) return 'Прямые';
  if (/реклам/.test(s) || /контекст/.test(s)) return 'Реклама';
  if (/ссыл/.test(s)) return 'Ссылки';
  if (/внутр/.test(s)) return 'Внутренние';
  if (/мессендж/.test(s)) return 'Мессенджеры';
  if (/социальн|соцсет/.test(s)) return 'Соцсети';
  if (/рекоменд/.test(s)) return 'Рекомендации';
  if (/email|почт/.test(s)) return 'Email';
  return name || '—';
}

function buildUrl(per) {
  // Для manual режима добавляем date1/date2; для four_weeks — preset.
  const dateParams = per.preset === 'manual'
    ? '&period=manual&date1=' + per.start + '&date2=' + per.end
    : '&period=' + per.preset;
  return 'https://metrika.yandex.ru/stat/new?id=' + COUNTER +
    dateParams +
    '&group=day' +
    '&selectedDimensionKeys=%5B%5B%22ym%3As%3A%3Cattribution%3ETrafficSource%22%5D%5D' +
    '&tableMetrics=%5B%5B%22ym%3As%3Avisits%22%5D%5D' +
    '&view=Linear&chartView=Line&table=visits' +
    '&attr=%7B%22attributionId%22%3A%22LastSign%22%2C%22isCrossDevice%22%3Atrue%7D' +
    '&sortBy=-ym%3As%3Avisits&showTotal=true' +
    '&isMinSamplingEnabled=false&currency=RUB&isUndefinedEnabled=false' +
    '&chartMetrics=%5B%5B%22ym%3As%3Avisits%22%5D%5D' +
    '&metricValueMode=Absolute&screenMode=Default';
}

(async () => {
  const out = { scrapedAt: new Date().toISOString(), source: 'yandex-metrika' };
  const envPeriod = (process.env.METRIKA_PERIOD || '').trim();
  const per = envPeriod && /^\d{4}-\d{2}$/.test(envPeriod) ? periodForMonth(envPeriod) : periodFourWeeks();
  out.period = per;
  const URL = buildUrl(per);
  out.url = URL;

  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ storageState: '/opt/2gis-scraper/yandex-state.json', locale: 'ru-RU', viewport: { width: 1600, height: 2000 } });
  const p = await ctx.newPage();

  // Prewarm: SSO sync через metrika.yandex.ru/list (без этого первый запрос на /stat/new часто
  // редиректит на sso.ya.ru/sync и таблица не рендерится)
  try {
    await p.goto('https://metrika.yandex.ru/list', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p.waitForTimeout(4000);
    // Если попали на passport — релогин нужен
    if (/passport\.yandex/.test(p.url())) { out.sessionExpired = true; await b.close(); console.log(JSON.stringify({ ok: false, sessionExpired: true })); return; }
  } catch (e) { out.prewarmError = e.message; }

  try { await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { out.error = 'goto: ' + e.message; }
  try {
    await p.waitForFunction(() => {
      const t = (document.body && document.body.innerText) || '';
      return /(Переходы из|Прямые заходы|Внутренние переходы|Социальные сети|Переходы по ссылкам)/.test(t) &&
        (t.match(/\d{3,}/g) || []).length >= 3;
    }, { timeout: 100000 }); // 60с не хватало на нагруженной VM в кроновский час → ложный gridTimeout при полных данных (2026-07-29)
  } catch (_) { out.gridTimeout = true; }
  try { await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch (_) {}
  await p.waitForTimeout(4000);
  try { await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch (_) {}
  await p.waitForTimeout(2000);

  const url = p.url();
  if (/passport\.yandex|\/auth\//.test(url)) { out.sessionExpired = true; }
  else {
    // Прокручиваем чтобы виртуализированная таблица догрузилась
    for (let i = 0; i < 6; i++) { try { await p.evaluate(() => window.scrollBy(0, 600)); } catch (_) {} await p.waitForTimeout(500); }
    try { await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch (_) {}
    await p.waitForTimeout(2500);

    const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
    out.bodyLen = body.length;
    const lines = body.split('\n').map(s => s.trim()).filter(Boolean);

    // Inline-формат: «Имя источника» → СЛЕДУЮЩАЯ строка число (визиты) → СЛЕДУЮЩАЯ строка процент.
    const SRC_NAMES = [
      'Переходы из поисковых систем', 'Переходы по рекламе', 'Прямые заходы',
      'Переходы по ссылкам на сайтах', 'Внутренние переходы', 'Переходы из социальных сетей',
      'Переходы из рекомендательных систем', 'Переходы из мессенджеров',
      'Переходы по email-рассылкам', 'Переходы с сохранённых страниц'
    ];
    const grouped = {};
    for (let i = 0; i < lines.length; i++) {
      const srcName = SRC_NAMES.find(n => lines[i] === n);
      if (!srcName) continue;
      const v = parseVisits(lines[i + 1] || '');
      if (v != null && v > 0) {
        const k = normalizeSource(srcName);
        if (!grouped[k] || v > grouped[k]) grouped[k] = v;
      }
    }
    // Итого — после строки «Итого и средние»
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^Итого и средние$/i.test(lines[i])) { const t = parseVisits(lines[i + 1] || ''); if (t != null) { total = t; break; } }
    }
    if (!total) total = Object.values(grouped).reduce((a, c) => a + c, 0);

    const sources = Object.entries(grouped)
      .map(([name, visits]) => ({ name, visits, sharePct: total ? Math.round(visits / total * 1000) / 10 : 0 }))
      .sort((a, b) => b.visits - a.visits);
    out.sources = sources;
    out.totalVisits = total;
  }

  await b.close();

  try { fs.mkdirSync('/opt/marketing-data', { recursive: true }); } catch (_) {}

  // Текущий период (без ENV) пишем в latest, чтобы существующий API ничего не сломал.
  if (!envPeriod) {
    fs.writeFileSync(OUT_LATEST, JSON.stringify(out, null, 2));
  }

  // В history добавляем/обновляем entry по ym.
  if (out.totalVisits != null && !out.sessionExpired) {
    let history = [];
    try { history = JSON.parse(fs.readFileSync(OUT_HISTORY, 'utf8')); } catch (_) {}
    const entry = {
      ym: per.ym,
      period: { start: per.start, end: per.end, label: per.label },
      totalVisits: out.totalVisits,
      sources: out.sources,
      scrapedAt: out.scrapedAt
    };
    const idx = history.findIndex(h => h.ym === per.ym);
    if (idx >= 0) history[idx] = entry; else history.push(entry);
    history.sort((a, b) => a.ym.localeCompare(b.ym));
    fs.writeFileSync(OUT_HISTORY, JSON.stringify(history, null, 2));
  }

  console.log(JSON.stringify({ ok: true, ym: per.ym, sessionExpired: !!out.sessionExpired, period: out.period, totalVisits: out.totalVisits || null, sources: (out.sources || []).length, error: out.error || null, gridTimeout: !!out.gridTimeout }));
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
