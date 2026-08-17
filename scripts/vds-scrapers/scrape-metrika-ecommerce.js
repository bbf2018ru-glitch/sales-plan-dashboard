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
  let networkAttribution = null;
  page.on('response', async response => {
    const url = response.url();
    if (!/metrika\.yandex\.(?:ru|com)\/api\/metrika/i.test(url)) return;
    const type = response.request().resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    try {
      const json = await response.json();
      const data = json && json.data && json.data.stat2Data && json.data.stat2Data.data;
      if (data && Array.isArray(data.items) && data.items.some(item => Array.isArray(item.metrics) && item.metrics.length >= 2)) {
        networkAttribution = data;
      }
    } catch (_) {}
  });
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
    // В отчёте с UTM-разрезом Метрика называет рекламный источник по-разному:
    // «Переходы по рекламе», «Директ», direct или yandex.
    const paid = rowAfter(lines, /^(Переходы по рекламе|Директ|direct|yandex)$/i);
    const gis = rowAfter(lines, /^2gis$/i);
    const total = rowAfter(lines, /^Итого и средние$/i) || rowAfter(lines, /^Всего$/i);
    Object.assign(out, paid || { purchases: null, purchaseRevenue: null });
    // Строка «Переходы по рекламе» — покупки и доход именно рекламного
    // трафика (Директ), если в Метрике настроена ecommerce-цель.
    out.direct = paid || null;
    if (out.direct && out.direct.purchases > 0 && out.direct.purchaseRevenue != null && out.direct.purchaseRevenue < out.direct.purchases * 100) {
      out.directWarning = 'Строка Директа загрузилась неполностью; доход не публикуем';
      out.direct = { purchases: out.direct.purchases, purchaseRevenue: null };
      out.purchaseRevenue = null;
    }
    // Если строка источника отсутствует в полностью загруженном отчёте,
    // это означает ноль покупок, а не неизвестное значение.
    out.utm2gis = gis || (total || paid ? { purchases: 0, purchaseRevenue: 0 } : null);
    if (gis && gis.purchases > 0 && gis.purchaseRevenue != null && gis.purchaseRevenue < gis.purchases * 100) {
      out.utm2gisWarning = 'Подозрительно низкая выручка в строке UTM; значение не публикуем';
      out.utm2gis = period.ym === new Date().toISOString().slice(0, 7) ? null : { purchases: 0, purchaseRevenue: 0 };
    }
    out.total = total;
    out.hasEcommerceRows = !!(paid || total);

    // Надёжный источник — JSON, которым сама таблица Метрики заполняет строки.
    // metrics: [Количество покупок, Доход]. Объединяем алиасы Директа,
    // а 2gis оставляем отдельным каналом.
    if (networkAttribution && Array.isArray(networkAttribution.items)) {
      const bySource = {};
      for (const item of networkAttribution.items) {
        const key = String(item.statDataId || item.dimensions?.[0]?.name || '').toLowerCase();
        if (!key || !Array.isArray(item.metrics)) continue;
        bySource[key] = { purchases: Number(item.metrics[0]) || 0, purchaseRevenue: Number(item.metrics[1]) || 0 };
      }
      const directKeys = ['yandex', 'geoadv_direct', 'ya'];
      const direct = directKeys.reduce((a, key) => ({ purchases: a.purchases + (bySource[key]?.purchases || 0), purchaseRevenue: a.purchaseRevenue + (bySource[key]?.purchaseRevenue || 0) }), { purchases: 0, purchaseRevenue: 0 });
      if (direct.purchases || direct.purchaseRevenue) {
        out.purchases = direct.purchases;
        out.purchaseRevenue = direct.purchaseRevenue;
        out.direct = direct;
        delete out.directWarning;
      }
      if (bySource['2gis']) out.utm2gis = bySource['2gis'];
      if (networkAttribution.metricsTotals && Array.isArray(networkAttribution.metricsTotals.metrics)) {
        out.total = { purchases: Number(networkAttribution.metricsTotals.metrics[0]) || 0, purchaseRevenue: Number(networkAttribution.metricsTotals.metrics[1]) || 0 };
      }
    }

    // В совместном отчёте SPA иногда рисует только покупки. Повторяем запрос
    // только с метрикой «Доход», чтобы получить сумму по UTM-источникам.
    try {
      const revenueUrl = reportUrl(period).replace('%5B%5B%22ym%3As%3AecommercePurchases%22%5D%2C%5B%22ym%3As%3AecommerceRevenue%22%5D%5D', '%5B%5B%22ym%3As%3AecommerceRevenue%22%5D%5D');
      await p.goto(revenueUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForTimeout(12000);
      const rb = await p.evaluate(() => document.body ? document.body.innerText : '');
      const rl = rb.split('\n').map(s => s.trim()).filter(Boolean);
      const revRows = [
        rowAfter(rl, /^yandex$/i),
        rowAfter(rl, /^geoadv_direct$/i),
        rowAfter(rl, /^ya$/i)
      ].filter(Boolean);
      const directRevenue = revRows.reduce((sum, x) => sum + (x.purchaseRevenue || 0), 0);
      if (directRevenue > 0) {
        out.purchaseRevenue = directRevenue;
        out.direct = Object.assign({}, out.direct || {}, { purchaseRevenue: directRevenue });
      }
    } catch (_) { /* основной отчёт остаётся доступным даже при сбое второго */ }
  }
  await browser.close();
  fs.mkdirSync('/opt/marketing-data', { recursive: true });
  // Latest-файл всегда относится к текущему месяцу; исторический запуск
  // (TARGET_YM=прошлый месяц) обновляет только history и не затирает live.
  if (period.ym === new Date().toISOString().slice(0, 7)) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch (_) {}
  const previous = history.find(x => x.ym === period.ym);
  const stableUtm2gis = out.utm2gis || (previous && previous.utm2gis) || null;
  const entry = { ym: period.ym, purchases: out.purchases, purchaseRevenue: out.purchaseRevenue, direct: out.direct || (previous && previous.direct) || null, utm2gis: stableUtm2gis, scrapedAt: out.scrapedAt };
  const index = history.findIndex(x => x.ym === entry.ym);
  if (index >= 0) history[index] = entry; else history.push(entry);
  history.sort((a, b) => a.ym.localeCompare(b.ym));
  fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2));
  console.log(JSON.stringify({ ok: true, ym: period.ym, purchases: out.purchases, purchaseRevenue: out.purchaseRevenue, utm2gis: out.utm2gis || null, hasRows: out.hasEcommerceRows, sessionExpired: !!out.sessionExpired }));
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
