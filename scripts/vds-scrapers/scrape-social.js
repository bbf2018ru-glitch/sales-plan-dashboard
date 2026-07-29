// Скрейпер соцсетей через Hostinger Frankfurt relay (t.me блокирован РКН на РФ-IP).
// Cron еженедельно (среда 04:30). Пишет /opt/marketing-data/social.json.
const https = require('https');
const fs = require('fs');
const OUT = '/opt/marketing-data/social.json';
const RELAY = 'https://t-me.145-223-121-47.sslip.io';

// Известные handle-ы Telegram-каналов. Для каждого бренда пробуем все варианты,
// выбираем САМЫЙ БОЛЬШОЙ канал (минимизирует риск поймать сервисный/тестовый канал с 30 подписчиками).
const BRANDS = [
  { key: 'maria',    name: 'Мария',     tg: ['fabrika_maria', 'maria_irk', 'mariairk', 'maria_kond'] },
  { key: 'stefania', name: 'Стефания',  tg: ['stefanycake', 'stefani_cake', 'stefanycake_irk', 'stefany_cake_irk', 'stefany_irk', 'stefany_kond', 'stefanycakes', 'stefanyirk'] },
  { key: 'etika',    name: 'Этика',     tg: ['etikacakes', 'etika_cakes', 'etika_irk', 'etikakanal'] },
  { key: 'cakehome', name: 'Cake Home', tg: ['cakehome', 'cake_home', 'cakehome_irk', 'cake_home_irk', 'cakehomeirk', 'cakehomeofficial'] },
  { key: 'yahont',   name: 'ЯХОНТ',     tg: ['yahontcake', 'yahont_cake', 'yahont_irk', 'yahont_kond'] }
];

function fetch(url) {
  return new Promise(resolve => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131 Safari/537.36' }, timeout: 15000 }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', e => resolve({ error: e.message }));
  });
}

// Парсит «4K», «2.07K», «11.3M», «73 871», «1 234 567» → число
function parseCount(s) {
  if (!s) return null;
  const t = String(s).trim().replace(/&nbsp;/g, ' ');
  const m = t.match(/^([\d.,]+)\s*([KMK])?$/i) || t.match(/^([\d ,]+)$/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/[ ,]/g, '').replace(/(\d)(?=(\d{3})+$)/g, ''));
  if (m[2]) {
    const mult = m[2].toUpperCase() === 'M' ? 1000000 : 1000;
    return Math.round(num * mult);
  }
  // если без суффикса — это уже целое (с пробелами как разделителями тысяч)
  return parseInt(t.replace(/[ ,]/g, ''), 10) || null;
}

async function tryHandle(h) {
  const r = await fetch(RELAY + '/s/' + h);
  if (!r.body || r.body.length < 1000) return null;
  // Канал не найден? title будет «Telegram: Contact @...» без счётчиков
  const counters = [];
  const re = /<div class="tgme_channel_info_counter">[^<]*<span class="counter_value">([^<]+)<\/span>[^<]*<span class="counter_type">([^<]+)<\/span>/g;
  let m; while ((m = re.exec(r.body)) !== null) counters.push({ value: m[1].trim(), type: m[2].trim() });
  const subC = counters.find(c => /subscriber|подписчик|member|участник/i.test(c.type));
  if (!subC) return null;
  const subs = parseCount(subC.value);
  if (!subs) return null;
  const title = (r.body.match(/<meta property="og:title" content="([^"]+)"/) || [, ''])[1].trim();
  return { handle: '@' + h, subscribers: subs, title, url: 'https://t.me/' + h };
}

(async () => {
  const out = { scrapedAt: new Date().toISOString(), source: 'social', brands: {} };
  for (const br of BRANDS) {
    const result = { name: br.name, telegram: null, instagram: null, vk: null, tg_candidates: [] };
    const found = [];
    for (const h of br.tg) {
      const tg = await tryHandle(h);
      if (tg) found.push(tg);
    }
    // выбираем самый крупный канал — основной у бренда, как правило, с наибольшим числом подписчиков
    if (found.length) {
      found.sort((a, b) => b.subscribers - a.subscribers);
      // < 10 подписчиков почти наверняка чужой/тестовый канал с похожим именем (не настоящий канал бренда)
      if (found[0].subscribers >= 10) {
        result.telegram = found[0];
      }
      result.tg_candidates = found.map(c => ({ handle: c.handle, subs: c.subscribers, title: c.title }));
    }
    out.brands[br.key] = result;
  }
  try { fs.mkdirSync('/opt/marketing-data', { recursive: true }); } catch (_) { }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  const sum = {};
  for (const [k, v] of Object.entries(out.brands)) sum[k] = v.telegram ? `${v.telegram.handle} ${v.telegram.subscribers}` : '—';
  console.log(JSON.stringify({ ok: true, brands: sum }));
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
