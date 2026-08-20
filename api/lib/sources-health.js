// Свежесть внешних источников маркетинга.
//
// Зачем: источники умирают молча. Аудит 04.08.2026 нашёл файлы, не
// обновлявшиеся с начала июня (ВК, две выгрузки 2ГИС, блогеры) — заметить это
// можно было только руками. Здесь возраст каждого файла и его флаги сбоя
// сводятся в один ответ: дашборд рисует индикатор, утренний дайджест ругается.
const fs = require('fs');
const path = require('path');

const DIR = process.env.MARKETING_DATA_DIR || '/opt/marketing-data';

// Ожидаемая периодичность обновления (в часах) и человеческое имя.
// Файлы вне списка показываются, но без порога — только возраст.
const EXPECTED = {
  'direct.json':            { h: 26,  name: 'Яндекс.Директ — расход за месяц' },
  'direct-history.json':    { h: 26,  name: 'Яндекс.Директ — история по месяцам' },
  'direct-ecommerce.json':  { h: 26,  name: 'Ecommerce — покупки Директа и 2ГИС' },
  'direct-ecommerce-history.json': { h: 26, name: 'Ecommerce — история покупок по каналам' },
  'metrika.json':           { h: 26,  name: 'Яндекс.Метрика — источники трафика' },
  'metrika-history.json':   { h: 26,  name: 'Яндекс.Метрика — помесячно' },
  '2gis.json':              { h: 26,  name: '2ГИС — карточка компании' },
  '2gis-rating-latest.json':{ h: 26,  name: '2ГИС — рейтинги филиалов' },
  '2gis-history.json':      { h: 26,  name: '2ГИС — динамика' },
  'competitors-2gis.json':  { h: 26,  name: 'Конкуренты в 2ГИС' },
  'partner-clicks.json':    { h: 26,  name: 'Партнёрские переходы (цель в Метрике)' },
  'partners.json':          { h: 168, name: 'Партнёры (Bitrix)' },
  'seo.json':               { h: 26,  name: 'SEO — позиции' },
  'social.json':            { h: 26,  name: 'Соцсети — подписчики' },
  'prices.json':            { h: 26,  name: 'Цены конкурентов' },
  'yahont-prices.json':     { h: 26,  name: 'Цены ЯХОНТ' },
  'sms-clicks.json':        { h: 26,  name: 'Переходы по SMS-ссылкам' },
  'bloggers.json':          { h: 720, name: 'Блогеры (выгрузка из таблицы)' },
  'vk.json':                { h: 720, name: 'ВКонтакте' }
};

function readSafe(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); }
  catch (_) { return null; }
}

function getSourcesHealth() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && !f.includes('.bak')); }
  catch (e) { return { error: 'Каталог данных недоступен: ' + e.message, sources: [] }; }

  const now = Date.now();
  const sources = files.map(f => {
    let st; try { st = fs.statSync(path.join(DIR, f)); } catch (_) { return null; }
    const ageH = Math.round((now - st.mtimeMs) / 36e5);
    const meta = EXPECTED[f] || null;
    const data = readSafe(f);
    // Флаги сбоя, которые скрейперы пишут в сам файл
    const flags = [];
    if (data && typeof data === 'object') {
      if (data.sessionExpired) flags.push('сессия протухла');
      if (data.gridTimeout) flags.push('ответ неполный');
      if (data.noData) flags.push('данных нет');
      if (data.error) flags.push('ошибка скрейпа');
    }
    // Статус: dead — просрочен вдвое или флаг «сессия протухла»;
    // stale — просрочен; warn — свежий, но с потерями; ok — всё в порядке.
    let status = 'ok';
    if (meta) {
      if (ageH > meta.h * 2 || flags.includes('сессия протухла')) status = 'dead';
      else if (ageH > meta.h) status = 'stale';
      else if (flags.length) status = 'warn';
    } else if (ageH > 168) status = 'stale';
    return {
      file: f,
      name: meta ? meta.name : f.replace('.json', ''),
      ageHours: ageH,
      ageText: ageH < 24 ? ageH + ' ч назад' : Math.round(ageH / 24) + ' дн назад',
      expectedHours: meta ? meta.h : null,
      sizeKb: Math.round(st.size / 102.4) / 10,
      flags,
      status
    };
  }).filter(Boolean);

  const rank = { dead: 0, stale: 1, warn: 2, ok: 3 };
  sources.sort((a, b) => rank[a.status] - rank[b.status] || b.ageHours - a.ageHours);
  return {
    checkedAt: new Date().toISOString(),
    dir: DIR,
    counts: {
      dead: sources.filter(s => s.status === 'dead').length,
      stale: sources.filter(s => s.status === 'stale').length,
      warn: sources.filter(s => s.status === 'warn').length,
      ok: sources.filter(s => s.status === 'ok').length
    },
    sources
  };
}

module.exports = { getSourcesHealth };
