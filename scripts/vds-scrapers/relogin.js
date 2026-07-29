
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
(async () => {
  const EMAIL = process.env.GIS_EMAIL || '';
  const PASS = process.env.GIS_PASS || '';
  if (!EMAIL || !PASS) { console.log('NO CREDS'); process.exit(1); }
  const b = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--lang=ru-RU'] });
  const ctx = await b.newContext({ locale:'ru-RU', viewport:{width:1440,height:900}, userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
  const p = await ctx.newPage();
  try { await p.goto('https://account.2gis.com/', { waitUntil:'domcontentloaded', timeout:45000 }); } catch(e){ console.log('goto warn', e.message); }
  await p.waitForTimeout(5000);
  // снимок начальной формы
  let body = (await p.evaluate(()=>document.body?document.body.innerText:''))||'';
  console.log('URL:', p.url());
  console.log('init body head:', body.slice(0,500).replace(/\n+/g,' | '));
  // ищем поле email
  const emailInput = await p.$('input[type=email],input[name=email],input[placeholder*=mail i]');
  if (!emailInput) { console.log('NO email input'); await b.close(); process.exit(1); }
  await emailInput.fill(EMAIL);
  await p.waitForTimeout(700);
  // кнопка «Продолжить» / «Войти» / Enter
  try {
    const next = await p.$('button:has-text("Продолжить"),button:has-text("Войти"),button[type=submit]');
    if (next) { await next.click(); }
    else { await emailInput.press('Enter'); }
  } catch(e){ console.log('next warn', e.message); }
  await p.waitForTimeout(4000);
  // поле пароля
  const passInput = await p.$('input[type=password]');
  if (!passInput) {
    body = (await p.evaluate(()=>document.body?document.body.innerText:''))||'';
    console.log('NO password field. URL:', p.url(), 'body:', body.slice(0,400).replace(/\n+/g,' | '));
    await b.close(); process.exit(1);
  }
  await passInput.fill(PASS);
  await p.waitForTimeout(500);
  try {
    const submit = await p.$('button:has-text("Войти"),button[type=submit]');
    if (submit) await submit.click();
    else await passInput.press('Enter');
  } catch(e){ console.log('submit warn', e.message); }
  await p.waitForTimeout(8000);
  // проверяем логин
  const u = p.url();
  body = (await p.evaluate(()=>document.body?document.body.innerText:''))||'';
  const loggedIn = !/Забыли пароль|СберБизнес ID|Зарегистрироваться/.test(body) && !/account\.2gis\.com\/(?:\?|$)/.test(u);
  console.log('after login URL:', u);
  console.log('loggedIn (heuristic):', loggedIn);
  console.log('body head:', body.slice(0,400).replace(/\n+/g,' | '));
  if (loggedIn) {
    // навигация в кабинет для проверки + сохранение state
    try { await p.goto('https://account.2gis.com/orgs/1548649242829424/statistics/appearance',{waitUntil:'domcontentloaded',timeout:30000}); } catch(_){}
    await p.waitForTimeout(6000);
    body = (await p.evaluate(()=>document.body?document.body.innerText:''))||'';
    console.log('cabinet body head:', body.slice(0,300).replace(/\n+/g,' | '));
    await ctx.storageState({ path:'/opt/2gis-scraper/2gis-state.json' });
    console.log('SAVED state');
  }
  await b.close();
})().catch(e=>{ console.log('FATAL', e.message); process.exit(1); });
