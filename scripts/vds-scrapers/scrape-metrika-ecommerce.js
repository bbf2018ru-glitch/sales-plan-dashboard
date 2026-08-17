// Ecommerce-покупки и доход рекламного трафика из Яндекс.Метрики.
// Источник сайта: dataLayer purchase, который отправляет кастомный Bitrix-компонент заказа.
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');

const COUNTER = '43949414';
const STATE = '/opt/2gis-scraper/yandex-state.json';
const OUT = '/opt/marketing-data/direct-ecommerce.json';
const HISTORY = '/opt/marketing-data/direct-ecommerce-history.json';
const NB = /[\u00a0\u202f\u2009\u2007]/g;

function metric(value) {
  const text = String(value || '').replace(NB, ' ').trim();
  const match = text.match(/-?\d[\d ]*(?:[.,]\d+)?/);
  if (!match) return null;
  let number = parseFloat(match[0].replace(/ /g, '').replace(',', '.'));
  if (/млн/i.test(text)) number *= 1000000;
  else if (/тыс/i.test(text)) number *= 1000;
  return isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function monthToDate() {
  const now = new Date();
  const requested = process.env.TARGET_YM;
  const ym = requested && /^\d{4}-\d{2}$/.test(requested) ? requested : now.toISOString().slice(0, 7);
  if (ym !== now.toISOString().slice(0, 7)) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { ym, from: ym + '-01', to: last };
  }
  return { ym, from: ym + '-01', to: now.toISOString().slice(0, 10) };
}

function reportUrl(period) {
  const range = encodeURIComponent(period.from + ':' + period.to);
  return 'https://metrika.yandex.ru/stat/new?id=' + COUNTER +
    '&period=' + range + '&group=day' +
    '&selectedDimensionKeys=%5B%5B%22ym%3As%3AlastUTMSource%22%5D%5D' +
    '&tableMetrics=%5B%5B%22ym%3As%3AecommercePurchases%22%5D%2C%5B%22ym%3As%3AecommerceRevenue%22%5D%5D' +
    '&view=Linear&chartView=Line&table=visits' +
    '&attr=%7B%22attributionId%22%3A%22LastSign%22%2C%22isCrossDevice%22%3Atrue%7D' +
    '&sortBy=-ym%3As%3AecommerceRevenue&showTotal=true' +
    '&isMinSamplingEnabled=false&currency=RUB&isUndefinedEnabled=false' +
    '&metricValueMode=Absolute&screenMode=Default';
}

function rowAfter(lines, pattern) {
  const index = lines.findIndex(line => pattern.test(line));
  if (index < 0) return null;
  const values = lines.slice(index + 1, index + 12)
    .filter(line => /^-?\d[\d\s.,]*(?:\s*(?:₽|тыс\.?|млн\.?)?)$/i.test(line) && !/%/.test(line));
  if (!values.length) return null;
  return { purchases: metric(values[0]), purchaseRevenue: values[1] == null ? null : metric(values[1]) };
}

(async () => {
  const period = monthToDate();
  const out = { scrapedAt: new Date().toISOString(), source: 'yandex-metrika-ecommerce', period };
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=ru-RU'] });
  const context = await browser.newContext({ storageState: STATE, locale: 'ru-RU', viewport: { width: 1600, height: 2000 } });
  const page = await context.newPage();
  await page.goto('https://metrika.yandex.ru/list', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => { out.prewarmError = e.message; });
  await page.waitForTimeout(3500);
  if (/passport\.yandex|\/auth\//.test(page.url())) out.sessionExpired = true;
  if (!out.sessionExpired) {
    await page.goto(reportUrl(period), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => { out.error = e.message; });
    await page.waitForFunction(() => /Количество покупок/.test(document.body.innerText || ''), { timeout: 90000 }).catch(() => { out.gridTimeout = true; });
    // При разрезе по UTM Метрика иногда отдаёт сначала неполную строку
    // (например, выручку «2» вместо «29 564»). Даём таблице догрузиться.
    await page.waitForTimeout(12000);
    for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {}); await page.waitForTimeout(600); }
    const body = await page.evaluate(() => document.body ? document.body.innerText : '');
    const lines = body.split('\n').map(s => s.trim()).filter(Boolean);
    const paid = rowAfter(lines, /^Переходы по рекламе$/i);
    const gis = rowAfter(lines, /^2gis$/i);
    const total = rowAfter(lines, /^Итого и средние$/i) || rowAfter(lines, /^Всего$/i);
    Object.assign(out, paid || { purchases: null, purchaseRevenue: null });
    // Если строка источника отсутствует в полностью загруженном отчёте,
    // это означает ноль покупок, а не неизвестное значение.
    out.utm2gis = gis || (total || paid ? { purchases: 0, purchaseRevenue: 0 } : null);
    if (gis && gis.purchases > 0 && gis.purchaseRevenue != null && gis.purchaseRevenue < gis.purchases * 100) {
      out.utm2gisWarning = 'Подозрительно низкая выручка в строке UTM; значение не публикуем';
      out.utm2gis = null;
    }
    out.total = total;
    out.hasEcommerceRows = !!(paid || total);
  }
  await browser.close();
  fs.mkdirSync('/opt/marketing-data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch (_) {}
  const previous = history.find(x => x.ym === period.ym);
  const stableUtm2gis = out.utm2gis || (previous && previous.utm2gis) || null;
  const entry = { ym: period.ym, purchases: out.purchases, purchaseRevenue: out.purchaseRevenue, utm2gis: stableUtm2gis, scrapedAt: out.scrapedAt };
  const index = history.findIndex(x => x.ym === entry.ym);
  if (index >= 0) history[index] = entry; else history.push(entry);
  history.sort((a, b) => a.ym.localeCompare(b.ym));
  fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2));
  console.log(JSON.stringify({ ok: true, ym: period.ym, purchases: out.purchases, purchaseRevenue: out.purchaseRevenue, utm2gis: out.utm2gis || null, hasRows: out.hasEcommerceRows, sessionExpired: !!out.sessionExpired }));
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
