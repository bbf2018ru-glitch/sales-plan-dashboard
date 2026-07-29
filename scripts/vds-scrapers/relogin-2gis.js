// Автоматический релогин в 2ГИС (для cron на VDS).
// Креды: /opt/2gis-scraper/.env-2gis (chmod 600, формат KEY=VALUE на строку).
// Запускается по cron в 05:50 — за 10 мин до основного скрейпа.
// Результат: свежий /opt/2gis-scraper/2gis-state.json.

const fs = require('fs');
const path = require('path');
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');

const ENV_PATH = '/opt/2gis-scraper/.env-2gis';
const STATE_PATH = '/opt/2gis-scraper/2gis-state.json';

function loadEnv() {
  try {
    const t = fs.readFileSync(ENV_PATH, 'utf8');
    const out = {};
    for (const line of t.split('\n')) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch (_) { return {}; }
}

(async () => {
  const env = loadEnv();
  const EMAIL = env.GIS_EMAIL || '';
  const PASS = env.GIS_PASS || '';
  const ORG_ID = env.GIS_ORG_ID || '1548649242829424';
  if (!EMAIL || !PASS) { console.log('[2gis-relogin]', new Date().toISOString(), 'ERR: missing creds in', ENV_PATH); process.exit(1); }

  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
  const p = await ctx.newPage();

  let phase = 'goto-login';
  try {
    await p.goto('https://account.2gis.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p.waitForTimeout(5000);

    phase = 'fill-email';
    const emailInput = await p.$('input[type=email],input[name=email],input[placeholder*=mail i]');
    if (!emailInput) throw new Error('email input not found');
    await emailInput.fill(EMAIL);
    await p.waitForTimeout(700);

    phase = 'submit-email';
    let next = await p.$('button:has-text("Продолжить"),button:has-text("Войти"),button[type=submit]');
    if (next) await next.click(); else await emailInput.press('Enter');
    await p.waitForTimeout(4000);

    phase = 'fill-password';
    const passInput = await p.$('input[type=password]');
    if (!passInput) throw new Error('password input not found');
    await passInput.fill(PASS);
    await p.waitForTimeout(500);

    phase = 'submit-password';
    const submit = await p.$('button:has-text("Войти"),button[type=submit]');
    if (submit) await submit.click(); else await passInput.press('Enter');
    await p.waitForTimeout(8000);

    phase = 'verify';
    // успех = ушли с корня account.2gis.com на конкретную страницу + нет формы входа
    const u = p.url();
    const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
    const onLogin = /Забыли пароль|СберБизнес ID|Зарегистрироваться/.test(body) || /account\.2gis\.com\/(?:\?|$)/.test(u);
    if (onLogin) throw new Error('still on login after submit, url=' + u);

    phase = 'cabinet-check';
    await p.goto('https://account.2gis.com/orgs/' + ORG_ID + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(5000);
    const body2 = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
    if (!/Моя компания|Реклама в 2ГИС|Статистика/.test(body2)) throw new Error('cabinet page not loaded; body head: ' + body2.slice(0, 200));

    phase = 'save-state';
    // Атомарная замена: сохранить во временный файл и переименовать.
    const tmp = STATE_PATH + '.tmp';
    await ctx.storageState({ path: tmp });
    fs.renameSync(tmp, STATE_PATH);
    console.log('[2gis-relogin]', new Date().toISOString(), 'OK cookies saved to', STATE_PATH);
  } catch (e) {
    console.log('[2gis-relogin]', new Date().toISOString(), 'FAIL at phase=' + phase + ' err=' + e.message);
    await b.close().catch(() => {});
    process.exit(1);
  }
  await b.close();
})().catch(e => { console.log('[2gis-relogin]', new Date().toISOString(), 'FATAL', e.message); process.exit(1); });
