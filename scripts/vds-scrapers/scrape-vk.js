// Скрейп VK-подписчиков групп конкурентов (через залогиненную сессию).
// Пробует все handle-варианты для каждого бренда, берёт самую крупную группу (≥10 подписчиков).
// Пишет /opt/marketing-data/vk.json и обновляет social.json (vk поле).
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const OUT = '/opt/marketing-data/vk.json';
const SOCIAL = '/opt/marketing-data/social.json';
const STATE = '/opt/2gis-scraper/vk-state.json';

const BRANDS = [
  { key: 'maria',    name: 'Мария',     handles: ['fabrika_maria', 'fabrikamaria', 'maria_irk', 'mariairk', 'maria.irk', 'mariakondit'] },
  { key: 'stefania', name: 'Стефания',  handles: ['stefanycake', 'stefanycakes', 'stefany_cake', 'stefani_cake'] },
  { key: 'etika',    name: 'Этика',     handles: ['etikacakes', 'etika_irk', 'etika.irk', 'etika_cakes', 'etika.cakes'] },
  { key: 'cakehome', name: 'Cake Home', handles: ['cakehome', 'cake_home_irk', 'cakehomeirk', 'my_cakehome', 'cake.home.irk'] },
  { key: 'yahont',   name: 'ЯХОНТ',     handles: ['yahont', 'yahontcake', 'yahont_irk', 'yahont.irk', 'yahont_kond'] }
];

function parseSubsK(s) {
  if (!s) return null;
  const t = String(s).trim().replace(/ /g, ' ');
  // «4,2K» / «12,3M»
  const m1 = t.match(/^([\d.,]+)\s*K$/i);
  if (m1) return Math.round(parseFloat(m1[1].replace(',', '.')) * 1000);
  const m2 = t.match(/^([\d.,]+)\s*M$/i);
  if (m2) return Math.round(parseFloat(m2[1].replace(',', '.')) * 1000000);
  // «12 345» / «1 234 567»
  const n = parseInt(t.replace(/[\s ,]/g, ''), 10);
  return isFinite(n) && n > 0 ? n : null;
}

async function tryHandle(p, handle) {
  const url = 'https://vk.com/' + handle;
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (_) { return null; }
  await p.waitForTimeout(3000);

  // Проверка: попали на «Эта страница недоступна» или «404»
  const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
  if (/Эта страница недоступна|не существует|404|удал[её]н/i.test(body)) return null;
  if (/Войти|Зарегистрироваться/.test(body) && body.length < 500) return null;

  // Извлекаем имя группы и число подписчиков
  const data = await p.evaluate(() => {
    const out = { title: '', subscribers: null, raw: '' };
    // Title: h1 или meta og:title
    const h1 = document.querySelector('h1');
    if (h1) out.title = h1.innerText.trim();
    if (!out.title) {
      const meta = document.querySelector('meta[property="og:title"]');
      if (meta) out.title = meta.content;
    }
    // Подписчики: разные селекторы для VK
    const counterSelectors = [
      '[class*="GroupHeader__counterTitle"]',
      '[class*="GroupInfoCommunity__counts"]',
      '[data-testid="group_followers_count"]',
      '.page_block_count', // старый дизайн
      '.header_count'
    ];
    for (const sel of counterSelectors) {
      const el = document.querySelector(sel);
      if (el) { out.raw = (el.innerText || '').trim(); break; }
    }
    // Fallback: ищем в body «N подписчик» / «N участник»
    if (!out.raw) {
      const m = (document.body.innerText || '').match(/(\d[\d  ,]*)\s*(подписчик|участник|follower)/i);
      if (m) out.raw = m[1];
    }
    return out;
  });
  data.subscribers = parseSubsK(data.raw);
  if (!data.subscribers || data.subscribers < 5) return null;
  return { handle: '@' + handle, url, title: data.title, subscribers: data.subscribers };
}

(async () => {
  if (!fs.existsSync(STATE)) { console.log(JSON.stringify({ ok: false, error: 'no vk-state' })); return; }
  const out = { scrapedAt: new Date().toISOString(), source: 'vk', brands: {} };
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ storageState: STATE, locale: 'ru-RU', viewport: { width: 1366, height: 900 } });

  for (const br of BRANDS) {
    const p = await ctx.newPage();
    const found = [];
    for (const h of br.handles) {
      const res = await tryHandle(p, h);
      if (res) found.push(res);
    }
    await p.close();
    found.sort((a, b) => b.subscribers - a.subscribers);
    out.brands[br.key] = {
      name: br.name,
      vk: found.length ? found[0] : null,
      candidates: found.map(c => ({ handle: c.handle, subs: c.subscribers, title: c.title }))
    };
    console.log('  ', br.name, ' →', found.length ? `${found[0].handle} ${found[0].subscribers} подп.` : '—');
  }
  await b.close();

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('✓ saved', OUT);

  // Обновляем social.json (vk-поле для каждого бренда)
  try {
    const social = JSON.parse(fs.readFileSync(SOCIAL, 'utf8'));
    for (const [k, v] of Object.entries(out.brands)) {
      if (social.brands && social.brands[k]) social.brands[k].vk = v.vk;
    }
    social.vkScrapedAt = out.scrapedAt;
    fs.writeFileSync(SOCIAL, JSON.stringify(social, null, 2));
    console.log('✓ updated social.json (vk merged)');
  } catch (e) { console.log('social merge warn:', e.message); }

  const sum = {};
  for (const [k, v] of Object.entries(out.brands)) sum[k] = v.vk ? `${v.vk.handle} ${v.vk.subscribers}` : '—';
  console.log(JSON.stringify({ ok: true, brands: sum }));
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
