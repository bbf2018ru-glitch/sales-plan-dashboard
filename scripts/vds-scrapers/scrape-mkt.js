// Серверный скрейпер 2ГИС (живёт на VDS: /opt/2gis-scraper/scrape-mkt.js).
// Запускается по cron, пишет /opt/marketing-data/2gis.json.
// Сессия: /opt/2gis-scraper/2gis-state.json (протухает раз в N недель → релогин).
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const ORG = '1548649242829424';
const BASE = `https://account.2gis.com/orgs/${ORG}/`;
const OUT = '/opt/marketing-data/2gis.json';

const num = s => parseFloat(String(s || '').replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.')) || 0;

(async () => {
  const out = { scrapedAt: new Date().toISOString(), source: '2gis' };
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ru-RU'] });
  const ctx = await b.newContext({ storageState: '/opt/2gis-scraper/2gis-state.json', locale: 'ru-RU', viewport: { width: 1500, height: 2400 } });
  const p = await ctx.newPage();

  async function clickShowTable() {
    try {
      const els = await p.$$('button,[role=button],a,span');
      for (const e of els) { const t = (await e.innerText().catch(() => '')) || ''; if (t.trim() === 'Показать таблицу') { await e.click(); await p.waitForTimeout(3000); return true; } }
    } catch (_) {}
    return false;
  }
  async function go(sub) {
    try { await p.goto(BASE + sub, { waitUntil: 'domcontentloaded', timeout: 40000 }); } catch (e) { return false; }
    await p.waitForTimeout(5000); return true;
  }
  // 2ГИС редиректит на account.2gis.com/?referrer=... (без org-id) при протухшей сессии,
  // плюс body содержит форму входа («Войти», «Забыли пароль»). Проверяем оба признака.
  const loggedOut = async () => {
    const u = p.url();
    if (/passport|auth|login/i.test(u)) return true;
    if (/account\.2gis\.com\/(?:\?|$)/.test(u)) return true;          // редирект на корень
    const t = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
    return /Забыли пароль|СберБизнес ID|Зарегистрироваться/.test(t);
  };

  // helpers для дропдауна рубрик
  async function aggregateTable() {
    await clickShowTable();
    const rows = await p.evaluate(() => { const t = [...document.querySelectorAll('table')].find(x => /Показы/.test(x.innerText)); return t ? [...t.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('td,th')].map(c => c.innerText.trim())) : []; });
    let imp = 0, pos = [], days = 0;
    for (const r of rows) { if (r.length >= 3 && /\d/.test(r[1])) { imp += num(r[1]); const pp = num(r[2]); if (pp > 0) pos.push(pp); days++; } }
    if (!days) return null;
    return { impressions: Math.round(imp), days, positionAvg: pos.length ? Math.round(pos.reduce((a, c) => a + c, 0) / pos.length * 10) / 10 : null, positionMin: pos.length ? Math.min(...pos) : null, positionMax: pos.length ? Math.max(...pos) : null };
  }
  // Известные рубрики Марии в 2ГИС (получены из дебага дропдауна 28.05).
  // Если 2ГИС добавит новую — она просто не попадёт; не страшно.
  const KNOWN_RUBRICS = ['Все рубрики', 'Кофейни', 'Кондитерские изделия', 'Хлебобулочные изделия', 'Доставка еды', 'Кафе-кондитерские'];

  // Класс триггера хешированный (CSS-modules) и меняется — не годится. getByText работает.
  //
  // ДВЕ ГРАБЛИ (фикс 04.06.2026, switch_err у всех рубрик кроме случайно успевшей):
  // 1. SPA-виджет рендерится 7-15с+ (под утренним кроном дольше) — фиксированных 5с
  //    в go() не хватает → поллим появление виджета до 40с.
  // 2. Кабинет ПЕРСИСТИТ выбранную рубрику между заходами — после re-navigate триггер
  //    показывает не «Все рубрики», а последнюю выбранную. Ищем триггер по ЛЮБОЙ
  //    известной рубрике, а не только по «Все рубрики».

  // Ждём отрисовку SPA-виджета «Присутствие в выдаче» (в тексте появляется «рубрик»).
  async function waitAppearanceWidget() {
    for (let i = 0; i < 20; i++) {
      const ok = await p.evaluate(() => /рубрик/i.test(document.body ? document.body.innerText : '')).catch(() => false);
      if (ok) return true;
      await p.waitForTimeout(2000);
    }
    return false;
  }
  // Открыть дропдаун рубрик: кликаем первый видимый элемент с текстом любой известной рубрики.
  async function openRubricDropdown() {
    for (const known of KNOWN_RUBRICS) {
      const loc = p.getByText(known, { exact: true }).first();
      if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 8000 });
        await p.waitForTimeout(1500);
        return true;
      }
    }
    return false;
  }

  // 1) Присутствие в выдаче — по каждой нашей рубрике + агрегат.
  // Для надёжности re-navigate перед КАЖДОЙ рубрикой — чистое состояние.
  out.rubricsAvailable = KNOWN_RUBRICS;
  const byRubric = [];
  for (const r of KNOWN_RUBRICS) {
    if (!(await go('statistics/appearance'))) { byRubric.push({ rubric: r, error: 'nav_fail' }); continue; }
    if (await loggedOut()) { out.sessionExpired = true; byRubric.push({ rubric: r, error: 'session_expired' }); break; }
    if (!(await waitAppearanceWidget())) { byRubric.push({ rubric: r, error: 'widget_timeout' }); continue; }
    if (r !== 'Все рубрики') {
      // открыть дропдаун, кликнуть рубрику
      try {
        if (!(await openRubricDropdown())) { byRubric.push({ rubric: r, error: 'trigger_not_found' }); continue; }
        const opts = p.getByText(r, { exact: true });
        if (await opts.count() === 0) { byRubric.push({ rubric: r, error: 'opt_not_found' }); continue; }
        await opts.last().click({ timeout: 8000 });
        await p.waitForTimeout(6000);  // ждём пересчёта графика и таблицы
      } catch (e) { byRubric.push({ rubric: r, error: 'switch_err:' + e.message.slice(0, 120) }); continue; }
    } else {
      // Персистентный выбор: триггер может показывать НЕ «Все рубрики» — явно сбрасываем.
      try {
        const trig = p.getByText('Все рубрики', { exact: true }).first();
        const showsAll = (await trig.count().catch(() => 0)) && (await trig.isVisible().catch(() => false));
        if (!showsAll && (await openRubricDropdown())) {
          const allOpt = p.getByText('Все рубрики', { exact: true });
          if (await allOpt.count()) { await allOpt.last().click({ timeout: 8000 }); await p.waitForTimeout(6000); }
        }
      } catch (_) { /* не сбросилось — aggregateTable отдаст что есть, увидим по данным */ }
    }
    const stats = await aggregateTable();
    if (stats) byRubric.push({ rubric: r, ...stats });
    else byRubric.push({ rubric: r, error: 'no_table' });
  }
  if (byRubric.length) {
    out.appearance = byRubric.find(b => b.rubric === 'Все рубрики' && b.impressions) || null;
    out.appearanceByRubric = byRubric.filter(b => b.rubric !== 'Все рубрики');
  }
  // 2) Страница компании — состав действий (%)
  if (await go('statistics/card')) {
    await clickShowTable();
    const acts = await p.evaluate(() => { const t = [...document.querySelectorAll('table')].find(x => /%/.test(x.innerText) && /фотогалере|маршрут|отзыв/i.test(x.innerText)); return t ? [...t.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('td,th')].map(c => c.innerText.trim())).filter(c => c.length >= 2) : []; });
    const a = acts.map(c => ({ name: c[0], pct: parseFloat(String(c[c.length - 1]).replace(',', '.')) || 0 })).filter(x => x.name && x.pct);
    if (a.length) out.actions = a;
  }
  // 3) Лента событий — последние ~50 user-sessions (parsing + per-branch aggregation)
  if (await go('statistics/feed')) {
    // скроллим разок — лента подгрузит максимум что отдаёт SPA
    try { await p.evaluate(() => { const els=[...document.querySelectorAll('*')].filter(el=>{const s=getComputedStyle(el);return /(auto|scroll)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+100;}); els.sort((a,b)=>b.scrollHeight-a.scrollHeight); els.slice(0,3).forEach(el=>el.scrollTop=el.scrollHeight); window.scrollTo(0,document.body.scrollHeight); }); } catch (_) {}
    await p.waitForTimeout(2500);
    const body = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
    const lines = body.split('\n').map(s => s.trim());
    // События — это блоки, начинающиеся со строки "Сегодня в HH:MM..." / "Вчера в HH:MM..." / "{день} {месяц} в HH:MM..."
    // и содержащие строки действий ниже (искал/открыл/перешёл/изучал/посмотрел/построил/добавил).
    const events = [];
    let cur = null;
    function isWhen(l) { return /^(Сегодня|Вчера|\d{1,2}\s+(янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек))/i.test(l) && /•/.test(l); }
    function flush() { if (cur && cur.actions.length) events.push(cur); }
    for (const l of lines) {
      if (isWhen(l)) {
        flush();
        const parts = l.split('•').map(s => s.trim());
        cur = { when: parts[0], device: parts[1] || '', isNew: parts.some(x => /Новый пользователь/i.test(x)), actions: [] };
      } else if (cur && l && !/^(Лента событий|Все платформы|Сессии|События|Перейти к дате|Иркутск)/.test(l) && /(искал|открыл|перешёл|перешел|изучал|посмотрел|построил|добавил|поделил|открытие|нашёл|нашел|переход|просмотр)/i.test(l)) {
        cur.actions.push(l);
      }
    }
    flush();

    // Агрегаты
    const byBranchCnt = {}, byEventType = {}, byDevice = {}, topSearch = {};
    let newCount = 0;
    function bumpBranch(addr) { byBranchCnt[addr] = (byBranchCnt[addr] || 0) + 1; }
    function bumpEv(type) { byEventType[type] = (byEventType[type] || 0) + 1; }
    function bumpDev(d) { byDevice[d] = (byDevice[d] || 0) + 1; }
    function bumpQ(q) { topSearch[q] = (topSearch[q] || 0) + 1; }

    const branchRe = /филиала?\s+([^\n]+?)(?:\s*$|\s*[,.])/i;
    const searchRe = /[Ии]скал\s+[«"]([^»"]+)[»"]/;
    for (const ev of events) {
      if (ev.device) bumpDev(ev.device);
      if (ev.isNew) newCount++;
      const seenBranches = new Set();
      for (const a of ev.actions) {
        // тип события
        let type = 'другое';
        if (/искал/i.test(a)) type = 'Поиск';
        else if (/открыл карточку/i.test(a)) type = 'Открыл карточку';
        else if (/перешёл|перешел/i.test(a) && /сайт/i.test(a)) type = 'Переход на сайт';
        else if (/изучал отзыв/i.test(a)) type = 'Изучал отзывы';
        else if (/посмотрел цены/i.test(a)) type = 'Посмотрел цены';
        else if (/построил маршрут/i.test(a)) type = 'Построил маршрут';
        else if (/открыл фотогалер/i.test(a)) type = 'Просмотр фото';
        else if (/посмотрел адрес/i.test(a)) type = 'Посмотрел адрес';
        else if (/добавил в избран/i.test(a)) type = 'В избранное';
        bumpEv(type);
        // филиал
        const bm = a.match(branchRe);
        if (bm) {
          const br = bm[1].trim().replace(/\s*[,.]\s*$/, '');
          if (br && !seenBranches.has(br)) { bumpBranch(br); seenBranches.add(br); }
        }
        // поисковая фраза
        const sm = a.match(searchRe);
        if (sm) bumpQ(sm[1].toLowerCase());
      }
    }
    out.feed = {
      eventsCount: events.length,
      newUsersPct: events.length ? Math.round(newCount / events.length * 1000) / 10 : 0,
      byBranch: Object.entries(byBranchCnt).map(([branch, cnt]) => ({ branch, events: cnt })).sort((a, b) => b.events - a.events).slice(0, 50),
      byEventType: Object.entries(byEventType).map(([type, cnt]) => ({ type, events: cnt })).sort((a, b) => b.events - a.events),
      byDevice: Object.entries(byDevice).map(([device, cnt]) => ({ device, events: cnt })).sort((a, b) => b.events - a.events),
      topSearch: Object.entries(topSearch).map(([q, cnt]) => ({ q, events: cnt })).sort((a, b) => b.events - a.events).slice(0, 15)
    };
  }

  // 4) Поисковые запросы
  if (await go('statistics/demand')) {
    await clickShowTable();
    const q = await p.evaluate(() => { const t = [...document.querySelectorAll('table')].find(x => /%/.test(x.innerText)); return t ? [...t.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('td,th')].map(c => c.innerText.trim())).filter(c => c.length >= 2) : []; });
    const qq = q.map(c => ({ q: c[0], pct: parseFloat(String(c[1]).replace(',', '.')) || 0 })).filter(x => x.q && x.pct && !/^запрос/i.test(x.q));
    if (qq.length) out.queries = qq.slice(0, 50);
  }

  // 5) Статистика Сторис — Маша платит за продвижение. На странице:
  //    - 3 главные метрики: Просмотры превью / Просмотры сторис / Клики в кнопку
  //    - Период (по умолчанию полгода)
  //    - Список конкретных сторис с темами
  if (await go('statistics/stories')) {
    const sBody = (await p.evaluate(() => document.body ? document.body.innerText : '')) || '';
    const sLines = sBody.split('\n').map(s => s.trim()).filter(Boolean);
    const sData = {};
    // Метрики: «<число>\n<название>»: «147700\nПросмотров превью»
    for (let i = 0; i < sLines.length - 1; i++) {
      const v = sLines[i].replace(/\s/g, '');
      const label = sLines[i + 1] || '';
      if (!/^\d+$/.test(v) || v.length > 8) continue;
      const n = parseInt(v, 10);
      if (n < 10) continue;
      if (/Просмотр\w*\s*превью/i.test(label)) sData.previewViews = sData.previewViews || n;
      else if (/Просмотр\w*\s*сторис/i.test(label) && !sData.storiesViews) sData.storiesViews = n;
      else if (/Клик\w*\s*в\s*кнопк/i.test(label) && !sData.buttonClicks) sData.buttonClicks = n;
    }
    // Период
    const periodM = sBody.match(/(Январь|Февраль|Март|Апрель|Май|Июнь|Июль|Август|Сентябрь|Октябрь|Ноябрь|Декабрь)\s+20\d{2}\s*[—–-]\s*(Январь|Февраль|Март|Апрель|Май|Июнь|Июль|Август|Сентябрь|Октябрь|Ноябрь|Декабрь)\s+20\d{2}/);
    if (periodM) sData.period = periodM[0];
    // Темы сторис — между «Мои сторис» и появлением second-time метрики
    const startIdx = sLines.findIndex(l => l === 'Мои сторис');
    if (startIdx >= 0) {
      const topics = [];
      for (let i = startIdx + 1; i < Math.min(startIdx + 50, sLines.length); i++) {
        const l = sLines[i];
        if (!/^[\d.,]+[\s\d.,K M]*$/.test(l) && !/^\d{1,2}\.\d{2,4}/.test(l) &&
            !/^(Просмотров|Кликов|01\.\d|02\.\d|0|25K|50K|75K|100K|500|1000|1\.5K|2K|10|20|30)$/.test(l) &&
            l.length > 4 && l.length < 80) {
          topics.push(l);
        }
        if (topics.length >= 30) break;
      }
      sData.topics = topics.slice(0, 30);
    }
    if (Object.keys(sData).length) out.stories = sData;
  }

  // 6) Отзывы + per-branch rating через /branches/<id>/reviews
  try {
    await p.goto(BASE + 'branches', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(5000);
    const branchUrl = p.url();
    const branchIdM = branchUrl.match(/\/branches\/(\d+)/);
    if (branchIdM) {
      const reviewsUrl = `${BASE}branches/${branchIdM[1]}/reviews`;
      await p.goto(reviewsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(8000);
      // Скролл вниз чтобы lazy-загрузить больше отзывов
      for (let i = 0; i < 6; i++) { try { await p.evaluate(() => window.scrollBy(0, 600)); } catch (_) {} await p.waitForTimeout(500); }
      await p.waitForTimeout(2000);

      // Парсим отзывы из body
      const rbody = await p.evaluate(() => document.body ? document.body.innerText : '');
      const rlines = rbody.split('\n').map(s => s.trim()).filter(Boolean);
      // Теги (Торты / Десерты / Выпечка / ...)
      const tagBlock = rlines.findIndex(l => l === 'Торты');
      const tags = [];
      if (tagBlock >= 0) {
        for (let i = tagBlock; i < Math.min(tagBlock + 15, rlines.length); i++) {
          const l = rlines[i];
          if (/^[А-ЯЁ][а-яё]{2,15}$/.test(l) && l.length < 25) tags.push(l);
          else if (i > tagBlock + 2 && !/[А-ЯЁ][а-яё]+/.test(l)) break;
        }
      }
      // Google maps total reviews
      const gmM = rbody.match(/(\d[\d\s ]*)\s+отзыв\w*\s+в\s+Google/i) || rbody.match(/Ещ[её]\s+(\d[\d\s ]*)/);
      const googleMapsReviews = gmM ? parseInt(gmM[1].replace(/[\s ]/g, ''), 10) : null;
      // Парсим отзывы: ищем блоки «<дата> <платформа> <текст> ... Удалить Ответить»
      const reviews = [];
      const PLATFORMS = /^(2GIS|Google maps|2ГИС\.\s*Отзывы Про|Otello|Flamp|Booking)/i;
      const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
      const isDate = l => /^\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+20\d{2}$/.test(l);
      for (let i = 0; i < rlines.length - 3; i++) {
        // Шаблон: <автор>\n<платформа>\n<дата>\n<текст>
        if (PLATFORMS.test(rlines[i + 1] || '') && isDate(rlines[i + 2] || '')) {
          const author = rlines[i];
          const platform = rlines[i + 1];
          const date = rlines[i + 2];
          const text = rlines[i + 3] || '';
          if (text.length > 20 && !PLATFORMS.test(text)) {
            reviews.push({ author: author.slice(0, 60), platform, date, text: text.slice(0, 500) });
          }
        }
      }
      out.reviews = {
        items: reviews.slice(0, 30),
        total: reviews.length,
        googleMapsReviews,
        tags
      };

      // Также — сводная таблица per-branch если есть
      // Кликаем «Все филиалы» если есть toggle
      // Кликаем «Все филиалы» если есть toggle
      try {
        const all = p.getByText('Все филиалы', { exact: true });
        if (await all.count() > 0) { await all.first().click({ timeout: 4000 }); await p.waitForTimeout(3000); }
      } catch (_) {}
      const reviewBody = await p.evaluate(() => document.body ? document.body.innerText : '');
      // Парсим: после заголовка «Все филиалы / Филиал / Оценка / Без ответа» идут строки
      const lns = reviewBody.split('\n').map(s => s.trim()).filter(Boolean);
      const startIdx = lns.findIndex((l, i) => /^Все филиалы$/.test(l) && lns[i + 1] === 'Филиал' && /^Оценк/.test(lns[i + 2] || ''));
      const branches = [];
      if (startIdx >= 0) {
        for (let i = startIdx + 4; i < lns.length - 1; i++) {
          if (/^(Популярные|Запросите|Выбрано|Все мнения|Ответы)/i.test(lns[i])) break;
          // Адрес = улица/проспект/микрорайон/цифра
          if (/(улиц|проспект|микрорайон|пр-т|переулок|шоссе|бульвар|\d+[-]?[йя]\s+(км|мкр)|^\d{1,3})/i.test(lns[i])) {
            const rM = (lns[i + 1] || '').match(/^([1-5][.,]\d)$/);
            const wM = (lns[i + 2] || '').match(/^(\d+)$/);
            if (rM) {
              branches.push({ address: lns[i], rating: parseFloat(rM[1].replace(',', '.')), withoutReply: wM ? parseInt(wM[1], 10) : 0 });
              i += 2;
            }
          }
        }
      }
      if (branches.length) {
        const valid = branches.filter(b => b.rating);
        out.branchRatings = {
          branches,
          avgRating: valid.length ? Math.round(valid.reduce((s, b) => s + b.rating, 0) / valid.length * 100) / 100 : null,
          totalBranches: branches.length,
          totalWithoutReply: branches.reduce((s, b) => s + b.withoutReply, 0)
        };
      }
    }
  } catch (e) { out.branchRatingsError = e.message; }

  await b.close();
  try { fs.mkdirSync('/opt/marketing-data', { recursive: true }); } catch (_) {}
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, sessionExpired: !!out.sessionExpired, appearance: out.appearance || null, actions: (out.actions || []).length, queries: (out.queries || []).length, feedEvents: out.feed ? out.feed.eventsCount : 0, feedBranches: out.feed ? out.feed.byBranch.length : 0, stories: out.stories || null, branchRatings: out.branchRatings ? out.branchRatings.totalBranches : 0, reviews: out.reviews ? out.reviews.items.length : 0, googleMapsReviews: out.reviews ? out.reviews.googleMapsReviews : null }));
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
