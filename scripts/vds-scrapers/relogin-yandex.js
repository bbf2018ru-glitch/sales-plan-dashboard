// Автоматический релогин в Яндекс (passport) для Метрики и Я.Директа.
// Креды: /opt/2gis-scraper/.env-yandex (chmod 600, формат KEY=VALUE на строку).
// По cron в 05:40 (за 50 мин до scrape-metrika, scrape-direct).
// Результат: свежий /opt/2gis-scraper/yandex-state.json.
const fs = require('fs');
const path = require('path');
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');

const ENV_PATH = '/opt/2gis-scraper/.env-yandex';
const STATE_PATH = '/opt/2gis-scraper/yandex-state.json';

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) { console.log('NO ENV FILE', ENV_PATH); process.exit(1); }
  const txt = fs.readFileSync(ENV_PATH, 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return env;
}

(async () => {
  const env = readEnv();
  const LOGIN = env.YANDEX_LOGIN || env.YANDEX_EMAIL || '';
  const PASS = env.YANDEX_PASS || '';
  if (!LOGIN || !PASS) { console.log('NO CREDS in', ENV_PATH); process.exit(1); }

  const b = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU']
  });
  const ctx = await b.newContext({
    locale: 'ru-RU', viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  const p = await ctx.newPage();

  // Заходим через классический URL, минуя pwl-yandex (passwordless flow форсит magic-link)
  try { await p.goto('https://passport.yandex.ru/auth/welcome?from=passport&retpath=https%3A%2F%2Fmetrika.yandex.ru%2Flist', { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { console.log('goto', e.message); }
  await p.waitForTimeout(4000);
  console.log('URL after goto:', p.url());

  // Yandex pwl-flow форсит телефон. Кликаем «Почта» → если попали на телефонную форму,
  // кликаем «Ещё» → дальше «Войти с паролем» / «Логин и пароль».
  let loginInput = await p.$('input[name="login"],input[type="email"],#passp-field-login');
  if (!loginInput) {
    console.log('multi-method UI — clicking «Почта»');
    try {
      const el = p.getByText('Почта', { exact: true });
      if (await el.count().catch(() => 0) > 0) {
        await el.first().click({ timeout: 4000 });
        await p.waitForTimeout(2500);
      }
    } catch (_) {}
  }
  // Если оказались на телефонной форме (input[type=tel]) — раскрываем «Ещё» → «Войти с паролем»
  const isPhonePage = await p.evaluate(() => /Введите номер телефона/i.test(document.body ? document.body.innerText : ''));
  if (isPhonePage) {
    console.log('phone page detected — clicking «Ещё»');
    try {
      const more = p.getByText('Ещё', { exact: true });
      if (await more.count().catch(() => 0) > 0) {
        await more.first().click({ timeout: 4000 });
        await p.waitForTimeout(2500);
      }
    } catch (e) { console.log('Ещё click warn', e.message); }
    // Дополнительные методы — ищем «Войти с паролем» / «Логин и пароль» / «Войти по логину»
    try {
      for (const txt of ['Войти с паролем', 'Логин и пароль', 'Войти по логину', 'Пароль', 'Использовать пароль']) {
        const el = p.getByText(txt, { exact: false });
        if (await el.count().catch(() => 0) > 0) {
          await el.first().click({ timeout: 4000 });
          await p.waitForTimeout(2500);
          break;
        }
      }
    } catch (e) { console.log('alt-method click warn', e.message); }
  }
  loginInput = await p.$('input[name="login"],input[type="email"],#passp-field-login,input[placeholder*="ogin" i],input[placeholder*="огин" i],input[placeholder*="очта" i]');
  if (!loginInput) {
    const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
    const inputs = await p.evaluate(() => [...document.querySelectorAll('input')].map(i => ({ name: i.name, type: i.type, placeholder: i.placeholder })));
    const buttons = await p.evaluate(() => [...document.querySelectorAll('button,[role=button],a')].map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(t => t && t.length < 60));
    console.log('NO login field after «Ещё». body head:', body.slice(0, 500));
    console.log('available inputs:', JSON.stringify(inputs));
    console.log('available buttons:', JSON.stringify(buttons.slice(0, 30)));
    await b.close(); process.exit(1);
  }
  await loginInput.fill(LOGIN);
  await p.waitForTimeout(500);

  // Кнопка «Войти»/«Продолжить»
  try {
    const next = await p.$('button[type=submit],button:has-text("Войти"),button:has-text("Продолжить")');
    if (next) await next.click();
    else await loginInput.press('Enter');
  } catch (e) { console.log('submit-login err', e.message); }
  await p.waitForTimeout(3500);

  // Поле пароля — поле может быть с задержкой рендера, ждём явно
  let passInput = null;
  for (let i = 0; i < 6; i++) {
    passInput = await p.$('input[type=password],input[name="passwd"],input[name="password"],#passp-field-passwd,input[placeholder*="ароль" i],input[aria-label*="ароль" i]');
    if (passInput) break;
    await p.waitForTimeout(1500);
  }
  if (!passInput) {
    const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
    const inputs = await p.evaluate(() => [...document.querySelectorAll('input')].map(i => ({ name: i.name, type: i.type, placeholder: i.placeholder, aria: i.getAttribute('aria-label') })));
    console.log('NO password field. URL:', p.url(), 'body:', body.slice(0, 400));
    console.log('inputs on page:', JSON.stringify(inputs));
    await b.close(); process.exit(1);
  }
  await passInput.fill(PASS);
  await p.waitForTimeout(500);
  try {
    const submit = await p.$('button[type=submit],button:has-text("Войти")');
    if (submit) await submit.click();
    else await passInput.press('Enter');
  } catch (e) { console.log('submit-pass err', e.message); }
  await p.waitForTimeout(5000);

  // Если Yandex переключил на magic-flow (QR/SMS/magic-link), пробуем «Войти с паролем»
  let currUrl = p.url();
  if (/auth\/(magic|qr|sms)/i.test(currUrl)) {
    console.log('redirected to', currUrl, '— clicking «Войти с паролем»');
    try {
      const fb = p.getByText('Войти с паролем', { exact: false });
      if (await fb.count().catch(() => 0) > 0) {
        await fb.first().click({ timeout: 4000 });
        await p.waitForTimeout(3500);
        // снова ищем password field
        const passInput2 = await p.$('input[type=password],input[name="passwd"],input[name="password"],#passp-field-passwd');
        if (passInput2) {
          await passInput2.fill(PASS);
          await p.waitForTimeout(400);
          const sub2 = await p.$('button[type=submit],button:has-text("Войти")');
          if (sub2) await sub2.click(); else await passInput2.press('Enter');
          await p.waitForTimeout(6000);
        }
      }
    } catch (e) { console.log('fallback click warn', e.message); }
  }

  // Проверка успеха
  const finalUrl = p.url();
  console.log('final URL:', finalUrl);
  const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
  if (/passport\.yandex/.test(finalUrl) && !/profile/.test(finalUrl)) {
    console.log('LOGIN FAILED. body head:', body.slice(0, 500));
    // Дополнительный диагноз: есть ли 2FA?
    if (/код из (СМС|приложен|sms)|двухфакторн|подтверждени/i.test(body)) {
      console.log('==> Возможно включена 2FA. Без отключения релогин невозможен автоматически.');
    }
    await b.close(); process.exit(1);
  }

  // Подтверждаем что Метрика открывается
  try {
    await p.goto('https://metrika.yandex.ru/list', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(3000);
    const metrikaUrl = p.url();
    if (/passport|auth/.test(metrikaUrl)) {
      console.log('METRIKA REDIRECT TO AUTH:', metrikaUrl);
      await b.close(); process.exit(1);
    }
    console.log('Metrika OK:', metrikaUrl);
  } catch (e) { console.log('metrika check warn', e.message); }

  // Сохраняем состояние
  await ctx.storageState({ path: STATE_PATH });
  fs.chmodSync(STATE_PATH, 0o600);
  console.log('OK state saved:', STATE_PATH);
  await b.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
