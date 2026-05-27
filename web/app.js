// ── State ──────────────────────────────────────────────────────────────────
function readUserToken() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('userToken');
  if (fromUrl) {
    // Сохраняем в localStorage (для обратной совместимости) и сразу шлём
    // на /api/auth чтобы сервер выставил httpOnly cookie. После этого
    // токен будет защищён от XSS — JS его прочитать уже не сможет.
    localStorage.setItem('maria_user_token', fromUrl);
    url.searchParams.delete('userToken');
    window.history.replaceState({}, '', url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '') + url.hash);
    // Не блокируем загрузку — кук-запрос отправляем без await
    fetch('/api/auth', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userToken: fromUrl })
    }).catch(() => {});
    return fromUrl;
  }
  return localStorage.getItem('maria_user_token') || '';
}

async function doLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
  localStorage.removeItem('maria_user_token');
  sessionStorage.removeItem('maria_session');
  state.userToken = '';
  state.sessionToken = '';
  state.currentUser = null;
  // Полная перезагрузка — почистит in-memory состояние
  window.location.href = '/';
}

const state = {
  period: '',
  selectedStoreId: '',
  summary: null,
  comments: [],
  storeSort: { key: 'percent', dir: -1 },
  productSort: 'fact',
  sessionToken: sessionStorage.getItem('maria_session') || '',
  userToken: readUserToken(),
  currentUser: null,
  pinRequired: false,
  editStoreId: '',
  editPlanData: [],
  trendWindow: 12
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Formatters ─────────────────────────────────────────────────────────────
function formatMoney(v) {
  if (v === null || v === undefined) return '—';
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(v || 0);
}
function formatNum(v) { return new Intl.NumberFormat('ru-RU').format(v || 0); }
function formatPct(v) { return v === null || v === undefined ? '—' : `${v}%`; }
function isNum(v) { return v !== null && v !== undefined && !Number.isNaN(v); }
function formatDate(v) {
  if (!v) return 'нет';
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toLocaleString('ru-RU');
}
function pctTone(v) { return v >= 100 ? 'good' : v >= 80 ? 'warn' : 'bad'; }
function signed(v, fmt) { return `${v > 0 ? '+' : ''}${fmt(v)}`; }
function fmtAxis(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}М`;
  if (v >= 1000) return `${(v / 1000).toFixed(0)}К`;
  return String(Math.round(v));
}

// ── HTTP ───────────────────────────────────────────────────────────────────
async function fetchJson(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.sessionToken) headers['X-Session-Token'] = state.sessionToken;
  if (state.userToken) headers['X-User-Token'] = state.userToken;
  opts.headers = headers;
  // credentials: 'same-origin' — отправляем httpOnly auth-cookies (новая модель,
  // вытесняет передачу токенов в URL/localStorage)
  if (!opts.credentials) opts.credentials = 'same-origin';
  // Жёсткий таймаут 90 сек чтобы fetch не висел вечно при сетевых заминках —
  // иначе UI стопорится и кнопки не реагируют
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 90000);
  opts.signal = ac.signal;
  try {
    const res = await fetch(path, opts);
    if (!res.ok) {
      const b = await res.json().catch(() => ({ error: 'Ошибка запроса' }));
      throw new Error(b.error || 'Ошибка запроса');
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Таймаут запроса (90 сек)');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ── PIN Auth ───────────────────────────────────────────────────────────────
const PIN_STORED_KEY = 'maria_pin_hash';

function pinHash(pin) {
  let h = 5381;
  for (let i = 0; i < pin.length; i++) h = ((h << 5) + h) ^ pin.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function initPin(pinRequired) {
  state.pinRequired = pinRequired;

  if (pinRequired && !state.sessionToken) showPinOverlay();

  const storedHash = localStorage.getItem(PIN_STORED_KEY);
  if (storedHash && !sessionStorage.getItem('maria_local_ok')) showPinOverlay(true);

  $('pinSubmit').addEventListener('click', handlePinSubmit);
  $('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('pinSubmit').click(); });

  $('pinSettingsBtn').addEventListener('click', () => {
    const newPin = prompt('Введите новый PIN (4-8 цифр) для клиентской защиты.\nОставьте пустым — отключить:');
    if (newPin === null) return;
    if (newPin.trim() === '') {
      localStorage.removeItem(PIN_STORED_KEY);
      sessionStorage.setItem('maria_local_ok', '1');
      alert('Клиентская PIN-защита отключена.');
    } else if (/^\d{4,8}$/.test(newPin)) {
      localStorage.setItem(PIN_STORED_KEY, pinHash(newPin));
      sessionStorage.setItem('maria_local_ok', '1');
      alert('PIN установлен. Он будет запрашиваться при каждом новом сеансе.');
    } else {
      alert('PIN должен содержать 4–8 цифр.');
    }
  });
}

function showPinOverlay(localMode) {
  $('pinOverlay').classList.remove('hidden');
  $('pinOverlay').dataset.localMode = localMode ? '1' : '0';
  setTimeout(() => $('pinInput').focus(), 100);
}

function hidePinOverlay() { $('pinOverlay').classList.add('hidden'); }

async function handlePinSubmit() {
  const pin = $('pinInput').value.trim();
  if (!pin) return;
  $('pinError').textContent = '';

  const localMode = $('pinOverlay').dataset.localMode === '1';

  if (localMode) {
    const stored = localStorage.getItem(PIN_STORED_KEY);
    if (pinHash(pin) === stored) {
      sessionStorage.setItem('maria_local_ok', '1');
      hidePinOverlay();
    } else {
      $('pinError').textContent = 'Неверный PIN';
      $('pinInput').value = '';
      $('pinInput').focus();
    }
    return;
  }

  try {
    const data = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    }).then(r => r.json());
    if (data.ok) {
      if (data.token) {
        state.sessionToken = data.token;
        sessionStorage.setItem('maria_session', data.token);
      }
      hidePinOverlay();
    } else {
      $('pinError').textContent = data.error || 'Неверный PIN';
      $('pinInput').value = '';
      $('pinInput').focus();
    }
  } catch {
    $('pinError').textContent = 'Ошибка соединения';
  }
}

// ── Dark theme ─────────────────────────────────────────────────────────────
function initDarkTheme() {
  const saved = localStorage.getItem('maria_theme') || 'dark';
  setTheme(saved);
  $('themeToggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    setTheme(current === 'dark' ? 'light' : 'dark');
  });
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('maria_theme', theme);
  const btn = $('themeToggle');
  if (!btn) return;
  btn.title = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  btn.innerHTML = theme === 'dark'
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

// ── SVG: trend line chart ──────────────────────────────────────────────────
const MONTH_SHORT_RU = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
function fmtPeriodLabel(period, prevPeriod) {
  const [y, m] = period.split('-').map(Number);
  const label = MONTH_SHORT_RU[m - 1];
  if (!prevPeriod || prevPeriod.split('-')[0] !== String(y)) return `${label}'${String(y).slice(2)}`;
  return label;
}

function renderTrendChart(summary) {
  const el = $('trendChart');
  const allPts = (summary.trend?.periods || []).filter(p => p.plan > 0 || p.fact > 0);
  const pts = allPts.slice(-state.trendWindow);
  if (pts.length < 2) { el.innerHTML = '<div class="empty-state">Недостаточно данных для графика.</div>'; return; }

  const subtitle = $('trendSubtitle');
  if (subtitle) subtitle.textContent = `план и факт за ${pts.length} мес.`;

  const dense = pts.length > 8;
  const W = 560, H = 240, pad = { t: 24, r: 20, b: dense ? 54 : 46, l: 68 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b, n = pts.length;
  const maxVal = Math.max(...pts.flatMap(p => [p.plan, p.fact]), 1);
  const xp = i => pad.l + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
  const yp = v => pad.t + ph - (v / maxVal) * ph;

  const grids = Array.from({ length: 5 }, (_, i) => {
    const v = maxVal / 4 * i, y = yp(v);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + pw}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
    <text x="${pad.l - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--hint)" font-size="11">${fmtAxis(v)}</text>`;
  }).join('');

  const planD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xp(i).toFixed(1)},${yp(p.plan).toFixed(1)}`).join(' ');
  const factD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xp(i).toFixed(1)},${yp(p.fact).toFixed(1)}`).join(' ');
  const areaD = `${factD} L${xp(n - 1).toFixed(1)},${(pad.t + ph).toFixed(1)} L${xp(0).toFixed(1)},${(pad.t + ph).toFixed(1)} Z`;

  const dotR = dense ? 3.5 : 5;
  const dots = pts.map((p, i) => {
    const clr = p.completion >= 100 ? '#16a34a' : p.completion >= 80 ? '#f59e0b' : '#ef4444';
    const pctLabel = dense ? '' : `<text x="${xp(i).toFixed(1)}" y="${(yp(p.fact) - 9).toFixed(1)}" text-anchor="middle" fill="var(--hint)" font-size="10">${p.completion}%</text>`;
    return `<circle cx="${xp(i).toFixed(1)}" cy="${yp(p.fact).toFixed(1)}" r="${dotR}" fill="${clr}" stroke="white" stroke-width="2"/>
    <circle cx="${xp(i).toFixed(1)}" cy="${yp(p.plan).toFixed(1)}" r="2.5" fill="white" stroke="#9ca3af" stroke-width="1.5"/>${pctLabel}`;
  }).join('');

  const xlabels = pts.map((p, i) => {
    const x = xp(i).toFixed(1);
    const y = (pad.t + ph + 14).toFixed(1);
    const lbl = fmtPeriodLabel(p.period, pts[i - 1]?.period);
    if (dense) {
      return `<text x="${x}" y="${y}" text-anchor="end" fill="var(--hint)" font-size="10" transform="rotate(-40,${x},${y})">${lbl}</text>`;
    }
    return `<text x="${x}" y="${(pad.t + ph + 18).toFixed(1)}" text-anchor="middle" fill="var(--hint)" font-size="11">${lbl}</text>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    <defs>
      <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0f766e" stop-opacity="0.14"/>
        <stop offset="100%" stop-color="#0f766e" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grids}
    <path d="${areaD}" fill="url(#tg)"/>
    <path d="${planD}" fill="none" stroke="var(--hint)" stroke-width="2" stroke-dasharray="6,4"/>
    <path d="${factD}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}${xlabels}
    <text x="${pad.l}" y="${H - 4}" fill="var(--hint)" font-size="10">─ ─ план</text>
    <text x="${pad.l + 54}" y="${H - 4}" fill="var(--accent)" font-size="10">─── факт</text>
  </svg>`;
}

// ── AI-нарратив «Маша рассказывает» — приоритетная плашка над KPI ───────────
function renderAiNarrative(text) {
  const section = $('aiNarrativeSection');
  const textEl = $('aiNarrativeText');
  if (!section || !textEl) return;
  if (!text || !String(text).trim()) {
    section.classList.add('hidden');
    return;
  }
  textEl.innerHTML = escapeHtml(String(text)).replace(/\n/g, '<br>');
  section.classList.remove('hidden');
}

// ── Ритм недели — heatmap средней выручки по дням недели ────────────────────
function renderWeekdayHeatmap(summary) {
  const el = $('weekdayHeatmap');
  if (!el) return;
  const period = summary.period || '';
  const [yy, mm] = period.split('-').map(Number);
  if (!yy || !mm) { el.innerHTML = '<div class="empty-state">Нет данных</div>'; return; }

  // Группируем факт по дням недели (Пн..Вс)
  const buckets = [[], [], [], [], [], [], []];
  for (const row of summary.daily || []) {
    if (!row || !row.day) continue;
    if (!(row.fact > 0)) continue;
    const d = new Date(Date.UTC(yy, mm - 1, row.day));
    // getUTCDay: 0=Вс,1=Пн..6=Сб → перенумеруем в 0=Пн..6=Вс
    const dow = (d.getUTCDay() + 6) % 7;
    buckets[dow].push(row.fact);
  }
  // Медиана устойчивее к выбросу одного дня (например когда в один вторник
  // пробили продажи за несколько дней — среднее по 2-3 вторникам сильно
  // искажается; медиана покажет реальный «типичный» день).
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const avg = buckets.map(median);
  const countsByDow = buckets.map(arr => arr.length);
  const maxV = Math.max(...avg, 1);
  if (maxV <= 1) { el.innerHTML = '<div class="empty-state">Пока мало данных за этот месяц</div>'; return; }

  const labels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  // Найдём лучший и худший день для подписи
  const ranked = avg.map((v, i) => ({ i, v })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  const cells = avg.map((v, i) => {
    const intensity = maxV > 0 ? v / maxV : 0; // 0..1
    // Цвет: при 0 — почти прозрачный, при max — насыщенный accent
    const alpha = 0.08 + intensity * 0.85;
    const isWeekend = i >= 5;
    const isBest = best && best.i === i && v > 0;
    const isWorst = worst && worst.i === i && v > 0 && ranked.length > 1;
    const cls = `weekday-cell ${isWeekend ? 'weekend' : ''} ${isBest ? 'is-best' : ''} ${isWorst ? 'is-worst' : ''}`;
    const subline = v > 0 ? `${fmtMoneyShort(v)}/день` : '—';
    const days = countsByDow[i];
    return `<div class="${cls}" style="background: rgba(193, 68, 86, ${alpha.toFixed(2)})" title="${labels[i]}: ${days} ${days === 1 ? 'день' : 'дн.'}, медианная выручка ${formatMoney(v)} ₽">
      <div class="wc-day">${labels[i]}</div>
      <div class="wc-val">${subline}</div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="weekday-grid">${cells}</div>
    ${best && worst && best.i !== worst.i ? `<div class="weekday-hint">
      Самый сильный — <b>${labels[best.i]}</b> (${fmtMoneyShort(best.v)}/день), слабый — <b>${labels[worst.i]}</b> (${fmtMoneyShort(worst.v)}/день).
    </div>` : ''}`;
}

// ── Market trends — AI-обзор кондитерских трендов и рекомендации ────────────
function renderMarketTrends(data) {
  const el = $('marketTrends');
  const subEl = $('marketTrendsSub');
  if (!el) return;
  if (!data || !Array.isArray(data.trends) || !data.trends.length) {
    el.innerHTML = '<div class="empty-state" style="padding:16px">Тренды пока не сгенерированы. Нажмите «Обновить».</div>';
    return;
  }
  const ageH = data.generatedAt
    ? Math.round((Date.now() - new Date(data.generatedAt).getTime()) / 36e5)
    : null;
  if (subEl) {
    const ago = ageH === null ? '' : (ageH === 0 ? 'обновлено только что' : `обновлено ${ageH} ч назад`);
    subEl.textContent = `тренды кондитерки и что внедрить — AI-обзор · ${ago}`;
  }
  const trendBadge = (t) => {
    if (t === 'rising') return '<span class="mt-badge mt-rising">↗ растёт</span>';
    if (t === 'niche') return '<span class="mt-badge mt-niche">◆ нишевой</span>';
    return '<span class="mt-badge mt-stable">— устойчивый</span>';
  };
  el.innerHTML = data.trends.map((t) => `
    <div class="mt-card ${t.have_already ? 'mt-have' : ''}">
      <div class="mt-head">
        <span class="mt-cat">${escapeHtml(t.category)}</span>
        ${trendBadge(t.trend)}
        ${t.have_already ? '<span class="mt-badge mt-have-tag">✓ уже есть</span>' : ''}
      </div>
      <div class="mt-title">${escapeHtml(t.title)}</div>
      <div class="mt-summary">${escapeHtml(t.summary)}</div>
      <div class="mt-rec"><span class="mt-rec-label">Внедрить:</span> ${escapeHtml(t.recommendation)}</div>
    </div>`).join('');
}

let marketTrendsBusy = false;
async function loadMarketTrends({ force = false } = {}) {
  if (marketTrendsBusy) return;
  marketTrendsBusy = true;
  const el = $('marketTrends');
  const btn = $('marketTrendsRefresh');
  if (btn) btn.disabled = true;
  try {
    if (el && force) el.innerHTML = '<div class="empty-state" style="padding:16px">Запрашиваю свежие тренды у Маши…</div>';
    const path = force ? '/api/market-trends/refresh' : '/api/market-trends';
    const data = await fetchJson(path, force ? { method: 'POST' } : {});
    renderMarketTrends(data);
  } catch (e) {
    if (el) el.innerHTML = `<div class="empty-state" style="padding:16px;color:var(--bad)">Не удалось загрузить: ${escapeHtml(e.message)}</div>`;
  } finally {
    marketTrendsBusy = false;
    if (btn) btn.disabled = false;
  }
}

// ── KPIs ───────────────────────────────────────────────────────────────────
// ── Sticky metrics — компактная полоса при скролле ───────────────────────
function renderStickyMetrics(summary) {
  const bar = $('stickyMetrics');
  if (!bar || !summary) return;
  const t = summary.totals || {};
  const f = summary.forecast || {};
  const [yyyy, mm] = (summary.period || '').split('-');
  const months = ['', 'янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
  $('smPeriod').textContent = `${months[+mm] || mm}'${(yyyy || '').slice(-2)}`;
  const pctEl = $('smPct');
  pctEl.textContent = `${t.completion || 0}%`;
  pctEl.className = 'sm-value ' + (t.completion >= 100 ? 'sm-good' : t.completion >= 60 ? 'sm-ok' : 'sm-bad');
  $('smFact').textContent = fmtMoneyShort(t.fact || 0);
  $('smForecast').textContent = `${f.projectedCompletion || 0}%`;
  $('smRemain').textContent = `${f.remainingDays || 0} дн.`;
}

// Sticky показывается при скролле когда summary-hero ушёл выше viewport
function initStickyMetrics() {
  const bar = $('stickyMetrics');
  const hero = $('summaryHero');
  if (!bar || !hero) return;
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      // hero виден — sticky прячем; hero ушёл — показываем
      bar.classList.toggle('hidden', e.isIntersecting);
    }
  }, { threshold: 0, rootMargin: '-60px 0px 0px 0px' });
  observer.observe(hero);

  // Клик на иконку поиска → открыть Cmd+K
  $('smCmdkBtn')?.addEventListener('click', openCmdK);
}

// ── Summary hero — главная карточка дня ───────────────────────────────────
function renderSummaryHero(summary) {
  const el = $('summaryHero');
  if (!el || !summary) { el?.classList.add('hidden'); return; }

  const t = summary.totals || {};
  const f = summary.forecast || {};
  // % к плану-на-сегодня (а не к концу месяца)
  const planToDate = f.planPerDay && f.elapsedDays ? f.planPerDay * f.elapsedDays : 0;
  const pct = planToDate > 0 ? Math.round(((t.fact || 0) / planToDate) * 100) : (t.completion || 0);
  const gapToday = planToDate - (t.fact || 0); // > 0 = отстаём, < 0 = опережаем
  const gapEom = (t.plan || 0) - (t.fact || 0); // до конца месяца

  // Топ-3 отстающих магазина
  const lagging = (summary.stores || [])
    .filter(s => s.plan > 0)
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 3);

  // Топ-3 лидера. Исключаем план-аномалии (точки с заниженным планом дают
  // 600%+ и забивают слот лидерства). Если ни одного настоящего лидера нет —
  // показываем топ-3 по абсолютной выручке как fallback с другим заголовком.
  const realLeaders = (summary.stores || [])
    .filter(s => s.plan >= 500000 && s.percent >= 100 && s.percent <= 200)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 3);
  const leaders = realLeaders.length ? realLeaders : (summary.stores || [])
    .filter(s => s.fact > 0)
    .sort((a, b) => (b.fact || 0) - (a.fact || 0))
    .slice(0, 3);
  const leadersTitle = realLeaders.length ? '⬆ Лидеры' : 'Топ по выручке';
  const leaderValue = (s) => realLeaders.length ? `${s.percent}%` : fmtMoneyShort(s.fact || 0);

  // Какой текст по состоянию плана (pct = % к плану-на-сегодня, не на конец месяца)
  let mood = 'ok';
  let moodLabel = 'идём в темпе';
  let moodIcon = '✓';
  if (f.status && /угроз|разрыв|fail/i.test(f.status)) { mood = 'bad'; moodLabel = f.status; moodIcon = '⚠'; }
  else if (pct < 80) { mood = 'bad'; moodLabel = 'сильно отстаём от темпа'; moodIcon = '↓'; }
  else if (pct < 95) { mood = 'warn'; moodLabel = 'немного отстаём от темпа'; moodIcon = '↓'; }
  else if (pct >= 110) { mood = 'great'; moodLabel = 'опережаем темп'; moodIcon = '✓'; }

  // Период «План май» — название месяца
  const [yyyy, mm] = (summary.period || state.period || '').split('-');
  const months = ['', 'январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  const monthName = months[+mm] || '';

  const todayGapTxt = gapToday > 0
    ? `<b class="hero-gap">отстаём на сегодня: ${fmtMoneyShort(gapToday)}</b>`
    : `<b style="color:rgb(34,197,94)">опережаем на сегодня: ${fmtMoneyShort(-gapToday)}</b>`;

  el.innerHTML = `
    <div class="hero-card hero-${mood}">
      <div class="hero-icon">${moodIcon}</div>
      <div class="hero-body">
        <div class="hero-headline">
          ${escapeHtml(monthName)} ${escapeHtml(yyyy || '')} · к сегодня — <b>${pct}%</b>
          <span class="hero-mood">${escapeHtml(moodLabel)}</span>
        </div>
        <div class="hero-sub">
          Факт <b>${fmtMoneyShort(t.fact || 0)}</b> из плана-на-сегодня ${fmtMoneyShort(planToDate)}
          · ${todayGapTxt}
        </div>
        <div class="hero-sub" style="font-size:12px;opacity:.7">
          План месяца ${fmtMoneyShort(t.plan || 0)} · до конца месяца нужно ${gapEom > 0 ? fmtMoneyShort(gapEom) : '— план выполнен'}
          ${f.runwayGap ? `· прогноз разрыва: ${fmtMoneyShort(f.runwayGap)}` : ''}
        </div>
        ${lagging.length ? `<div class="hero-lists">
          <div class="hero-list">
            <div class="hero-list-title">⬇ Отстают</div>
            ${lagging.map(s => `<div class="hero-store hero-store-bad">${escapeHtml(s.storeName)} <b>${s.percent}%</b></div>`).join('')}
          </div>
          <div class="hero-list">
            <div class="hero-list-title">${leadersTitle}</div>
            ${leaders.map(s => `<div class="hero-store hero-store-good">${escapeHtml(s.storeName)} <b>${leaderValue(s)}</b></div>`).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>
  `;
  el.classList.remove('hidden');
}

function renderKpis(summary) {
  const f = summary.forecast;
  const t = summary.totals;
  const c = summary.comparison;
  const planIncomplete = summary?.planHealth && summary.planHealth.ok === false;
  const deltaArrow = c?.hasData && c.factDelta > 0 ? '↑' : c?.hasData && c.factDelta < 0 ? '↓' : '';
  const deltaTxt = c?.hasData ? ` ${deltaArrow}${c.factDeltaPercent > 0 ? '+' : ''}${c.factDeltaPercent}%` : '';

  // ── Расчёты «на сегодня» ────────────────────────────────────────────────
  // Сервер уже посчитал план-на-сейчас с учётом часа в Иркутске (дробно).
  const today = summary.today || {};
  const planToDate = today.planToDate || 0;
  const factToDate = today.factToDate ?? t.fact ?? 0;
  const gapToDate = today.gapToDate ?? (planToDate - factToDate);
  const todayPct = planToDate > 0 ? Math.round((factToDate / planToDate) * 100) : 0;
  const todayTone = todayPct >= 100 ? 'good' : todayPct >= 90 ? 'warn' : 'bad';

  // Карточка показывает % выполнения плана МЕСЯЦА (t.completion); темп vs плана-на-сегодня уходит в подпись.
  const monthPct = t.completion || 0;
  const completionVal = planIncomplete ? '—' : `${monthPct}%`;
  const completionTone = planIncomplete ? 'neutral' : todayTone;
  let completionSub;
  if (planIncomplete) completionSub = 'план неполный';
  else if (gapToDate > 0) completionSub = `отстаём на ${fmtMoneyShort(gapToDate)}`;
  else completionSub = `опережаем на ${fmtMoneyShort(-gapToDate)}`;

  const projectedVal  = planIncomplete ? '—' : formatMoney(f.projectedFact);
  const projectedSub  = planIncomplete ? 'план неполный' : `${f.projectedCompletion}% к плану`;
  const projectedTone = planIncomplete ? 'neutral' : f.tone;

  const requiredVal  = planIncomplete ? '—' : formatMoney(f.requiredPerDayToPlan);
  const requiredSub  = planIncomplete ? 'план неполный' : `осталось ${f.remainingDays} дн.`;
  const requiredTone = planIncomplete ? 'neutral' : (f.remainingDays > 0 ? (f.paceVsPlan >= 100 ? 'good' : f.paceVsPlan >= 90 ? 'warn' : 'bad') : 'neutral');

  // Сравнение vs прошлый месяц
  const prev = summary.prevPeriod?.totals;
  const vsPrev = (key) => {
    if (!prev || !isNum(prev[key]) || prev[key] === 0) return '';
    const cur = summary.totals[key] || 0;
    const deltaPct = ((cur - prev[key]) / prev[key]) * 100;
    if (Math.abs(deltaPct) < 0.1) return '';
    const sign = deltaPct > 0 ? '↑' : '↓';
    const cls = deltaPct > 0 ? 'kpi-delta-up' : 'kpi-delta-down';
    return ` <span class="kpi-delta ${cls}">${sign}${Math.abs(deltaPct).toFixed(0)}% vs прошл.мес</span>`;
  };

  // === Подпись «План на месяц»: «осталось на сегодня» (до плана-на-сегодня) ===
  const planRemainingToday = Math.max(0, planToDate - factToDate);
  let planSub;
  if (planIncomplete) planSub = 'возможно неполный';
  else if (planRemainingToday > 0) planSub = `осталось на сегодня: ${fmtMoneyShort(planRemainingToday)}`;
  else planSub = `✓ план на сегодня выполнен (опережаем на ${fmtMoneyShort(-gapToDate)})`;

  // === Подпись «Факт»: сравнение с тем же днём прошлого года ===
  const elapsed = f.elapsedDays || 0;
  let factSub = `на ${elapsed}-й день месяца`;
  if (typeof today.yoyTodayFact === 'number' && today.yoyTodayFact > 0 && elapsed > 0) {
    const delta = factToDate - today.yoyTodayFact;
    const deltaPct = (delta / today.yoyTodayFact) * 100;
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    const cls = delta > 0 ? 'kpi-delta-up' : delta < 0 ? 'kpi-delta-down' : '';
    const ymd = `${elapsed}.${(today.yoyTodayPeriod || '').slice(5,7)}.${(today.yoyTodayPeriod || '').slice(0,4)}`;
    const label = today.yoyTodayYearsBack > 1
      ? `vs ${ymd} (${today.yoyTodayYearsBack} года назад)`
      : `vs ${ymd}`;
    factSub += ` · <span class="kpi-delta ${cls}">${arrow}${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(0)}% ${label}</span>`;
  } else if (elapsed > 0) {
    factSub += ' · vs прошл.год: нет данных';
  }

  // === «Выполнение плана»: главная цифра = % от плана МЕСЯЦА, подпись — темп vs плана-на-сегодня ===
  const dateStr = elapsed > 0 ? `${elapsed}.${(summary.period || '').slice(5,7)}` : '';
  let completionSubV2;
  if (planIncomplete) completionSubV2 = 'план неполный';
  else completionSubV2 = `темп: ${todayPct}% от плана на ${dateStr}`
    + (gapToDate > 0 ? ` · не хватает ${fmtMoneyShort(gapToDate)}` : ` · опережаем на ${fmtMoneyShort(-gapToDate)}`);

  // === «Прогноз»: явно про конец месяца + метод расчёта ===
  let projectedSubV2;
  if (planIncomplete) projectedSubV2 = 'план неполный';
  else {
    const methodTag = f.projectionMethod === 'yoy' ? ' · по прошлому году'
      : f.projectionMethod === 'per-store-linear'
        ? (f.projectionMeta?.newStoresCount > 0 ? ' · учёт новых точек' : ' · per-store')
      : f.projectionMethod === 'seasonal-dow' ? ' · учёт дней недели'
      : ' · линейный';
    projectedSubV2 = `${f.projectedCompletion}% к плану на конец месяца${methodTag}`;
  }

  // Для KPI 6-карточек на типичных экранах не помещаются 8-значные числа.
  // Очень короткий формат: «27.4 М ₽» / «945 К ₽» / «120 ₽».
  const moneyShort = (v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 1_000_000) {
      const m = v / 1_000_000;
      return (m >= 10 ? m.toFixed(1) : m.toFixed(2)).replace(/\.?0+$/, '') + ' М ₽';
    }
    if (Math.abs(v) >= 1000) return Math.round(v / 1000) + ' К ₽';
    return Math.round(v).toLocaleString('ru-RU') + ' ₽';
  };
  const cards = [
    { id: 'plan', label: 'План на месяц', value: moneyShort(summary.totals.plan),
      sub: planSub, tone: 'neutral',
      tip: 'Целевая сумма выручки сети к концу месяца (только СТС-точки из 1С УПП).' },
    { id: 'fact', label: 'Факт', value: moneyShort(summary.totals.fact),
      sub: factSub, tone: 'neutral',
      tip: 'Фактическая выручка сети с начала месяца на текущий момент. Сравнение «vs прошл.год» — с тем же днём (а не месяц целиком), чтобы было справедливо для незавершённого периода.' },
    { id: 'completion', label: 'Выполнение плана', value: completionVal,
      sub: completionSubV2, tone: completionTone,
      tip: 'Процент факта от плана МЕСЯЦА (до конца месяца). Подпись — темп: % факта от плана-на-сегодня (план месяца, пропорционально пройденным дням с учётом часа в Иркутске).' },
    { id: 'margin', label: 'Маржа', value: moneyShort(summary.totals.margin),
      sub: (isNum(summary.totals.marginPct) ? `${summary.totals.marginPct}% от выр.` : 'нет данных от 1С') + vsPrev('margin'),
      tone: !isNum(summary.totals.margin) ? 'neutral' : summary.totals.margin >= 0 ? 'good' : 'bad', cls: 'kpi-margin',
      tip: 'Валовая прибыль = факт − себестоимость. Когда 1С не передаёт себестоимость напрямую, считается через STORE_MARKUPS_JSON env (per-store markup% из отчёта «Валовая прибыль»).' },
    { id: 'projected', label: 'Прогноз', value: planIncomplete ? '—' : moneyShort(f.projectedFact), sub: projectedSubV2, tone: projectedTone,
      tip: 'Экстраполяция выручки до конца месяца. Приоритет методов: 1) YoY — дни прошлого года × коэффициент роста (учитывает праздники и сезонность); 2) Per-store — каждому магазину свой темп с учётом дня первой продажи (правильно для новых точек); 3) сезонный по дням недели; 4) линейный fallback. Кликни ▾ для деталей.' },
    { id: 'required', label: 'Нужно/день', value: planIncomplete ? '—' : moneyShort(f.requiredPerDayToPlan), sub: requiredSub, tone: requiredTone,
      tip: 'Сколько нужно делать выручки каждый оставшийся день, чтобы выйти ровно в план месяца. Если средний факт/день меньше этой цифры — план рискует.' }
  ];
  $('kpis').innerHTML = cards.map(c => `
    <article class="kpi ${c.tone} ${c.cls || ''}" data-kpi-id="${c.id}" tabindex="0" title="${escapeHtml(c.tip || '')}">
      <div class="kpi-label">
        <span>${c.label}</span>
        <span class="kpi-tip-icon" aria-label="Подсказка">ⓘ</span>
        <button class="kpi-expand" title="Подробнее">▾</button>
      </div>
      <div class="kpi-value">${c.value}</div>
      ${c.sub ? `<div class="kpi-sub">${c.sub}</div>` : ''}
    </article>`).join('');

  // Bind click → expand/collapse
  $('kpis').querySelectorAll('[data-kpi-id]').forEach(card => {
    card.addEventListener('click', (e) => {
      // Игнорим клик по ссылкам/кнопкам внутри подписи (sub)
      if (e.target.closest('a')) return;
      toggleKpiExpanded(card.dataset.kpiId);
    });
  });
}

// ── Развёртывание KPI-карточек ────────────────────────────────────────────
let kpiExpandedId = null;

function toggleKpiExpanded(id) {
  if (!state.summary) return;
  if (kpiExpandedId === id) { closeKpiDetail(); return; }
  kpiExpandedId = id;
  document.querySelectorAll('#kpis [data-kpi-id]').forEach(c => c.classList.toggle('kpi-active', c.dataset.kpiId === id));
  let detail = $('kpiDetailPanel');
  if (!detail) {
    detail = document.createElement('div');
    detail.id = 'kpiDetailPanel';
    detail.className = 'kpi-detail';
    $('kpis').after(detail);
  }
  detail.innerHTML = buildKpiDetail(id, state.summary);
  detail.classList.remove('hidden');
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeKpiDetail() {
  kpiExpandedId = null;
  document.querySelectorAll('#kpis [data-kpi-id]').forEach(c => c.classList.remove('kpi-active'));
  $('kpiDetailPanel')?.classList.add('hidden');
}

function buildKpiDetail(id, summary) {
  const t = summary.totals || {};
  const f = summary.forecast || {};
  const today = summary.today || {};
  const stores = summary.stores || [];
  const products = (summary.products || []).filter(p => p.productId !== '_total');
  const closeBtn = `<button class="kpi-detail-close" onclick="closeKpiDetail()">✕</button>`;
  const titles = { plan: 'План на месяц', fact: 'Факт', completion: 'Выполнение плана', margin: 'Маржа', projected: 'Прогноз', required: 'Нужно/день' };
  const header = `<div class="kpi-detail-header"><b>${titles[id] || ''}</b> · подробно ${closeBtn}</div>`;

  if (id === 'plan') {
    const topStores = stores.slice().sort((a, b) => b.plan - a.plan).slice(0, 10);
    const totalPlan = stores.reduce((s, x) => s + (x.plan || 0), 0);
    return header + `
      <div class="kpi-detail-cols">
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">Структура плана</div>
          <table class="kpi-detail-tbl">
            <tr><td>План/день</td><td class="num">${formatMoney(f.planPerDay || 0)}</td></tr>
            <tr><td>План на сегодня</td><td class="num">${formatMoney(today.planToDate || 0)}</td></tr>
            <tr><td>Осталось до плана-месяца</td><td class="num">${formatMoney(Math.max(0, t.plan - t.fact))}</td></tr>
            <tr><td>Точек с планом &gt; 0</td><td class="num">${stores.filter(s => s.plan > 0).length} из ${stores.length}</td></tr>
          </table>
        </div>
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">Топ-10 точек по плану</div>
          ${topStores.map(s => `
            <div class="kpi-detail-row">
              <span class="ki-name">${escapeHtml(s.storeName)}</span>
              <span class="ki-bar"><span class="ki-bar-fill" style="width:${totalPlan > 0 ? Math.min(100, s.plan / topStores[0].plan * 100) : 0}%"></span></span>
              <span class="ki-val">${fmtMoneyShort(s.plan)}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  if (id === 'fact') {
    const topStores = stores.slice().sort((a, b) => b.fact - a.fact).slice(0, 10);
    const max = topStores[0]?.fact || 1;
    const topProducts = products.slice().sort((a, b) => (b.fact || 0) - (a.fact || 0)).slice(0, 10);
    const maxP = topProducts[0]?.fact || 1;
    return header + `
      <div class="kpi-detail-cols">
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">Топ-10 точек по выручке</div>
          ${topStores.map(s => `
            <div class="kpi-detail-row">
              <span class="ki-name">${escapeHtml(s.storeName)}</span>
              <span class="ki-bar"><span class="ki-bar-fill" style="width:${s.fact / max * 100}%"></span></span>
              <span class="ki-val">${fmtMoneyShort(s.fact)}</span>
            </div>`).join('')}
        </div>
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">Топ-10 товаров по выручке</div>
          ${topProducts.map(p => `
            <div class="kpi-detail-row">
              <span class="ki-name">${escapeHtml(p.productName || p.name)}</span>
              <span class="ki-bar"><span class="ki-bar-fill" style="width:${(p.fact || 0) / maxP * 100}%"></span></span>
              <span class="ki-val">${fmtMoneyShort(p.fact || 0)}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  if (id === 'completion') {
    const withPlan = stores.filter(s => s.plan > 0);
    const above = withPlan.filter(s => s.percent >= 100).length;
    const ok = withPlan.filter(s => s.percent >= 80 && s.percent < 100).length;
    const below = withPlan.filter(s => s.percent < 80).length;
    const lagging = withPlan.slice().sort((a, b) => a.percent - b.percent).slice(0, 5);
    const leaders = withPlan.slice().sort((a, b) => b.percent - a.percent).slice(0, 5);
    return header + `
      <div class="kpi-detail-cols">
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">Распределение точек</div>
          <table class="kpi-detail-tbl">
            <tr><td><span class="good">●</span> ≥ 100%</td><td class="num">${above} из ${withPlan.length}</td></tr>
            <tr><td><span class="warn">●</span> 80–99%</td><td class="num">${ok}</td></tr>
            <tr><td><span class="bad">●</span> &lt; 80%</td><td class="num">${below}</td></tr>
            <tr><td>Средний %</td><td class="num">${withPlan.length ? Math.round(withPlan.reduce((s, x) => s + x.percent, 0) / withPlan.length) : 0}%</td></tr>
          </table>
        </div>
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">⬇ Отстающие</div>
          ${lagging.map(s => `<div class="kpi-detail-row"><span class="ki-name">${escapeHtml(s.storeName)}</span><span class="ki-val bad">${s.percent}%</span></div>`).join('')}
        </div>
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">⬆ Лидеры</div>
          ${leaders.map(s => `<div class="kpi-detail-row"><span class="ki-name">${escapeHtml(s.storeName)}</span><span class="ki-val good">${s.percent}%</span></div>`).join('')}
        </div>
      </div>`;
  }

  if (id === 'margin') {
    if (!isNum(t.margin)) return header + `<div class="empty-state" style="padding:14px">Нет данных о марже от 1С</div>`;
    const topStores = stores.filter(s => isNum(s.margin)).slice().sort((a, b) => (b.marginPct || 0) - (a.marginPct || 0)).slice(0, 10);
    const topProducts = products.filter(p => isNum(p.margin)).slice().sort((a, b) => b.margin - a.margin).slice(0, 10);
    return header + `
      <div class="kpi-detail-cols">
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">Топ-10 точек по марж.%</div>
          ${topStores.map(s => `
            <div class="kpi-detail-row">
              <span class="ki-name">${escapeHtml(s.storeName)}</span>
              <span class="ki-val">${s.marginPct}% · ${fmtMoneyShort(s.margin)}</span>
            </div>`).join('') || '<div class="empty-state">нет данных</div>'}
        </div>
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">Топ-10 товаров по марже</div>
          ${topProducts.map(p => `
            <div class="kpi-detail-row">
              <span class="ki-name">${escapeHtml(p.productName || p.name)}</span>
              <span class="ki-val">${fmtMoneyShort(p.margin)}</span>
            </div>`).join('') || '<div class="empty-state">нет данных</div>'}
        </div>
      </div>`;
  }

  if (id === 'projected') {
    const meta = f.projectionMeta || {};
    let methodLine;
    if (f.projectionMethod === 'yoy') {
      methodLine = `Метод: <b>по прошлому году (YoY)</b> — для каждого оставшегося дня берём факт того же дня в <b>${meta.basePeriod || 'baseline'}</b>, умножаем на коэффициент роста сети <b>${meta.growthRate || '?'}×</b>. <br><small style="color:var(--muted)">Автоматически учитывает праздники и сезонность реального прошлого года. НЕ учитывает новые точки открытые после ${meta.basePeriod || 'baseline'}.</small>`;
    } else if (f.projectionMethod === 'per-store-linear') {
      const newPart = meta.newStoresCount > 0
        ? `<b>${meta.newStoresCount}</b> магазинов без продаж в ${meta.prevPeriod || 'предыдущем месяце'} (новые/перезапуск) — их темп считаем за половину пройденных дней, не за весь месяц.`
        : `Все ${meta.storesCount || '?'} магазинов работали в ${meta.prevPeriod || 'предыдущем месяце'} — каждому свой линейный темп.`;
      methodLine = `Метод: <b>per-store linear</b> — каждому магазину собственный темп, сумма всех. <br><small style="color:var(--muted)">${newPart} Используется потому что YoY невозможен (нет адекватного baseline) либо его рост &gt;3×.</small>`;
    } else if (f.projectionMethod === 'seasonal-dow') {
      methodLine = `Метод: <b>сезонный по дням недели</b> — коэффициенты из последних 120 дней (Сб обычно +50%, Пн -20%). <br><small style="color:var(--muted)">Использован потому что для YoY нет данных за тот же месяц год назад.</small>`;
    } else {
      methodLine = `Метод: <b>линейный</b> — средний темп × оставшиеся дни. <br><small style="color:var(--muted)">Fallback когда нет YoY и нет 120-дн истории для DoW.</small>`;
    }
    const lines = [
      `Прогноз = факт на сегодня + ожидаемые продажи за оставшиеся ${f.remainingDays || 0} дней`,
      methodLine,
      `Средний темп факта: ${formatMoney(f.averagePerDay || 0)} / день`,
      `Темп плана: ${formatMoney(f.planPerDay || 0)} / день`,
      `Разрыв с планом: ${formatMoney(f.runwayGap || 0)} (отрицательный = опередим план)`
    ];
    return header + `
      <div class="kpi-detail-section">
        <div class="kpi-detail-title">Как считается прогноз</div>
        <ul class="kpi-detail-list">${lines.map(x => `<li>${x}</li>`).join('')}</ul>
      </div>`;
  }

  if (id === 'required') {
    const withPlan = stores.filter(s => s.plan > 0);
    const perStore = withPlan.map(s => ({
      name: s.storeName,
      gap: Math.max(0, s.plan - s.fact),
      perDay: f.remainingDays > 0 ? Math.max(0, (s.plan - s.fact) / f.remainingDays) : 0,
      pct: s.percent
    })).sort((a, b) => b.perDay - a.perDay);
    const top10 = perStore.slice(0, 10);
    const max = top10[0]?.perDay || 1;
    return header + `
      <div class="kpi-detail-cols">
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">Сводка</div>
          <table class="kpi-detail-tbl">
            <tr><td>Осталось дней</td><td class="num">${f.remainingDays || 0}</td></tr>
            <tr><td>Текущий темп/день</td><td class="num">${formatMoney(f.averagePerDay || 0)}</td></tr>
            <tr><td>Нужный темп/день</td><td class="num">${formatMoney(f.requiredPerDayToPlan || 0)}</td></tr>
            <tr><td>Точек на цели</td><td class="num">${withPlan.filter(s => s.percent >= 100).length} из ${withPlan.length}</td></tr>
          </table>
        </div>
        <div class="kpi-detail-section">
          <div class="kpi-detail-title">Кому больше всего нужно/день</div>
          ${top10.map(s => `
            <div class="kpi-detail-row">
              <span class="ki-name">${escapeHtml(s.name)} <small class="muted">(${s.pct}%)</small></span>
              <span class="ki-bar"><span class="ki-bar-fill" style="width:${s.perDay / max * 100}%"></span></span>
              <span class="ki-val">${fmtMoneyShort(s.perDay)}/день</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  return header + `<div class="empty-state">—</div>`;
}

// ── Авто-определение «маржа недоступна» — скрывает margin-колонки/карточки ────
function applyMarginVisibility(summary) {
  const stores = summary?.stores || [];
  const noMargin = stores.length > 0 && !stores.some(s => isNum(s.margin));
  document.body.classList.toggle('no-margin-data', noMargin);
}

// ── Бейдж источника данных по магазину (1С: розница / упр.учёт) ──────────────
const SOURCE_LABELS = { retail: 'Розница', corporate: 'Упр.учёт', wholesale: 'Опт' };
function renderSourceBadge(source) {
  if (!source) return '';
  const label = SOURCE_LABELS[source] || source;
  return ` <span class="store-source store-source-${source}">${label}</span>`;
}

// ── Баннер «План на текущий месяц похож на накопительный» ────────────────────
function renderPlanHealth(summary) {
  const el = $('planHealthBanner');
  if (!el) return;
  const ph = summary?.planHealth;
  const incomplete = ph && ph.ok === false && ph.kind === 'accumulated';
  document.body.classList.toggle('plan-incomplete', incomplete);
  if (!incomplete) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="phb-icon">⚠</div>
    <div class="phb-body">
      <div class="phb-title">План текущего месяца возможно неполный</div>
      <div class="phb-text">
        Сейчас в дашборде <strong>${formatMoney(ph.currentPlan)}</strong>,
        но прошлый месяц был <strong>${formatMoney(ph.previousPlan)}</strong>.
        Похоже, 1С прислал план только за прошедшие дни месяца
        (${ph.elapsedRatio}% от месяца), а не на весь май.
        Покажите 1С-разработчику: в запросе плана <code>КонецПериода</code>
        нужно установить как <code>КонецМесяца(НачПериода)</code>, а не <code>ТекущаяДата()</code>.
      </div>
    </div>
  `;
}

// ── Forecast ───────────────────────────────────────────────────────────────
function renderForecast(summary) {
  const f = summary.forecast;
  const planIncomplete = summary?.planHealth && summary.planHealth.ok === false;
  const paceTone = planIncomplete ? 'neutral' : (f.paceVsPlan >= 100 ? 'good' : f.paceVsPlan >= 90 ? 'warn' : 'bad');

  // При неполном плане прячем все вычисления, зависящие от плана
  const projectedFactStr      = planIncomplete ? '—' : formatMoney(f.projectedFact);
  const projectedCompletionStr = planIncomplete ? '—' : `${f.projectedCompletion}%`;
  const runwayGapStr          = planIncomplete ? '—' : formatMoney(f.runwayGap);
  const requiredStr           = planIncomplete ? '—' : formatMoney(f.requiredPerDayToPlan);
  const planPerDayStr         = planIncomplete ? '—' : formatMoney(f.planPerDay);
  const paceVsPlanStr         = planIncomplete ? '—' : `${f.paceVsPlan}%`;
  const fcTitle               = planIncomplete ? 'План неполный — прогноз недоступен' : f.status;
  const fcTone                = planIncomplete ? 'neutral' : f.tone;
  const runwayClass           = planIncomplete ? '' : (f.runwayGap >= 0 ? 'positive' : 'negative');

  $('forecastPanel').innerHTML = `
    <article class="fc-card ${fcTone}">
      <div class="fc-kicker">Прогноз</div>
      <div class="fc-title">${fcTitle}</div>
      <div class="fc-rows">
        <div class="fc-row"><span>К концу месяца</span><strong>${projectedFactStr}</strong></div>
        <div class="fc-row"><span>Ожидаемое %</span><strong>${projectedCompletionStr}</strong></div>
        <div class="fc-row"><span>Разрыв прогноза</span><strong class="${runwayClass}">${runwayGapStr}</strong></div>
      </div>
    </article>
    <article class="fc-card neutral">
      <div class="fc-kicker">Ритм</div>
      <div class="fc-title">Ежедневный темп</div>
      <div class="fc-rows">
        <div class="fc-row"><span>Средний факт/день</span><strong>${formatMoney(f.averagePerDay)}</strong></div>
        <div class="fc-row"><span>Нужно/день к плану</span><strong>${requiredStr}</strong></div>
        <div class="fc-row"><span>План/день</span><strong>${planPerDayStr}</strong></div>
      </div>
    </article>
    <article class="fc-card ${paceTone}">
      <div class="fc-kicker">Период</div>
      <div class="fc-title">Где мы сейчас</div>
      <div class="fc-rows">
        <div class="fc-row"><span>Прошло дней</span><strong>${f.elapsedDays} / ${f.totalDays}</strong></div>
        <div class="fc-row"><span>Осталось</span><strong>${f.remainingDays} дн.</strong></div>
        <div class="fc-row"><span>Темп к плану</span><strong>${paceVsPlanStr}</strong></div>
      </div>
    </article>`;
}

// ── Comparison ─────────────────────────────────────────────────────────────
function renderCmpCard(label, c) {
  if (!c?.hasData) {
    return `<div class="cmp-card neutral">
      <div class="cmp-period">${label}</div>
      <div class="empty-state" style="padding:8px 0">Нет данных.</div>
    </div>`;
  }
  const tone = c.factDelta >= 0 ? 'good' : 'bad';
  return `<div class="cmp-card ${tone}">
    <div class="cmp-period">${label} (${c.previousPeriod})</div>
    <div class="cmp-rows">
      <div class="cmp-row"><span>Факт</span><strong class="${c.factDelta >= 0 ? 'positive' : 'negative'}">${signed(c.factDelta, formatMoney)}</strong></div>
      <div class="cmp-row"><span>Изм. %</span><strong class="${c.factDelta >= 0 ? 'positive' : 'negative'}">${signed(c.factDeltaPercent, v => v.toFixed(1) + '%')}</strong></div>
      <div class="cmp-row"><span>Выполнение</span><strong class="${c.completionDelta >= 0 ? 'positive' : 'negative'}">${signed(c.completionDelta, v => v.toFixed(1) + ' п.п.')}</strong></div>
      <div class="cmp-row cmp-row-margin"><span>Маржа</span><strong class="${!isNum(c.marginDelta) ? '' : c.marginDelta >= 0 ? 'positive' : 'negative'}">${isNum(c.marginDelta) ? signed(c.marginDelta, formatMoney) : '—'}</strong></div>
      <div class="cmp-row"><span>Количество</span><strong class="${c.quantityDelta >= 0 ? 'positive' : 'negative'}">${signed(c.quantityDelta, formatNum)}</strong></div>
    </div>
  </div>`;
}

function renderComparison(summary) {
  const yoyLabel = summary.yoy?.yearsBack > 1
    ? `vs. тот же месяц ${summary.yoy.yearsBack} года назад`
    : 'vs. тот же месяц год назад';
  $('comparisonPanel').innerHTML =
    renderCmpCard('vs. прошлый месяц', summary.comparison) +
    renderCmpCard(yoyLabel, summary.yoy);
}

// ── Spotlight ──────────────────────────────────────────────────────────────
function renderSpotlight(summary) {
  const l = summary.leader, lg = summary.lagger;
  const planIncomplete = summary?.planHealth && summary.planHealth.ok === false;
  // Если backend нашёл настоящего лидера по проценту — показываем %.
  // Если только топ по выручке (leaderKind=revenue) — показываем сумму
  // и меняем заголовок, чтобы не вводить в заблуждение.
  const leaderByRevenueOnly = l && l.leaderKind === 'revenue';
  const leaderLabel = leaderByRevenueOnly ? 'Топ по выручке' : 'Лидер';
  const lPctStr  = planIncomplete
    ? formatMoney(l?.fact || 0)
    : leaderByRevenueOnly
      ? formatMoney(l?.fact || 0)
      : `${l ? l.percent : 0}%`;
  const lgPctStr = planIncomplete ? formatMoney(lg?.fact || 0) : `${lg ? lg.percent : 0}%`;
  const lMeta    = planIncomplete
    ? 'факт (% при неполном плане)'
    : leaderByRevenueOnly
      ? `${l.percent}% плана (нет лидеров ≥100%)`
      : (l ? formatMoney(l.fact) : '');
  const lgMeta   = planIncomplete ? 'факт (% при неполном плане)' : (lg ? formatMoney(lg.gap) : '');
  $('spotlight').innerHTML = `
    <div class="spot-card leader">
      <div class="spot-label">${leaderLabel}</div>
      <div class="spot-name">${l ? l.storeName : '—'}</div>
      <div class="spot-value">${lPctStr}</div>
      <div class="spot-meta">${lMeta}</div>
    </div>
    <div class="spot-card lagger">
      <div class="spot-label">Риск</div>
      <div class="spot-name">${lg ? lg.storeName : '—'}</div>
      <div class="spot-value">${lgPctStr}</div>
      <div class="spot-meta">${lgMeta}</div>
    </div>
    <div class="spot-card neutral">
      <div class="spot-label">Последняя продажа</div>
      <div class="spot-name">${formatDate(summary.lastSaleAt)}</div>
      <div class="spot-meta">Период ${summary.period}</div>
    </div>`;
}

// ── Stores table ───────────────────────────────────────────────────────────
function renderStores(summary) {
  const { key, dir } = state.storeSort;
  const sorted = [...summary.stores].sort((a, b) => {
    if (key === 'avgCheck') {
      const ac = a.quantity > 0 ? a.fact / a.quantity : 0;
      const bc = b.quantity > 0 ? b.fact / b.quantity : 0;
      return (ac - bc) * dir;
    }
    if (typeof a[key] === 'string') return a[key].localeCompare(b[key]) * dir;
    return (a[key] - b[key]) * dir;
  });

  const sortLabels = {
    storeName: 'Точка', fact: 'Факт', plan: 'План', percent: '%',
    margin: 'Маржа', marginPct: 'Марж.%', avgCheck: 'Ср. чек', quantity: 'Шт'
  };
  document.querySelectorAll('#storesTableEl th.sortable').forEach(th => {
    const k = th.dataset.sort;
    th.textContent = (sortLabels[k] || k) + (k === key ? (dir === -1 ? ' ↓' : ' ↑') : '');
  });

  // Тренд = текущий % vs % того же магазина в прошлом месяце (из prevPeriod.storesPercent)
  const prevPct = summary.prevPeriod?.storesPercent || {};
  // YoY = vs тот же магазин год назад (или 2 года, если за прошлый год пусто)
  const yoyPct = summary.yoy?.storesPercent || {};
  const yoyYearsBack = summary.yoy?.yearsBack || 1;

  const buildDeltaCell = (cur, prev, prevLabel) => {
    if (!(typeof prev === 'number' && prev > 0)) {
      return `<span class="trend-cell neutral" title="${prevLabel}: нет данных">—</span>`;
    }
    const delta = (cur || 0) - prev;
    const arr = delta > 1 ? '↑' : delta < -1 ? '↓' : '→';
    const trTone = delta > 1 ? 'good' : delta < -1 ? 'bad' : 'neutral';
    const sign = delta > 0 ? '+' : '';
    return `<span class="trend-cell ${trTone}" title="${prevLabel}: ${prev}% → ${cur}%">${arr} ${sign}${delta.toFixed(0)} п.п.</span>`;
  };

  $('storesTable').innerHTML = sorted.map((s, idx) => {
    const avgCheck = s.quantity > 0 ? s.fact / s.quantity : 0;
    const tone = pctTone(s.percent);
    const trendHtml = buildDeltaCell(s.percent, prevPct[s.storeId], 'vs прошлый месяц');
    const yoyLabel = yoyYearsBack > 1 ? `vs ${yoyYearsBack} года назад` : 'vs тот же месяц год назад';
    const yoyHtml = buildDeltaCell(s.percent, yoyPct[s.storeId], yoyLabel);
    return `
    <tr data-store-id="${s.storeId}" class="${state.selectedStoreId === s.storeId ? 'active' : ''}">
      <td class="col-num">${idx + 1}</td>
      <td>${s.storeName}${renderSourceBadge(s.source)}<br><small class="muted">${s.region || ''}</small></td>
      <td class="num">${formatMoney(s.fact)}</td>
      <td class="num">${formatMoney(s.plan)}</td>
      <td class="num">
        <div class="pct-cell">
          <div class="pct-val ${tone}">${s.percent}%</div>
          <div class="pct-track"><div class="pct-bar ${tone}" style="width:${Math.min(s.percent, 140)}%"></div></div>
        </div>
      </td>
      <td class="num col-margin ${!isNum(s.margin) ? '' : s.margin >= 0 ? 'positive' : 'negative'}">${formatMoney(s.margin)}</td>
      <td class="num col-margin ${!isNum(s.marginPct) ? '' : s.marginPct >= 20 ? 'good' : s.marginPct >= 10 ? 'warn' : 'bad'}">${formatPct(s.marginPct)}</td>
      <td class="num">${avgCheck > 0 ? formatMoney(avgCheck) : '—'}</td>
      <td class="num">${formatNum(s.quantity)}</td>
      <td class="num">${trendHtml}</td>
      <td class="num col-hide-md">${yoyHtml}</td>
      <td class="col-edit no-print">
        <button class="edit-plan-btn" data-store-id="${s.storeId}" title="Редактировать план">✎</button>
      </td>
    </tr>`;
  }).join('');

  document.querySelectorAll('#storesTable tr').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.edit-plan-btn')) return;
      state.selectedStoreId = row.dataset.storeId;
      const store = sorted.find(s => s.storeId === row.dataset.storeId);
      if (store) $('storeDetailTitle').textContent = store.storeName;
      renderStores(summary);
      loadStoreDetails();
    });
  });

  document.querySelectorAll('.edit-plan-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openPlanEdit(btn.dataset.storeId, sorted);
    });
  });
}

// ── Plan edit modal ────────────────────────────────────────────────────────
function openPlanEdit(storeId, stores) {
  const store = stores.find(s => s.storeId === storeId);
  if (!store) return;
  state.editStoreId = storeId;

  $('modalStoreName').textContent = store.storeName + (store.region ? ` · ${store.region}` : '');

  fetchJson(`/api/dashboard/store?period=${encodeURIComponent(state.period)}&storeId=${encodeURIComponent(storeId)}`).then(d => {
    const allItems = d.items || [];
    const items = allItems.filter(item => item.productId !== '_total');
    const totalAggregate = allItems.find(item => item.productId === '_total');
    state.editPlanData = items.map(item => ({ ...item, newPlan: item.plan }));

    if (items.length === 0 && totalAggregate) {
      // План задан только агрегатом по магазину — редактирование по товарам невозможно
      $('planEditBody').innerHTML = `
        <tr>
          <td colspan="3" style="padding:18px;text-align:center;color:var(--muted);font-size:13px;line-height:1.55">
            План этой точки задан агрегатом по магазину
            (<strong>${formatMoney(totalAggregate.plan)}</strong>),
            без разбивки по товарам.<br>
            <span class="muted" style="font-size:12px">Чтобы изменить — отредактируйте план в 1С.</span>
          </td>
        </tr>`;
    } else if (items.length === 0) {
      $('planEditBody').innerHTML = `
        <tr><td colspan="3" style="padding:18px;text-align:center;color:var(--muted);font-size:13px">Нет товаров для редактирования.</td></tr>`;
    } else {
      $('planEditBody').innerHTML = state.editPlanData.map((item, i) => `
        <tr>
          <td>${item.productName}<br><small class="muted">${item.category || ''}</small></td>
          <td class="num">${formatMoney(item.plan)}</td>
          <td class="num">
            <input class="plan-edit-input" data-idx="${i}" type="number" value="${item.plan}" min="0" step="1000" />
          </td>
        </tr>`).join('');

      document.querySelectorAll('.plan-edit-input').forEach(input => {
        input.addEventListener('change', e => {
          const idx = Number(e.target.dataset.idx);
          state.editPlanData[idx].newPlan = Number(e.target.value) || 0;
        });
      });
    }

    $('planEditModal').classList.remove('hidden');
  }).catch(() => alert('Ошибка загрузки данных точки'));
}

async function savePlanEdit() {
  const changed = state.editPlanData.filter(item => item.newPlan !== item.plan);
  if (!changed.length) { closePlanEdit(); return; }

  $('planSaveBtn').disabled = true;
  $('planSaveBtn').textContent = 'Сохранение...';

  try {
    for (const item of changed) {
      await fetchJson('/api/plans/item', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: state.period,
          storeId: state.editStoreId,
          productId: item.productId,
          amount: item.newPlan
        })
      });
    }
    closePlanEdit();
    await loadSummary();
  } catch (err) {
    alert('Ошибка сохранения: ' + err.message);
  } finally {
    $('planSaveBtn').disabled = false;
    $('planSaveBtn').textContent = 'Сохранить изменения';
  }
}

function closePlanEdit() {
  $('planEditModal').classList.add('hidden');
  state.editStoreId = '';
  state.editPlanData = [];
}

function productDisplayName(p) {
  if (p.productId === '_total' || p.productName === '_total') return 'ИТОГО по магазину';
  return p.productName || p.productId;
}

// ── Products list ──────────────────────────────────────────────────────────
const PRODUCTS_PAGE_SIZE = 5;
function renderProducts(summary) {
  const sorted = [...summary.products]
    .filter(p => p.productId !== '_total')
    .sort((a, b) => b[state.productSort] - a[state.productSort]);

  const expanded = state.productsExpanded === true;
  const visible = expanded ? sorted : sorted.slice(0, PRODUCTS_PAGE_SIZE);
  const hidden = sorted.length - visible.length;

  const items = visible.map(p => {
    const tone = pctTone(p.percent);
    return `
    <div class="prod-item" data-product-id="${p.productId}" title="Клик — разбивка по магазинам">
      <div class="prod-head">
        <div>
          <div class="prod-name">${productDisplayName(p)}</div>
          <div class="prod-cat">${p.category || 'Без категории'}</div>
        </div>
        <div class="prod-pct ${tone}">${p.percent}%</div>
      </div>
      <div class="prod-track"><div class="prod-bar ${tone}" style="width:${Math.min(p.percent, 100)}%"></div></div>
      <div class="prod-foot">
        <span>Факт: ${formatMoney(p.fact)}</span>
        <span>Маржа: ${formatMoney(p.margin)}</span>
        <span>Шт: ${formatNum(p.quantity)}</span>
      </div>
    </div>`;
  }).join('');

  let toggle = '';
  if (sorted.length > PRODUCTS_PAGE_SIZE) {
    toggle = expanded
      ? `<button id="productsToggleBtn" class="products-toggle no-print">Свернуть</button>`
      : `<button id="productsToggleBtn" class="products-toggle no-print">Показать ещё (${hidden})</button>`;
  }

  $('productsList').innerHTML = items + toggle;

  // Bind click → drill-down модалка
  $('productsList').querySelectorAll('.prod-item[data-product-id]').forEach(el => {
    el.addEventListener('click', () => {
      const pid = el.dataset.productId;
      const p = sorted.find(x => x.productId === pid);
      if (p) showDrillDownProduct(p);
    });
  });

  const btn = $('productsToggleBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      state.productsExpanded = !expanded;
      renderProducts(summary);
    });
  }
}

// ── Store details ──────────────────────────────────────────────────────────
async function loadStoreDetails() {
  const el = $('storeDetails');
  if (!state.selectedStoreId) {
    el.innerHTML = '<div class="empty-state">Нажмите на строку таблицы, чтобы увидеть детализацию по товарам</div>';
    return;
  }
  const d = await fetchJson(`/api/dashboard/store?period=${encodeURIComponent(state.period)}&storeId=${encodeURIComponent(state.selectedStoreId)}`);
  const items = (d.items || []).filter(item => item.productId !== '_total');
  if (!items.length) {
    el.innerHTML = '<div class="empty-state">Нет данных за период.</div>';
    return;
  }
  el.innerHTML = `<div class="detail-rows">
    ${items.map(item => {
      const tone = pctTone(item.percent);
      return `
      <div class="detail-row">
        <div>
          <div class="detail-product">${item.productName}</div>
          <div class="detail-cat">${item.category || 'Без категории'}</div>
        </div>
        <div class="detail-right">
          <div class="detail-fact">${formatMoney(item.fact)}</div>
          <div class="detail-sub">план: ${formatMoney(item.plan)}</div>
          <div class="detail-pct ${tone}">${item.percent}%</div>
          ${isNum(item.margin) ? `<div class="detail-sub ${item.margin >= 0 ? 'positive' : 'negative'}">маржа: ${formatMoney(item.margin)}</div>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
  loadStoreNotes();
}

// ── Store notes (события магазина) ────────────────────────────────────────
async function loadStoreNotes() {
  const block = $('storeNotesBlock');
  const listEl = $('storeNotesList');
  if (!block || !listEl || !state.selectedStoreId) { block?.classList.add('hidden'); return; }
  block.classList.remove('hidden');
  try {
    const data = await fetchJson(`/api/comments?storeId=${encodeURIComponent(state.selectedStoreId)}`);
    const notes = (data.comments || []).slice(0, 20);
    listEl.innerHTML = notes.length
      ? notes.map(n => `
          <div class="store-note">
            <div class="store-note-meta">${n.eventDate || ''}${n.author ? ' · ' + escapeHtml(n.author) : ''}</div>
            <div class="store-note-text">${escapeHtml(n.text)}</div>
          </div>`).join('')
      : '<div class="empty-state" style="padding:8px;font-size:12px">Нет событий по этой точке</div>';
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

async function submitStoreNote(e) {
  e.preventDefault();
  const dateEl = $('storeNoteDate');
  const textEl = $('storeNoteText');
  if (!dateEl || !textEl || !state.selectedStoreId) return;
  try {
    await fetchJson('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        period: state.period,
        text: textEl.value.trim(),
        storeId: state.selectedStoreId,
        eventDate: dateEl.value || null,
        author: state.currentUser?.name || 'Менеджер'
      })
    });
    textEl.value = '';
    loadStoreNotes();
  } catch (err) {
    alert('Ошибка: ' + err.message);
  }
}

// ── Comments ───────────────────────────────────────────────────────────────
async function loadComments() {
  try {
    const data = await fetchJson(`/api/comments?period=${encodeURIComponent(state.period)}`);
    state.comments = data.comments || [];
    renderComments();
  } catch { state.comments = []; renderComments(); }
}

function renderComments() {
  const el = $('commentsList');
  if (!el) return;
  if (!state.comments.length) {
    el.innerHTML = '<div class="empty-state" style="padding:12px 0">Нет заметок за этот период.</div>';
    return;
  }
  el.innerHTML = state.comments.map(c => `
    <div class="comment-card">
      <div class="comment-header">
        <span class="comment-author">${c.author || 'Менеджер'}</span>
        <span class="comment-date">${formatDate(c.createdAt)}</span>
        <button class="comment-del-btn no-print" data-id="${c.id}" title="Удалить">×</button>
      </div>
      <div class="comment-text">${escapeHtml(c.text)}</div>
    </div>`).join('');

  el.querySelectorAll('.comment-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить заметку?')) return;
      try {
        await fetchJson(`/api/comments/${btn.dataset.id}`, { method: 'DELETE' });
        await loadComments();
      } catch (err) { alert('Ошибка: ' + err.message); }
    });
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

function initComments() {
  $('addCommentBtn').addEventListener('click', () => {
    $('commentForm').classList.toggle('hidden');
  });
  $('commentCancelBtn').addEventListener('click', () => {
    $('commentForm').classList.add('hidden');
    $('commentText').value = '';
  });
  $('commentSaveBtn').addEventListener('click', async () => {
    const text = $('commentText').value.trim();
    if (!text) return;
    const author = $('commentAuthor').value.trim() || 'Менеджер';
    try {
      await fetchJson('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: state.period, text, author })
      });
      $('commentText').value = '';
      $('commentForm').classList.add('hidden');
      await loadComments();
    } catch (err) { alert('Ошибка: ' + err.message); }
  });
}

// ── 1С UPP Guide modal ─────────────────────────────────────────────────────
function initUppGuide() {
  $('uppGuideBtn').addEventListener('click', () => {
    $('uppGuideContent').innerHTML = getUppGuideHtml();
    $('uppGuideModal').classList.remove('hidden');
  });
  $('uppGuideClose').addEventListener('click', () => $('uppGuideModal').classList.add('hidden'));
  $('uppGuideModal').addEventListener('click', e => { if (e.target === $('uppGuideModal')) $('uppGuideModal').classList.add('hidden'); });
}

function getUppGuideHtml() {
  return `
  <div class="guide-section">
    <div class="guide-title">Автоматическая выгрузка из 1С УПП</div>
    <p class="guide-text">Дашборд принимает данные через REST API. Настройте регламентное задание в 1С для отправки данных раз в час.</p>
  </div>

  <div class="guide-section">
    <div class="guide-subtitle">Эндпоинт для выгрузки (универсальный формат УПП)</div>
    <code class="guide-code">POST ${window.location.origin}/api/ingest/upp
X-API-Key: &lt;ваш ключ&gt;
Content-Type: application/json</code>
  </div>

  <div class="guide-section">
    <div class="guide-subtitle">Формат тела запроса</div>
    <code class="guide-code">{
  "packageId": "2026-04-001",
  "sourceSystem": "1С:УПП",
  "sourceObject": "Отчёт_ПланФакт",
  "period": "2026-04",
  "stores": [{ "id": "store1", "name": "Мария Центр", "region": "Иркутск" }],
  "products": [{ "id": "cake", "name": "Торты", "category": "Торты" }],
  "plans": [{ "storeId": "store1", "productId": "cake", "amount": 500000 }],
  "sales": [{ "storeId": "store1", "productId": "cake", "amount": 480000,
              "cost": 280000, "quantity": 48, "soldAt": "2026-04-15T10:00:00Z" }]
}</code>
  </div>

  <div class="guide-section">
    <div class="guide-subtitle">Настройка обработчика в 1С (псевдокод)</div>
    <code class="guide-code">// Создать ВнешнююОбработку или РегламентноеЗадание
Процедура ОтправитьДашборд()
  HTTP = Новый HTTPСоединение("${window.location.hostname}", ${window.location.port || 443});
  Запрос = Новый HTTPЗапрос("/api/ingest/upp");
  Запрос.Заголовки["X-API-Key"] = "ваш-ключ";
  Запрос.Заголовки["Content-Type"] = "application/json";
  Запрос.УстановитьТелоИзСтроки(СформироватьJSON());
  Ответ = HTTP.ОтправитьДляОбработки(Запрос);
КонецПроцедуры</code>
  </div>

  <div class="guide-section">
    <div class="guide-subtitle">Telegram-уведомления</div>
    <p class="guide-text">Для получения алертов в Telegram, установите переменные окружения на сервере:</p>
    <code class="guide-code">TELEGRAM_BOT_TOKEN=ваш_токен_бота
TELEGRAM_CHAT_ID=ваш_chat_id</code>
    <p class="guide-text">Алерт отправляется автоматически при загрузке данных, если любая точка ниже 80% плана.</p>
  </div>

  <div class="guide-section">
    <div class="guide-subtitle">PIN-защита дашборда</div>
    <p class="guide-text">Серверный PIN: установите переменную окружения <code>DASHBOARD_PIN=1234</code>.<br>
    Клиентский PIN: нажмите кнопку 🔒 в шапке дашборда.</p>
  </div>

  <div class="guide-section">
    <div class="guide-subtitle">Отдельные эндпоинты</div>
    <code class="guide-code">POST /api/ingest/plans   — только планы
POST /api/ingest/sales   — только продажи</code>
  </div>`;
}

// ── CSV export ─────────────────────────────────────────────────────────────
// ─── Cmd/Ctrl+K Command palette ────────────────────────────────────────────
let cmdkSelectedIdx = 0;
let cmdkLastResults = [];

function cmdkActionsList() {
  const summary = state.summary;
  const stores = summary?.stores || [];
  const products = summary?.products || [];
  const periods = (window.__metaPeriods__ || []).slice(0, 24);

  const actions = [];
  // Магазины
  for (const s of stores) {
    actions.push({
      group: 'Магазин',
      title: s.storeName,
      sub: `${formatMoneyShort(s.fact)} / ${formatMoneyShort(s.plan)} · ${s.percent}%`,
      score: 1,
      run: () => {
        state.selectedStoreId = s.storeId;
        $('storeDetailTitle').textContent = s.storeName;
        loadStoreDetails();
        document.querySelectorAll('#storesTbl tbody tr').forEach(r => r.classList.toggle('active', r.dataset.storeId === s.storeId));
        $('storeDetailTitle')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }
  // Товары (топ-300 по факту — иначе слишком много)
  const topProducts = products.slice().sort((a, b) => (b.fact || 0) - (a.fact || 0)).slice(0, 300);
  for (const p of topProducts) {
    actions.push({
      group: 'Товар',
      title: p.productName || p.name,
      sub: `${formatMoneyShort(p.fact || 0)} · ${p.quantity || 0} шт${p.category ? ' · ' + p.category : ''}`,
      score: 1,
      run: () => {
        // Прокрутить к таблице товаров + временно подсветить
        const el = $('productsList'); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        showDrillDownProduct(p);
      }
    });
  }
  // Периоды
  for (const period of periods) {
    actions.push({
      group: 'Период',
      title: period,
      sub: 'Сменить период дашборда',
      score: 1,
      run: () => {
        state.period = period;
        $('periodSelect').value = period;
        loadSummary();
      }
    });
  }
  // Табы аналитики
  const tabs = [
    { id: 'network', title: 'Сеть' },
    { id: 'products', title: 'Товары' },
    { id: 'time', title: 'Время' },
    { id: 'returns', title: 'Возвраты' },
    { id: 'comparison', title: 'Сравнение' },
    { id: 'customers', title: 'Клиенты' },
    { id: 'promo', title: 'Промо' }
  ];
  for (const t of tabs) {
    actions.push({
      group: 'Раздел',
      title: 'Аналитика · ' + t.title,
      sub: 'Перейти на вкладку',
      score: 1,
      run: () => { switchPage('analytics'); switchAnalyticsTab(t.id); }
    });
  }
  // Команды
  const commands = [
    { title: 'Открыть AI-чат «Маша»', sub: 'Спросить про продажи', run: () => openAiChat() },
    { title: 'Скачать таб (TSV)', sub: 'Экспорт текущего таба в Excel-формат', run: () => exportFullTab() },
    { title: 'Печать / PDF', sub: 'Окно печати браузера', run: () => window.print() },
    { title: 'Обновить данные', sub: 'Перезагрузить дашборд', run: () => loadSummary() },
    { title: 'Выйти', sub: 'Удалить сессию и cookies', run: () => doLogout() }
  ];
  for (const c of commands) actions.push({ group: 'Действие', ...c, score: 1 });
  return actions;
}

function cmdkFilter(query) {
  const q = query.trim().toLowerCase();
  const all = cmdkActionsList();
  if (!q) return all.slice(0, 80);
  return all
    .map((a) => {
      const haystack = (a.title + ' ' + (a.sub || '')).toLowerCase();
      let score = 0;
      // Subsequence fuzzy match
      let qi = 0;
      for (let i = 0; i < haystack.length && qi < q.length; i++) {
        if (haystack[i] === q[qi]) { score += (qi === 0 ? 3 : 1); qi++; }
      }
      const matched = qi === q.length;
      if (!matched) return null;
      // Бонус если первое слово совпадает
      if (haystack.startsWith(q)) score += 10;
      if (haystack.includes(q)) score += 5;
      return { ...a, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 80);
}

function renderCmdkResults(query) {
  const box = $('cmdkResults');
  if (!box) return;
  const results = cmdkFilter(query);
  cmdkLastResults = results;
  if (cmdkSelectedIdx >= results.length) cmdkSelectedIdx = Math.max(0, results.length - 1);
  if (!results.length) {
    box.innerHTML = `<div class="cmdk-empty">Ничего не найдено</div>`;
    return;
  }
  // Группируем визуально по group
  let lastGroup = '';
  let html = '';
  results.forEach((r, i) => {
    if (r.group !== lastGroup) {
      html += `<div class="cmdk-group">${escapeHtml(r.group)}</div>`;
      lastGroup = r.group;
    }
    html += `<div class="cmdk-item ${i === cmdkSelectedIdx ? 'active' : ''}" data-idx="${i}">
      <div class="cmdk-item-title">${escapeHtml(r.title)}</div>
      <div class="cmdk-item-sub">${escapeHtml(r.sub || '')}</div>
    </div>`;
  });
  box.innerHTML = html;
  box.querySelectorAll('.cmdk-item').forEach(el => {
    el.addEventListener('mouseenter', () => {
      cmdkSelectedIdx = Number(el.dataset.idx);
      box.querySelectorAll('.cmdk-item').forEach((x, i) => x.classList.toggle('active', i === cmdkSelectedIdx));
    });
    el.addEventListener('click', () => cmdkExecute(Number(el.dataset.idx)));
  });
  const active = box.querySelector('.cmdk-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function cmdkExecute(idx) {
  const r = cmdkLastResults[idx];
  if (!r) return;
  closeCmdK();
  try { r.run(); } catch (e) { console.error('cmdk run failed', e); }
}

function openCmdK() {
  cmdkSelectedIdx = 0;
  $('cmdkOverlay')?.classList.remove('hidden');
  const inp = $('cmdkInput');
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
  renderCmdkResults('');
}
function closeCmdK() { $('cmdkOverlay')?.classList.add('hidden'); }

function initCmdK() {
  const overlay = $('cmdkOverlay');
  const input = $('cmdkInput');
  if (!overlay || !input) return;

  // Клик по фону = закрытие
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCmdK(); });

  input.addEventListener('input', () => { cmdkSelectedIdx = 0; renderCmdkResults(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdkSelectedIdx = Math.min(cmdkLastResults.length - 1, cmdkSelectedIdx + 1);
      renderCmdkResults(input.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdkSelectedIdx = Math.max(0, cmdkSelectedIdx - 1);
      renderCmdkResults(input.value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      cmdkExecute(cmdkSelectedIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCmdK();
    }
  });

  // Глобальный хоткей Cmd/Ctrl+K — открыть. (AI-чат Cmd+K заменим — у него
  // конфликт. AI-чат теперь Cmd+J.)
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      // Если активный inputs где пользователь печатает — не перехватываем
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (document.activeElement?.id !== 'cmdkInput') return;
      }
      e.preventDefault();
      if (overlay.classList.contains('hidden')) openCmdK();
      else closeCmdK();
    }
  });
}

// Drill-down: товар → разбивка по магазинам
async function showDrillDownProduct(product) {
  const overlay = $('drillDownOverlay');
  const body = $('drillBody');
  const title = $('drillTitle');
  const sub = $('drillSub');
  if (!overlay) return;
  const pid = product.productId || product.id;
  title.textContent = product.productName || product.name || pid;
  sub.textContent = `Загрузка...`;
  body.innerHTML = '<div class="drill-loading">Загружаем разбивку по магазинам...</div>';
  overlay.classList.remove('hidden');
  try {
    const data = await fetchJson(`/api/dashboard/product?period=${encodeURIComponent(state.period)}&productId=${encodeURIComponent(pid)}`);
    sub.textContent = `${data.product.category || ''} · ${fmtMoneyShort(data.totalFact)} за период · ${fmtNum(data.totalQuantity)} шт`;
    if (!data.items.length) {
      body.innerHTML = '<div class="drill-empty">За период этот товар не продавался ни в одной точке</div>';
      return;
    }
    body.innerHTML = `<table class="drill-tbl">
      <thead><tr>
        <th>#</th>
        <th>Магазин</th>
        <th class="num">Выручка</th>
        <th class="num">Кол-во</th>
        <th class="num">Доля</th>
        <th class="num"></th>
      </tr></thead>
      <tbody>
        ${data.items.map((s, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><b>${escapeHtml(s.storeName)}</b></td>
            <td class="num">${fmtNum(s.fact)} ₽</td>
            <td class="num">${fmtNum(s.quantity)}</td>
            <td class="num">${s.share}%</td>
            <td class="num" style="width:100px">
              <div class="drill-bar"><div class="drill-bar-fill" style="width:${Math.min(100, s.share)}%"></div></div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
  } catch (e) {
    body.innerHTML = `<div class="drill-empty">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function closeDrillDown() { $('drillDownOverlay')?.classList.add('hidden'); }

// ─── URL state (deeplink) ─────────────────────────────────────────────────
// При смене period/store/tab пишем в URL. При загрузке/back-forward читаем.
let __urlUpdating = false;

function urlStateApply(silent = false) {
  const params = new URLSearchParams(window.location.search);
  const period = params.get('period');
  const storeId = params.get('store');
  const page = params.get('page');
  const tab = params.get('tab');

  if (period && period !== state.period && (window.__metaPeriods__ || []).includes(period)) {
    state.period = period;
    const sel = $('periodSelect'); if (sel) sel.value = period;
    if (!silent) loadSummary();
  }
  if (storeId && storeId !== state.selectedStoreId) {
    state.selectedStoreId = storeId;
    const found = state.summary?.stores?.find(s => s.storeId === storeId);
    if (found) {
      const title = $('storeDetailTitle'); if (title) title.textContent = found.storeName;
      if (!silent) loadStoreDetails();
    }
  }
  if (page && (page === 'dashboard' || page === 'analytics')) {
    if (typeof switchPage === 'function') switchPage(page);
  }
  if (tab && page !== 'dashboard') {
    if (typeof switchAnalyticsTab === 'function') switchAnalyticsTab(tab);
  }
}

function urlStateWrite() {
  if (__urlUpdating) return;
  const params = new URLSearchParams();
  if (state.period) params.set('period', state.period);
  if (state.selectedStoreId) params.set('store', state.selectedStoreId);
  if (analyticsState?.currentPage === 'analytics') {
    params.set('page', 'analytics');
    if (analyticsState.currentTab) params.set('tab', analyticsState.currentTab);
  }
  const newQs = params.toString();
  const newUrl = window.location.pathname + (newQs ? '?' + newQs : '') + window.location.hash;
  if (newUrl !== window.location.pathname + window.location.search + window.location.hash) {
    history.replaceState({ urlState: true }, '', newUrl);
  }
}

function initUrlState() {
  // Применяем URL при загрузке — отложенно, после loadSummary
  // (вызывается из loadSummary callback)
  window.addEventListener('popstate', () => {
    __urlUpdating = true;
    urlStateApply(false);
    __urlUpdating = false;
  });

  // Hook на смену периода
  const sel = $('periodSelect');
  if (sel) sel.addEventListener('change', () => setTimeout(urlStateWrite, 50));
}

function initDrillDown() {
  $('drillClose')?.addEventListener('click', closeDrillDown);
  $('drillDownOverlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'drillDownOverlay') closeDrillDown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('drillDownOverlay').classList.contains('hidden')) closeDrillDown();
  });
}

// ─── Mobile compact mode ──────────────────────────────────────────────────
// На узких экранах (≤640px) при первом заходе включаем компактный режим:
// показываем только summary-hero + 3 KPI + список магазинов. Кнопка
// «Развернуть»/«Свернуть» переключает.
const MOBILE_KEY = 'maria_mobile_compact_v1';
function initMobileCompact() {
  const btn = $('mobileToggleBtn');
  const bar = $('mobileToggleBar');
  if (!btn || !bar) return;

  const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
  const apply = (compact) => {
    document.body.classList.toggle('mobile-compact', compact);
    btn.textContent = compact ? 'Развернуть' : 'Свернуть';
    bar.querySelector('span').innerHTML = compact
      ? '<b>Краткий режим</b> · только главное'
      : '<b>Полный режим</b> · все блоки';
  };

  // Дефолт на мобильном: compact. На десктопе: full.
  const stored = localStorage.getItem(MOBILE_KEY);
  const initial = stored === null ? isMobile() : stored === '1';
  apply(initial);

  btn.addEventListener('click', () => {
    const next = !document.body.classList.contains('mobile-compact');
    apply(next);
    localStorage.setItem(MOBILE_KEY, next ? '1' : '0');
  });
}

// ─── PWA: service worker + install prompt ─────────────────────────────────
let deferredInstallPrompt = null;
function initPwa() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
  // beforeinstallprompt — Chrome/Edge/Android. iOS не поддерживает (там через Share → Add to Home Screen).
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = $('installPwaBtn');
    if (btn) btn.classList.remove('hidden');
  });
  $('installPwaBtn')?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      $('installPwaBtn').classList.add('hidden');
    }
    deferredInstallPrompt = null;
  });
  window.addEventListener('appinstalled', () => {
    $('installPwaBtn')?.classList.add('hidden');
  });
}

// ─── AI-чат «Спроси у Маши» ───────────────────────────────────────────────
const AI_CHAT_KEY = 'maria_ai_chat_history_v1';
const AI_CHAT_OPEN_KEY = 'maria_ai_chat_open_v1';
let aiChatBusy = false;

function loadAiChatHistory() {
  try { return JSON.parse(localStorage.getItem(AI_CHAT_KEY) || '[]'); } catch { return []; }
}
function saveAiChatHistory(h) {
  localStorage.setItem(AI_CHAT_KEY, JSON.stringify(h.slice(-30)));
}

function aiMarkdown(text) {
  // Minimal safe markdown: **bold**, *italic*, `code`, переносы строк, escape HTML
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n- (.+)/g, '<br>• $1')
    .replace(/\n\d+\. (.+)/g, '<br>$&')
    .replace(/\n/g, '<br>');
}

function renderAiChatMessages() {
  const box = $('aiChatMessages');
  const suggest = $('aiChatSuggest');
  if (!box) return;
  const history = loadAiChatHistory();
  if (!history.length) {
    box.innerHTML = `<div class="ai-msg ai-msg-bot ai-msg-greet">Привет! Я <b>Маша</b>. Спроси меня про продажи, магазины, товары — отвечу из текущих данных дашборда.</div>`;
    if (suggest) suggest.style.display = '';
    return;
  }
  // Скрываем suggestions после первого вопроса
  if (suggest) suggest.style.display = 'none';
  box.innerHTML = history.map((m, i) => {
    if (m.role === 'user') {
      return `<div class="ai-msg ai-msg-user">${aiMarkdown(m.text)}</div>`;
    }
    return `<div class="ai-msg ai-msg-bot" data-idx="${i}">
      ${aiMarkdown(m.text)}
      <button class="ai-msg-copy" data-copy="${encodeURIComponent(m.text)}" title="Копировать">⎘</button>
    </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
  // Bind copy buttons
  box.querySelectorAll('.ai-msg-copy').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = decodeURIComponent(btn.dataset.copy);
      try { await navigator.clipboard.writeText(text); btn.textContent = '✓'; setTimeout(() => btn.textContent = '⎘', 1500); }
      catch { btn.textContent = '✗'; setTimeout(() => btn.textContent = '⎘', 1500); }
    });
  });
}

// «Псевдо-стриминг»: ответ получаем целиком (Groq быстрый ~2 сек), а
// в UI печатаем буква-за-буквой со скоростью ~600 chars/sec. Даёт ощущение
// живого ответа без переделки бэкенда на честный SSE-stream.
function streamTextInto(el, fullText, done) {
  const total = fullText.length;
  if (total === 0) { el.innerHTML = ''; done && done(); return; }
  const stepMs = 12;
  const charsPerStep = Math.max(1, Math.ceil(total / 80));
  let i = 0;
  const tick = () => {
    i = Math.min(total, i + charsPerStep);
    el.innerHTML = aiMarkdown(fullText.slice(0, i)) + (i < total ? '<span class="ai-typing">▍</span>' : '');
    const box = $('aiChatMessages');
    if (box) box.scrollTop = box.scrollHeight;
    if (i < total) setTimeout(tick, stepMs);
    else done && done();
  };
  tick();
}

async function askAi(question) {
  if (!question || aiChatBusy) return;
  const history = loadAiChatHistory();
  history.push({ role: 'user', text: question, t: Date.now() });
  saveAiChatHistory(history);
  renderAiChatMessages();

  const box = $('aiChatMessages');
  // Спиннер
  box.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot ai-msg-loading" id="aiMsgLoading"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span></div>`);
  box.scrollTop = box.scrollHeight;

  aiChatBusy = true;
  let answerText;
  try {
    const res = await fetchJson('/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        period: state.period,
        history: history.slice(-6).map(m => ({ role: m.role, text: m.text }))
      })
    });
    answerText = res.answer || '(пустой ответ)';
  } catch (e) {
    answerText = `⚠ Ошибка: ${e.message}`;
  }

  // Убираем спиннер, добавляем bubble под streaming
  $('aiMsgLoading')?.remove();
  const streamDiv = document.createElement('div');
  streamDiv.className = 'ai-msg ai-msg-bot';
  box.appendChild(streamDiv);

  streamTextInto(streamDiv, answerText, () => {
    aiChatBusy = false;
    history.push({ role: 'bot', text: answerText, t: Date.now() });
    saveAiChatHistory(history);
    renderAiChatMessages();
  });
}

function clearAiChatHistory() {
  if (!confirm('Очистить историю чата?')) return;
  localStorage.removeItem(AI_CHAT_KEY);
  renderAiChatMessages();
}

function toggleAiChatFullscreen() {
  const widget = $('aiChatWidget');
  widget.classList.toggle('ai-chat-fullscreen');
  // Scroll вниз чтобы был виден последний ответ
  setTimeout(() => {
    const box = $('aiChatMessages');
    if (box) box.scrollTop = box.scrollHeight;
  }, 50);
}

async function loadAiChatSuggestions() {
  const suggestEl = $('aiChatSuggest');
  if (!suggestEl) return;
  try {
    const data = await fetchJson(`/api/ai-chat/suggestions?period=${encodeURIComponent(state.period)}`);
    const items = data.suggestions || [];
    if (items.length === 0) return; // оставляем статические
    suggestEl.innerHTML = items.map(s =>
      `<button class="ai-suggest" data-q="${encodeURIComponent(s.full)}">${escapeHtml(s.short)}</button>`
    ).join('');
    // Перебиндим click — кнопки динамические
    suggestEl.querySelectorAll('.ai-suggest').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = decodeURIComponent(btn.dataset.q || '');
        if (q) askAi(q);
      });
    });
  } catch (_) { /* keep static */ }
}

function openAiChat() {
  $('aiChatWidget')?.classList.remove('hidden');
  localStorage.setItem(AI_CHAT_OPEN_KEY, '1');
  renderAiChatMessages();
  // Загружаем актуальные suggestions если истории пока нет
  if (loadAiChatHistory().length === 0) loadAiChatSuggestions();
  setTimeout(() => $('aiChatInput')?.focus(), 100);
}
function closeAiChat() {
  $('aiChatWidget')?.classList.add('hidden');
  localStorage.removeItem(AI_CHAT_OPEN_KEY);
}

function initAiChat() {
  const toggle = $('aiChatToggle');
  const widget = $('aiChatWidget');
  if (!toggle || !widget) return;

  toggle.addEventListener('click', () => {
    if (widget.classList.contains('hidden')) openAiChat();
    else closeAiChat();
  });
  $('aiChatClose')?.addEventListener('click', closeAiChat);
  $('aiChatNew')?.addEventListener('click', clearAiChatHistory);
  $('aiChatExpand')?.addEventListener('click', toggleAiChatFullscreen);

  $('aiChatForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('aiChatInput');
    const q = input.value.trim();
    if (q) { input.value = ''; askAi(q); }
  });

  // Хоткеи: Esc — закрыть; Cmd/Ctrl+K — открыть/фокус
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !widget.classList.contains('hidden')) {
      // Если fullscreen — сначала свернуть, повторный Esc — закрыть
      if (widget.classList.contains('ai-chat-fullscreen')) {
        toggleAiChatFullscreen();
      } else {
        closeAiChat();
      }
    }
    // Cmd/Ctrl+J — открыть/сфокусировать AI-чат (K зарезервирован под cmdk-палитру)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      if (widget.classList.contains('hidden')) openAiChat();
      else $('aiChatInput')?.focus();
    }
  });

  document.querySelectorAll('#aiChatSuggest .ai-suggest').forEach(btn => {
    btn.addEventListener('click', () => askAi(btn.dataset.q));
  });

  // Восстанавливаем состояние «открыт» между перезагрузками
  if (localStorage.getItem(AI_CHAT_OPEN_KEY) === '1') {
    openAiChat();
  } else {
    renderAiChatMessages();
  }
}

function exportCsv(rows, filename) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = '﻿' + [
    headers.join(';'),
    ...rows.map(r => headers.map(h => String(r[h] ?? '').replace(/;/g, ',')).join(';'))
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = filename;
  a.click();
}

// Закладки/пиннер панелей удалены по запросу пользователя. Чистим LS чтобы
// не оставлять болтающихся ключей у тех у кого было закреплено.
try { localStorage.removeItem('maria_pinned_panels_v2'); } catch {}
try { localStorage.removeItem('maria_pinned_panels_v1'); } catch {}
function enhancePinningInSection() {}
function enhancePinningOnPage() {}

function exportFullTab() {
  const lines = [];
  const tab = document.querySelector('#page-analytics .atab-section:not(.hidden), #page-dashboard:not(.hidden)');
  const isAnalytics = !$('page-analytics').classList.contains('hidden');
  const root = isAnalytics
    ? document.querySelector('.atab-section:not(.hidden)')
    : $('page-dashboard');
  if (!root) return;
  const tabName = isAnalytics
    ? (document.querySelector('#analyticsTabs .atab-active')?.textContent || 'аналитика').trim()
    : 'Дашборд';

  lines.push(`Отчёт: ${tabName}`);
  lines.push(`Период: ${state.period}${analyticsState?.range?.from ? ` (${analyticsState.range.from} … ${analyticsState.range.to})` : ''}`);
  lines.push(`Скачано: ${new Date().toLocaleString('ru-RU')}`);
  lines.push('');

  // Все таблицы внутри root
  const tables = root.querySelectorAll('table');
  tables.forEach((tbl, idx) => {
    // Заголовок секции = ближайший .panel-title или .section-label
    let title = '';
    let node = tbl.parentElement;
    while (node && !title) {
      const t = node.querySelector(':scope > .panel-header .panel-title, :scope > .section-header .section-label, :scope > .section-label');
      if (t) title = t.textContent.trim();
      node = node.parentElement;
    }
    if (title) lines.push(`# ${title}`);
    const rows = [];
    const headerCells = tbl.querySelectorAll('thead th');
    if (headerCells.length) {
      rows.push(Array.from(headerCells).map(th => th.textContent.trim()).join('\t'));
    }
    tbl.querySelectorAll('tbody tr').forEach(tr => {
      const cells = tr.querySelectorAll('td');
      if (cells.length) rows.push(Array.from(cells).map(td => td.textContent.trim().replace(/\t/g, ' ')).join('\t'));
    });
    lines.push(rows.join('\n'));
    lines.push('');
  });

  // KPI-карточки (.kpi-card, .kpi)
  const kpis = root.querySelectorAll('.kpi-card, .kpi');
  if (kpis.length) {
    lines.push('# KPI');
    kpis.forEach(k => {
      const label = k.querySelector('.kpi-label')?.textContent.trim() || '';
      const val = k.querySelector('.kpi-value')?.textContent.trim() || '';
      const sub = k.querySelector('.kpi-sub')?.textContent.trim() || '';
      lines.push(`${label}\t${val}${sub ? '\t' + sub : ''}`);
    });
    lines.push('');
  }

  const tsv = '﻿' + lines.join('\n');
  const blob = new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8;' });
  const filename = `maria-${tabName.toLowerCase().replace(/[^а-яa-z0-9]+/gi, '-')}-${state.period}.tsv`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ── Data loading ───────────────────────────────────────────────────────────
async function loadMetadata() {
  const meta = await fetchJson('/api/metadata');
  window.__metaPeriods__ = meta.periods || [];
  $('periodSelect').innerHTML = meta.periods.map(p => `<option value="${p}">${p}</option>`).join('');
  state.period = meta.periods[0] || '';
  $('periodSelect').value = state.period;

  const tgStatus = $('telegramStatus');
  if (tgStatus && meta.hasTelegram) {
    tgStatus.innerHTML = '<span class="tg-dot"></span>Telegram алерты активны';
    tgStatus.classList.add('connected');
    tgStatus.classList.remove('hidden');
  }

  state.currentUser = meta.currentUser || null;
  renderUserBadge();
  return meta;
}

function renderUserBadge() {
  const badge = $('userBadge');
  if (!badge) return;
  const u = state.currentUser;
  if (!u) {
    if (state.userToken) {
      badge.innerHTML = `<span class="user-dot bad"></span>Токен не распознан <button class="link-btn" id="userLogoutBtn">сбросить</button>`;
      badge.classList.remove('hidden');
      $('userLogoutBtn')?.addEventListener('click', userLogout);
    } else {
      badge.classList.add('hidden');
    }
    return;
  }
  const roleLabel = u.role === 'admin' ? 'админ' : `менеджер · ${u.stores?.length || 0} ${u.stores?.length === 1 ? 'точка' : 'точек'}`;
  badge.innerHTML = `<span class="user-dot good"></span><b>${u.name}</b> <span class="user-role">${roleLabel}</span> <button class="link-btn" id="userLogoutBtn">выйти</button>`;
  badge.classList.remove('hidden');
  $('userLogoutBtn')?.addEventListener('click', userLogout);
  // Показываем иконку выхода в шапке когда пользователь успешно идентифицирован
  $('logoutBtn')?.classList.remove('hidden');
}

function userLogout() {
  // Делегируем в doLogout — он чистит и httpOnly cookie через /api/auth/logout
  doLogout();
}

async function loadSummary() {
  if (!state.period) return;
  const summary = await fetchJson(`/api/dashboard/summary?period=${encodeURIComponent(state.period)}&trend_window=24`);
  state.summary = summary;
  // Раньше автоматически выбирался первый магазин из списка — это разворачивало
  // огромный блок «По товарам» (8000+ пикселей) на главной для случайного
  // магазина. Теперь не выбираем — пользователь сам кликает на строку.

  applyMarginVisibility(summary);
  renderPlanHealth(summary);
  renderSummaryHero(summary);
  renderStickyMetrics(summary);
  renderKpis(summary);
  renderForecast(summary);
  renderTrendChart(summary);
  renderWeekdayHeatmap(summary);
  renderComparison(summary);
  renderSpotlight(summary);
  renderStores(summary);
  renderProducts(summary);
  await loadStoreDetails();
  await loadComments();

  $('lastUpdate').textContent = `обновлено: ${new Date().toLocaleTimeString('ru-RU')}`;
  enhancePinningOnPage();
}

// AI Топ-5 загружается один раз при открытии страницы и при смене периода.
// Не привязан к 30-секундному poll и SSE — иначе секция мигает и не даёт
// дочитать. Кнопка-обновления в заголовке секции — для ручного refresh.
async function loadInsights({ silent = false } = {}) {
  const el = $('insightsPanel');
  if (!el) return;
  if (!silent) el.innerHTML = '<div class="empty-state" style="padding:16px">Анализирую…</div>';
  try {
    const data = await fetchJson(`/api/insights?period=${encodeURIComponent(state.period)}`);
    renderInsights(data);
  } catch (err) {
    if (!silent) el.innerHTML = `<div class="empty-state" style="padding:16px;color:var(--bad)">Не удалось загрузить: ${err.message}</div>`;
  }
}

function renderInsights(data) {
  const el = $('insightsPanel');
  const engineEl = $('insightsEngine');
  if (engineEl) engineEl.textContent = data.engine === 'llm+rules' ? 'LLM + правила' : 'правила';

  const sevColor = (s) => s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'neutral';
  const sevIcon = (s) => s === 'high' ? '⚠' : s === 'medium' ? '!' : '·';

  const findingsHtml = (data.findings || []).map((f) => `
    <div class="ins-card ${sevColor(f.severity)}">
      <div class="ins-head">
        <span class="ins-sev">${sevIcon(f.severity)}</span>
        <span class="ins-headline">${escapeHtml(f.headline)}</span>
      </div>
      <div class="ins-detail">${escapeHtml(f.detail)}</div>
    </div>`).join('');

  const eventsHtml = (data.upcomingEvents || []).slice(0, 4).map((e) => {
    const tone = e.impact === 'major' ? 'bad' : e.impact === 'medium' ? 'warn' : 'neutral';
    return `<div class="ins-event ${tone}">
      <div class="ins-event-date">${e.date} · через ${e.daysFromNow} дн.</div>
      <div class="ins-event-name">${escapeHtml(e.name)}</div>
      ${e.note ? `<div class="ins-event-note">${escapeHtml(e.note)}</div>` : ''}
    </div>`;
  }).join('');

  // Резюме AI вынесено в отдельный верхний блок (aiNarrativeSection) над KPI.
  // Здесь не дублируем — иначе один и тот же текст висит в двух местах.
  renderAiNarrative(data.llmSummary);
  const llmHtml = '';

  el.innerHTML = `
    ${llmHtml}
    <div class="ins-grid">
      <div class="ins-col">
        <div class="ins-col-label">Что посмотреть</div>
        ${findingsHtml || '<div class="empty-state" style="padding:12px">Аномалий не найдено — сеть в норме.</div>'}
      </div>
      <div class="ins-col">
        <div class="ins-col-label">Календарь — ближайшие 60 дн.</div>
        ${eventsHtml || '<div class="empty-state" style="padding:12px">Праздников впереди нет.</div>'}
      </div>
    </div>`;
}

// ── SSE ────────────────────────────────────────────────────────────────────
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => {
    $('streamStatus').textContent = '● поток подключён';
    $('streamStatus').className = 'status-pill live';
  });
  const reload = async () => {
    $('streamStatus').textContent = '● обновление';
    $('streamStatus').className = 'status-pill syncing';
    await loadSummary();
    $('streamStatus').textContent = '● поток подключён';
    $('streamStatus').className = 'status-pill live';
  };
  ['sales_updated', 'plans_updated'].forEach(e => es.addEventListener(e, reload));
  es.addEventListener('comment_added', () => loadComments());
  es.onerror = () => {
    $('streamStatus').textContent = '● нет связи';
    $('streamStatus').className = 'status-pill idle';
  };
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  initDarkTheme();

  document.querySelectorAll('#storesTableEl th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      state.storeSort = state.storeSort.key === k
        ? { key: k, dir: state.storeSort.dir * -1 }
        : { key: k, dir: -1 };
      if (state.summary) renderStores(state.summary);
    });
  });

  $('productSort').addEventListener('change', e => {
    state.productSort = e.target.value;
    state.productsExpanded = false;
    if (state.summary) renderProducts(state.summary);
  });

  $('printBtn').addEventListener('click', () => window.print());
  $('exportTabBtn')?.addEventListener('click', exportFullTab);
  $('logoutBtn')?.addEventListener('click', doLogout);
  initAiChat();
  initPwa();
  initMobileCompact();
  initCmdK();
  initStickyMetrics();
  initDrillDown();
  initUrlState();
  $('storeNoteForm')?.addEventListener('submit', submitStoreNote);
  // Дефолтная дата заметки — сегодня
  const today = new Date().toISOString().slice(0,10);
  const dn = $('storeNoteDate'); if (dn) dn.value = today;

  $('planSaveBtn').addEventListener('click', savePlanEdit);
  $('planCancelBtn').addEventListener('click', closePlanEdit);
  $('modalClose').addEventListener('click', closePlanEdit);
  $('planEditModal').addEventListener('click', e => { if (e.target === $('planEditModal')) closePlanEdit(); });

  initComments();
  initUppGuide();

  const exportSales = () => {
    if (!state.summary) return;
    exportCsv(state.summary.stores.map(s => ({
      'Точка': s.storeName, 'Регион': s.region || '',
      'Факт': s.fact, 'План': s.plan, 'Выполнение%': s.percent,
      'Маржа': s.margin, 'Маржа%': s.marginPct,
      'Ср.чек': s.quantity > 0 ? Math.round(s.fact / s.quantity) : 0,
      'Количество': s.quantity
    })), `sales-${state.period}.csv`);
  };
  $('exportSalesBtn')?.addEventListener('click', exportSales);
  $('exportSalesBtnH')?.addEventListener('click', exportSales);

  $('insightsRefresh')?.addEventListener('click', () => loadInsights());
  $('marketTrendsRefresh')?.addEventListener('click', () => loadMarketTrends({ force: true }));
  $('mkZombieRefresh')?.addEventListener('click', loadMkZombie);
  $('mkCannibaRefresh')?.addEventListener('click', loadMkCannibalization);
  $('mkRfmRefresh')?.addEventListener('click', loadMkRfm);
  $('mkClustersRefresh')?.addEventListener('click', loadMkClusters);
  $('mkCohortsRefresh')?.addEventListener('click', loadMkCohorts);

  // CSV-экспорт каждого блока (для отдела маркетинга / CRM-обзвонов)
  $('mkZombieCsv')?.addEventListener('click', () => {
    const d = analyticsState.mkZombieData?.items || [];
    if (!d.length) return alert('Зомби-товаров нет — нечего экспортировать');
    exportCsv(d.map(x => ({ 'Товар': x.productName, 'Категория': x.category, 'План': x.plan, 'Факт': x.fact, 'Выполнение_%': x.percent, 'Недобор': x.gap })), `zombie-${state.period}.csv`);
  });
  $('mkCannibaCsv')?.addEventListener('click', () => {
    const d = analyticsState.mkCannibaData?.byCondition || [];
    if (!d.length) return alert('Нет данных');
    exportCsv(d.map(x => ({ 'Условие_скидки': x.condition, 'Сумма': x.amount })), `discount-cannibalization-${state.period}.csv`);
  });
  $('mkRfmCsvVip')?.addEventListener('click', () => {
    const d = analyticsState.mkRfmData?.topVIP || [];
    if (!d.length) return alert('Нет VIP-клиентов');
    exportCsv(d.map(x => ({ 'Имя': x.name, 'Выручка': x.monetary, 'Покупок': x.frequency, 'R': x.R, 'F': x.F, 'M': x.M })), `rfm-vip-${state.period}.csv`);
  });
  $('mkRfmCsvSleep')?.addEventListener('click', () => {
    const d = analyticsState.mkRfmData?.topSleeping || [];
    if (!d.length) return alert('Нет спящих клиентов');
    exportCsv(d.map(x => ({ 'Имя': x.name, 'Выручка': x.monetary, 'Recency_мес': x.recencyMonths, 'Сегмент': x.segment })), `rfm-sleeping-${state.period}.csv`);
  });
  $('mkClustersCsv')?.addEventListener('click', () => {
    const d = analyticsState.mkClustersData?.clusters || [];
    if (!d.length) return alert('Нет данных');
    const rows = [];
    for (const c of d) for (const s of c.stores) rows.push({ 'Кластер': c.name, 'Магазин': s.storeName, 'Выполнение_%': s.pctCompletion, 'Маржа_%': s.marginPct, 'Ср_чек': s.avgCheck, 'Факт': s.fact });
    exportCsv(rows, `store-clusters-${state.period}.csv`);
  });
  $('mkCohortsCsv')?.addEventListener('click', () => {
    const d = analyticsState.mkCohortsData?.cohorts || [];
    if (!d.length) return alert('Нет данных');
    const rows = [];
    for (const c of d) for (const r of c.retention) rows.push({ 'Когорта': c.firstMonth, 'Total': c.total, 'Offset_M': r.offset, 'Активных': r.count, 'Retention_%': r.pct });
    exportCsv(rows, `cohort-retention.csv`);
  });

  // Навигация сайдбара и список pending-отчётов работают независимо
  // от загрузки данных — биндим сразу, чтобы клики уже срабатывали.
  initPageNav();
  renderPendingReports();

  try {
    const meta = await loadMetadata();
    initPin(meta.pinRequired);
    // Если в URL есть period — применить ДО первой загрузки summary
    const urlParams = new URLSearchParams(window.location.search);
    const urlPeriod = urlParams.get('period');
    if (urlPeriod && (window.__metaPeriods__ || []).includes(urlPeriod)) {
      state.period = urlPeriod;
      const sel = $('periodSelect'); if (sel) sel.value = urlPeriod;
    }
    await loadSummary();
    // После summary применяем остальной URL-state (store/tab/page)
    urlStateApply(false);
    loadInsights();
    loadMarketTrends();
    connectEvents();
    $('periodSelect').addEventListener('change', async e => {
      state.period = e.target.value;
      state.selectedStoreId = '';
      $('storeDetailTitle').textContent = 'Детализация точки';
      urlStateWrite();
      await loadSummary();
      loadInsights();
      analyticsState.data = null;
      if (analyticsState.currentPage === 'analytics') await loadAnalytics();
    });

    $('trendWindowBtns')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-tw]');
      if (!btn) return;
      state.trendWindow = Number(btn.dataset.tw);
      $('trendWindowBtns').querySelectorAll('[data-tw]').forEach(b => b.classList.toggle('btn-xs-active', b === btn));
      if (state.summary) renderTrendChart(state.summary);
    });

    setInterval(loadSummary, 30000);
  } catch (err) {
    document.body.innerHTML = `<main style="padding:48px;text-align:center;color:#dc2626">Ошибка загрузки: ${err.message}</main>`;
  }
}

// ════════════════════════════════════════════════════════════════════════
// АНАЛИТИКА ПРОДАЖ — переключатель страниц + отчёты
// ════════════════════════════════════════════════════════════════════════

const analyticsState = {
  currentPage: 'dashboard',
  currentTab: localStorage.getItem('maria_atab') || 'network',
  data: null,
  abcFilter: 'all',
  abcLimit: 50,
  range: { from: null, to: null }
};

function initPageNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const page = btn.dataset.page;
      switchPage(page);
      if (page === 'analytics' && !analyticsState.data) {
        await loadAnalytics();
      }
    });
  });
  document.querySelectorAll('#abcFilterBtns [data-abc]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#abcFilterBtns [data-abc]').forEach(b => b.classList.toggle('btn-xs-active', b === btn));
      analyticsState.abcFilter = btn.dataset.abc;
      analyticsState.abcLimit = 50;
      renderAbc();
    });
  });
  initCsvButtons();
  initAnalyticsTabs();
  initDateRange();
  // Применяем сохранённый таб при загрузке
  switchAnalyticsTab(analyticsState.currentTab);
}

function initAnalyticsTabs() {
  document.querySelectorAll('#analyticsTabs .atab').forEach(btn => {
    btn.addEventListener('click', () => switchAnalyticsTab(btn.dataset.tab));
  });
  $('customersRefresh')?.addEventListener('click', () => {
    analyticsState.customersData = null;
    loadCustomers();
  });
  $('promoRefresh')?.addEventListener('click', () => {
    analyticsState.promoData = null;
    loadPromo();
  });
}

function switchAnalyticsTab(tab) {
  analyticsState.currentTab = tab;
  localStorage.setItem('maria_atab', tab);
  setTimeout(() => urlStateWrite && urlStateWrite(), 0);
  document.querySelectorAll('#analyticsTabs .atab').forEach(b => b.classList.toggle('atab-active', b.dataset.tab === tab));
  document.querySelectorAll('.atab-section').forEach(s => s.classList.toggle('hidden', s.dataset.atab !== tab));
  // Закладки: добавляем pin-кнопки + применяем порядок в активной секции
  document.querySelectorAll('.atab-section:not(.hidden)').forEach(s => enhancePinningInSection(s));
  // Лениво грузим клиентскую и промо аналитику при первом открытии таба
  if (tab === 'customers' && !analyticsState.customersData) loadCustomers();
  if (tab === 'promo' && !analyticsState.promoData) loadPromo();
  if (tab === 'marketing' && !analyticsState.marketingLoaded) loadMarketing();
  const pageEl = $('page-analytics');
  if (pageEl) pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadCustomers() {
  const availEl = $('customersAvailability');
  const contentEl = $('customersContent');
  try {
    const params = new URLSearchParams();
    if (analyticsState.range.from) params.set('from', analyticsState.range.from.slice(0,7));
    if (analyticsState.range.to) params.set('to', analyticsState.range.to.slice(0,7));
    if (!params.has('from')) params.set('from', state.period);
    if (!params.has('to')) params.set('to', state.period);
    const data = await fetchJson(`/api/analytics/customers?${params.toString()}`);
    if (!data.available) {
      availEl.classList.remove('hidden');
      availEl.innerHTML = `<b>Канал к 1С не настроен.</b> ${escapeHtml(data.note || '')}`;
      contentEl.style.display = 'none';
      return;
    }
    if (data.error || data.bonuses?.error) {
      availEl.classList.remove('hidden');
      availEl.innerHTML = `<b>Ошибка обращения к 1С:</b> ${escapeHtml(data.error || data.bonuses?.error || '')} <button class="link-btn" id="customersRetry">Повторить</button>`;
      $('customersRetry')?.addEventListener('click', () => { analyticsState.customersData = null; loadCustomers(); });
      contentEl.style.display = 'none';
      return;  // НЕ сохраняем в state
    }
    analyticsState.customersData = data;
    availEl.classList.add('hidden');
    contentEl.style.display = '';
    renderCustomersKpis(data);
    renderCustomersTop(data);
    renderCustomersFuture(data);
    loadRetention();
    loadTopCustomers();
  } catch (e) {
    if (availEl) {
      availEl.classList.remove('hidden');
      availEl.innerHTML = `<b>Ошибка:</b> ${escapeHtml(e.message)}`;
    }
    if (contentEl) contentEl.style.display = 'none';
  }
}

function renderCustomersKpis(d) {
  const b = d.bonuses || {};
  $('customersKpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Активных карт</div><div class="kpi-value">${fmtNum(b.totalCards || 0)}</div></div>
    <div class="kpi-card"><div class="kpi-label">Транзакций</div><div class="kpi-value">${fmtNum(b.totalMovements || 0)}</div></div>
    <div class="kpi-card"><div class="kpi-label">Бонусов начислено</div><div class="kpi-value">${fmtNum(b.totalSum || 0)} ₽</div></div>
    <div class="kpi-card"><div class="kpi-label">Период</div><div class="kpi-value" style="font-size:14px">${b.period?.from || '?'} — ${b.period?.to || '?'}</div></div>
  `;
}

function renderCustomersTop(d) {
  const tbody = document.querySelector('#customersTopTbl tbody');
  if (!tbody) return;
  const rows = d.bonuses?.topCards || [];
  tbody.innerHTML = rows.map((r, i) => `
    <tr>
      <td class="col-num">${i+1}</td>
      <td><b>${escapeHtml(r.card)}</b></td>
      <td class="num">${fmtNum(r.sum)} ₽</td>
      <td class="num">${fmtNum(r.movements)}</td>
    </tr>
  `).join('');
}

// ── Маркетинговая аналитика (под-таб «Маркетинг») ──────────────────────────
async function loadMarketing() {
  analyticsState.marketingLoaded = true;
  // Hero рендерится после того как нужные данные загрузились
  loadMkZombie();
  loadMkCannibalization();
  loadMkRfm();
  loadMkHolidayYoy();
  loadMkClusters();
  loadMkCohorts();
  renderMkPending();
}

function renderMkHero() {
  const el = $('mkHeroSummary');
  if (!el) return;
  const cards = [];
  const rfm = analyticsState.mkRfmData;
  const canniba = analyticsState.mkCannibaData;
  const clusters = analyticsState.mkClustersData;
  const zombie = analyticsState.mkZombieData;

  if (rfm?.total) {
    const vip = (rfm.segments || []).find(s => s.segment === 'VIP');
    const sleeping = (rfm.segments || []).find(s => s.segment === 'Спящие');
    cards.push({ label: 'Активных клиентов (6 мес)', value: rfm.total.toLocaleString('ru-RU'), tone: 'neutral' });
    if (vip) cards.push({ label: 'VIP-клиентов', value: vip.count.toLocaleString('ru-RU'), sub: formatMoney(vip.monetary), tone: 'good' });
    if (sleeping) cards.push({ label: 'Спящих (реактивировать)', value: sleeping.count.toLocaleString('ru-RU'), sub: 'потенциал ' + formatMoney(sleeping.monetary), tone: 'bad' });
  }
  if (canniba?.totals) {
    const totalFact = state.summary?.totals?.fact || 0;
    const pct = totalFact > 0 ? ((canniba.totals.totalDiscount / totalFact) * 100).toFixed(1) : '—';
    cards.push({ label: 'Скидок выдано', value: formatMoney(canniba.totals.totalDiscount), sub: `${pct}% от выручки`, tone: pct > 5 ? 'warn' : 'neutral' });
  }
  if (clusters?.total) {
    cards.push({ label: 'Магазинов в кластерах', value: clusters.total.toLocaleString('ru-RU'), sub: `${clusters.clusters?.length || 0} групп`, tone: 'neutral' });
  }
  if (zombie?.total !== undefined) {
    cards.push({ label: 'Зомби-товаров', value: zombie.total.toLocaleString('ru-RU'), sub: zombie.total > 0 ? 'недобор ' + formatMoney(zombie.totalGap) : 'все ОК', tone: zombie.total > 0 ? 'bad' : 'good' });
  }

  if (!cards.length) { el.innerHTML = ''; return; }
  el.innerHTML = cards.map(c => `
    <div class="mk-hero-card mk-hero-${c.tone}">
      <div class="mk-hero-label">${escapeHtml(c.label)}</div>
      <div class="mk-hero-value">${c.value}</div>
      ${c.sub ? `<div class="mk-hero-sub">${escapeHtml(c.sub)}</div>` : ''}
    </div>`).join('');
}

async function loadMkClusters() {
  const el = $('mkClusters');
  if (!el) return;
  el.innerHTML = '<div class="empty-state" style="padding:14px">Кластеризую…</div>';
  try {
    const data = await fetchJson(`/api/marketing/store-clusters?period=${encodeURIComponent(state.period)}`);
    analyticsState.mkClustersData = data;
    renderMkHero();
    if (!data.clusters?.length) {
      el.innerHTML = `<div class="empty-state" style="padding:14px">${escapeHtml(data.note || 'Недостаточно данных')}</div>`;
      return;
    }
    const cards = data.clusters.map(c => {
      const toneCls = c.tone === 'good' ? 'mk-seg-good' : c.tone === 'bad' ? 'mk-seg-bad' : c.tone === 'warn' ? 'mk-seg-warn' : '';
      const topStores = c.stores.slice(0, 5).map(s => `<div style="font-size:12px"><b>${escapeHtml(s.storeName)}</b> · ${s.pctCompletion}% · чек ${s.avgCheck}₽</div>`).join('');
      return `
        <div class="mk-seg ${toneCls}">
          <div class="mk-seg-name">${escapeHtml(c.name)}</div>
          <div class="mk-seg-count">${c.count} магазинов</div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">средние:</div>
          <div style="font-size:12px">% выполн.: <b>${c.avg.pctCompletion}%</b></div>
          <div style="font-size:12px">маржа: <b>${c.avg.marginPct}%</b></div>
          <div style="font-size:12px">ср.чек: <b>${c.avg.avgCheck}₽</b></div>
          <div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--line)">${topStores}</div>
        </div>`;
    }).join('');
    el.innerHTML = `
      <div class="mk-stat-line">Всего магазинов в кластерах: <b>${data.total}</b> · ${data.clusters.length} групп</div>
      <div class="mk-segs">${cards}</div>
      <div class="mk-action-hint">💡 <b>Что делать:</b> «Лидеры» — изучить их практики и масштабировать; «Отстающие» — внутренний обмен опытом с лидерами того же формата; высокий чек ≠ высокая маржа — следить за обоими показателями.</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:14px;color:var(--bad)">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadMkCohorts() {
  const el = $('mkCohorts');
  if (!el) return;
  el.innerHTML = '<div class="empty-state" style="padding:14px">Тяну Бонусы за 6 мес…</div>';
  try {
    const data = await fetchJson('/api/marketing/cohort-retention?months=6');
    analyticsState.mkCohortsData = data;
    if (!data.cohorts?.length) {
      el.innerHTML = '<div class="empty-state" style="padding:14px">Нет данных по картам за 6 мес</div>';
      return;
    }
    // Строим таблицу когорта × offset
    const maxOffset = Math.max(0, ...data.cohorts.flatMap(c => c.retention.map(r => r.offset)));
    const headerOffsets = Array.from({ length: maxOffset + 1 }, (_, i) => i);
    const rows = data.cohorts.map(c => {
      const cells = headerOffsets.map(off => {
        const r = c.retention.find(x => x.offset === off);
        if (!r) return '<td class="num cohort-empty">—</td>';
        // Цветная heatmap: M0 всегда 100% — нейтрально; дальше — intensity по retention pct
        if (off === 0) {
          return `<td class="num" style="background:rgba(110,130,200,.18)"><b>${r.pct}%</b><br><small class="muted">${r.count}</small></td>`;
        }
        // Для M+1+: 0-3% слабо, 3-7% средне, >7% сильно
        const intensity = Math.min(r.pct / 12, 1);
        const bg = `rgba(34, 197, 94, ${(0.1 + intensity * 0.6).toFixed(2)})`;
        return `<td class="num" style="background:${bg}"><b>${r.pct}%</b><br><small class="muted">${r.count}</small></td>`;
      }).join('');
      return `<tr><td><b>${c.firstMonth}</b><br><small class="muted">${c.total} карт</small></td>${cells}</tr>`;
    }).join('');
    el.innerHTML = `
      <div class="mk-stat-line">Когорты по первому месяцу активности. % = доля карт когорты активных в этом offset-месяце.</div>
      <div class="table-wrap"><table class="num-table mk-cohort-table">
        <thead><tr><th>Когорта</th>${headerOffsets.map(o => `<th class="num">${o === 0 ? 'M0' : 'M+' + o}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="mk-action-hint">💡 <b>Что делать:</b> сравнить retention новых когорт со старыми — если падает, проверить onboarding (как новый клиент узнаёт о бонусах). M+1 ниже 5% — сигнал что после первой покупки клиент не вернулся.</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:14px;color:var(--bad)">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadMkZombie() {
  const el = $('mkZombie');
  if (!el) return;
  el.innerHTML = '<div class="empty-state" style="padding:14px">Считаю…</div>';
  try {
    const data = await fetchJson(`/api/marketing/zombie-products?period=${encodeURIComponent(state.period)}`);
    analyticsState.mkZombieData = data;
    renderMkHero();
    if (!data.items?.length) {
      el.innerHTML = `
        <div class="mk-empty-good">
          <div class="mk-empty-emoji">✅</div>
          <div>Зомби-товаров нет — все товары с планом &gt;1 000 ₽ продаются хотя бы на 10%.</div>
        </div>`;
      return;
    }
    const rows = data.items.slice(0, 25).map(it => `
      <tr>
        <td>${escapeHtml(it.productName)}<br><small class="muted">${escapeHtml(it.category)}</small></td>
        <td class="num">${formatMoney(it.plan)}</td>
        <td class="num">${formatMoney(it.fact)}</td>
        <td class="num"><b style="color:var(--bad)">${it.percent}%</b></td>
        <td class="num">${formatMoney(it.gap)}</td>
      </tr>`).join('');
    el.innerHTML = `
      <div class="mk-stat-line">Всего <b>${data.total}</b> зомби-товаров · суммарный недобор <b>${formatMoney(data.totalGap)}</b></div>
      <div class="table-wrap"><table class="num-table">
        <thead><tr><th>Товар</th><th class="num">План</th><th class="num">Факт</th><th class="num">%</th><th class="num">Недобор</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="mk-action-hint">💡 <b>Что делать:</b> либо запустить промо/выкладку на эти SKU, либо снять с ассортимента и перераспределить план на ходовые позиции.</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:14px;color:var(--bad)">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadMkCannibalization() {
  const el = $('mkCanniba');
  if (!el) return;
  el.innerHTML = '<div class="empty-state" style="padding:14px">Тяну из ПредоставленныеСкидки в 1С…</div>';
  try {
    const params = new URLSearchParams();
    params.set('from', analyticsState.range?.from?.slice(0,7) || state.period);
    params.set('to', analyticsState.range?.to?.slice(0,7) || state.period);
    const data = await fetchJson(`/api/marketing/discount-cannibalization?${params}`);
    analyticsState.mkCannibaData = data;
    renderMkHero();
    const totalFact = state.summary?.totals?.fact || 0;
    const ratioPct = totalFact > 0 ? ((data.totals.totalDiscount / totalFact) * 100).toFixed(1) : null;
    const ratioBadge = ratioPct !== null
      ? `<span class="mk-badge mk-badge-${ratioPct > 5 ? 'warn' : 'good'}">${ratioPct}% от выручки</span>`
      : '<span class="muted">% от выручки считаем после загрузки summary</span>';
    // Bar-визуализация: TR-background заливается пропорционально доле
    const maxPct = Math.max(...data.byCondition.map(c => data.totals.totalDiscount > 0 ? (c.amount / data.totals.totalDiscount) * 100 : 0), 1);
    const condRows = data.byCondition.map(c => {
      const pct = data.totals.totalDiscount > 0 ? (c.amount / data.totals.totalDiscount) * 100 : 0;
      const fill = (pct / maxPct) * 100; // в % от ширины ячейки
      return `<tr style="background: linear-gradient(to right, rgba(193,68,86,${(fill/250).toFixed(3)}) ${fill.toFixed(1)}%, transparent ${fill.toFixed(1)}%)">
        <td>${escapeHtml(c.condition)}</td>
        <td class="num">${formatMoney(c.amount)}</td>
        <td class="num"><b>${pct.toFixed(1)}%</b></td>
      </tr>`;
    }).join('');
    el.innerHTML = `
      <div class="mk-stat-line">
        Сумма скидок за период: <b>${formatMoney(data.totals.totalDiscount)}</b> · ${ratioBadge}
        <small class="muted" style="margin-left:8px">(${data.totals.totalRows} записей, ${data.totals.months} мес.)</small>
        ${data.truncationWarning ? `<div class="mk-warn-line">⚠ ${escapeHtml(data.truncationWarning)}</div>` : ''}
      </div>
      <div class="table-wrap"><table class="num-table">
        <thead><tr><th>Условие скидки</th><th class="num">Сумма</th><th class="num">Доля</th></tr></thead>
        <tbody>${condRows}</tbody>
      </table></div>
      ${data.topReceivers?.length ? `<div class="mk-substat">Топ-5 получателей: ${data.topReceivers.slice(0,5).map(r => `<span style="margin-right:14px">${escapeHtml(r.name)} — <b>${formatMoney(r.amount)}</b></span>`).join('')}</div>` : ''}
      <div class="mk-action-hint">💡 <b>Что делать:</b> если &gt;5% выручки — пересмотреть условия акций. Топ-3 правила обычно дают 70% эффекта — на них и сосредоточиться.</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:14px;color:var(--bad)">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadMkRfm() {
  const el = $('mkRfm');
  if (!el) return;
  el.innerHTML = '<div class="empty-state" style="padding:14px">Считаю RFM по дисконтным картам…</div>';
  try {
    // Берём 6 мес назад
    const [yy, mm] = state.period.split('-').map(Number);
    const from = new Date(Date.UTC(yy, mm - 6, 1));
    const fromYM = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
    const data = await fetchJson(`/api/marketing/rfm?from=${fromYM}&to=${state.period}`);
    analyticsState.mkRfmData = data;
    renderMkHero();
    if (!data.total) {
      el.innerHTML = `<div class="empty-state" style="padding:14px">${escapeHtml(data.note || 'Нет данных')}</div>`;
      return;
    }
    const segColors = { 'VIP': 'good', 'Постоянные': 'good', 'Новые': 'neutral', 'Уходящие VIP': 'warn', 'Спящие': 'bad', 'Прочие': 'neutral' };
    const segs = data.segments.map(s => `
      <div class="mk-seg mk-seg-${segColors[s.segment] || 'neutral'}">
        <div class="mk-seg-name">${escapeHtml(s.segment)}</div>
        <div class="mk-seg-count">${s.count} клиентов</div>
        <div class="mk-seg-money">${formatMoney(s.monetary)}</div>
        <div class="mk-seg-avg">средний ${formatMoney(s.avgMonetary)}</div>
      </div>`).join('');
    const vipRows = (data.topVIP || []).map(v => `<tr><td>${escapeHtml(v.name)}</td><td class="num">${formatMoney(v.monetary)}</td><td class="num">${v.frequency}</td></tr>`).join('');
    const sleepingRows = (data.topSleeping || []).map(v => `<tr><td>${escapeHtml(v.name)}</td><td class="num">${formatMoney(v.monetary)}</td><td class="num">${v.recencyMonths} мес.</td></tr>`).join('');
    el.innerHTML = `
      <div style="padding:8px 16px;font-size:13px">
        Всего активных клиентов за 6 мес: <b>${data.total}</b>
      </div>
      <div class="mk-segs">${segs}</div>
      <div class="mk-rfm-cols">
        <div class="mk-rfm-col">
          <div class="mk-rfm-col-title good">👑 Топ-20 VIP <small class="muted">— предложить премиум, индивидуальный сервис</small></div>
          ${vipRows ? `<table class="num-table"><thead><tr><th>Имя</th><th class="num">Сумма</th><th class="num">Покупок</th></tr></thead><tbody>${vipRows}</tbody></table>` : '<div class="muted" style="font-size:12px">пока нет</div>'}
        </div>
        <div class="mk-rfm-col">
          <div class="mk-rfm-col-title bad">💤 Топ-20 спящих <small class="muted">— реактивировать SMS/push с купоном</small></div>
          ${sleepingRows ? `<table class="num-table"><thead><tr><th>Имя</th><th class="num">Сумма</th><th class="num">Recency</th></tr></thead><tbody>${sleepingRows}</tbody></table>` : '<div class="muted" style="font-size:12px">пока нет</div>'}
        </div>
      </div>
      <div class="mk-action-hint">💡 <b>Что делать:</b> VIP — персональные предложения и поздравления; Спящим — точечный push «вернёмся за подарком» с купоном на 1 неделю; Новых — onboarding (карта/бонусы).</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:14px;color:var(--bad)">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadMkHolidayYoy() {
  const el = $('mkHolidays');
  if (!el) return;
  el.innerHTML = '<div class="empty-state" style="padding:14px">Считаю YoY по календарю…</div>';
  try {
    const data = await fetchJson('/api/marketing/holiday-yoy?window=60');
    if (!data.events?.length) { el.innerHTML = '<div class="empty-state" style="padding:14px">Нет ближайших праздников</div>'; return; }
    const baseline = data.baseline.avgRevenuePerDay;
    const rows = data.events.map(e => {
      const lift = e.liftPct;
      const liftHtml = lift === null ? '<span class="muted">нет данных за прошлый год</span>'
        : `<span style="color:${lift > 50 ? 'var(--good)' : lift > 0 ? 'var(--warn)' : 'var(--muted)'};font-weight:600">${lift > 0 ? '+' : ''}${lift}%</span>`;
      return `<tr>
        <td><b>${escapeHtml(e.name)}</b><br><small class="muted">${e.date} · через ${e.daysFromNow} дн.</small></td>
        <td class="num">${e.lastYearAvgRevenue !== null ? formatMoney(e.lastYearAvgRevenue) : '—'}</td>
        <td class="num">${liftHtml}</td>
        <td>${escapeHtml(e.note || '')}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `
      <div class="mk-stat-line">Baseline средняя выручка/день за период: <b>${formatMoney(baseline)}</b> <small class="muted">(${data.baseline.daysObserved} дней в БД)</small></div>
      <div class="table-wrap"><table class="num-table">
        <thead><tr><th>Праздник</th><th class="num">Год назад (среднее по 7 дн.)</th><th class="num">Lift к baseline</th><th>Заметки</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="mk-action-hint">💡 <b>Что делать:</b> для праздников с Lift &gt;30% — закладывать +N% производства за 2-3 дня до даты; «—» значит в БД нет данных год назад (нужны 24 мес истории через pull-history).</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:14px;color:var(--bad)">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function renderMkPending() {
  const el = $('mkPending');
  if (!el) return;
  const pending = [
    { name: 'Дни рождения клиентов (7/30 дн)', need: 'Endpoint /catalog?name=ИнформационныеКарты с фильтром по ДатаРождения BETWEEN now AND now+N' },
    { name: 'Гео-карта микрорайонов', need: 'Полный доступ к ИнформационныеКарты.МикрорайонПроживания' },
    { name: 'Сегмент «семьи с детьми»', need: 'Полный доступ к ИнформационныеКарты.Дети' },
    { name: 'Эффективность ДР-скидки', need: 'Совмещение ИнформационныеКарты + ПредоставленныеСкидки.УсловиеСкидки = «ДР»' },
    { name: 'Маржинальный/Заказные торты/Здоровое', need: 'Атрибуты Номенклатуры в payload /pull (Маржинальный, ЗаказнойТорт, Аллерген)' },
    { name: 'Бренд-анализ', need: 'НоменклатурныеГруппы.Бренд в /object или включение в /pull' },
    { name: 'Market Basket (что покупают вместе)', need: 'Состав ЧекККМ — табличная часть Товары. Сейчас /document отдаёт шапку чека без позиций' },
    { name: 'Когортный анализ retention', need: 'Длинная история карт за 6-12 мес (доступно через Бонусы по месяцам, нужна оптимизация запросов)' },
    { name: 'Кластеризация магазинов', need: 'Можно сделать на наших данных, добавлю в Pack 4' }
  ];
  el.innerHTML = `
    <div style="padding:8px 16px;font-size:12px;color:var(--muted)">9 отчётов готовы к реализации — ждут расширения BSL HTTP-сервиса 1С (см. Hellstaff TODO).</div>
    <div class="table-wrap"><table class="num-table">
      <thead><tr><th>Отчёт</th><th>Что нужно от 1С/Hellstaff</th></tr></thead>
      <tbody>${pending.map(p => `<tr><td><b>⏳ ${escapeHtml(p.name)}</b></td><td><small class="muted">${escapeHtml(p.need)}</small></td></tr>`).join('')}</tbody>
    </table></div>`;
}

async function loadPromo() {
  const availEl = $('promoAvailability');
  const contentEl = $('promoContent');
  const truncEl = $('promoTruncated');
  try {
    const params = new URLSearchParams();
    if (analyticsState.range.from) params.set('from', analyticsState.range.from.slice(0,7));
    if (analyticsState.range.to) params.set('to', analyticsState.range.to.slice(0,7));
    if (!params.has('from')) params.set('from', state.period);
    if (!params.has('to')) params.set('to', state.period);
    const data = await fetchJson(`/api/analytics/promo?${params.toString()}`);
    if (!data.available) {
      availEl.classList.remove('hidden');
      availEl.innerHTML = `<b>Канал к 1С не настроен.</b> ${escapeHtml(data.note || '')}`;
      contentEl.style.display = 'none';
      return;
    }
    if (data.error || data.discounts?.error) {
      availEl.classList.remove('hidden');
      availEl.innerHTML = `<b>Ошибка:</b> ${escapeHtml(data.error || data.discounts?.error || '')} <button class="link-btn" id="promoRetry">Повторить</button>`;
      $('promoRetry')?.addEventListener('click', () => { analyticsState.promoData = null; loadPromo(); });
      contentEl.style.display = 'none';
      return;  // НЕ сохраняем в state
    }
    // Успешный ответ — показываем контейнер (могло быть скрыто после прошлой ошибки)
    analyticsState.promoData = data;
    availEl.classList.add('hidden');
    contentEl.style.display = '';
    availEl.classList.add('hidden');
    contentEl.style.display = '';

    const d = data.discounts || {};
    if (d.truncatedNote) {
      truncEl.classList.remove('hidden');
      truncEl.textContent = '⚠ ' + d.truncatedNote;
    } else {
      truncEl.classList.add('hidden');
    }

    // KPI
    const gift = data.giftCertificates || {};
    const coffee = data.coffeeCertificates || {};
    $('promoKpis').innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Сумма скидок</div><div class="kpi-value">${fmtNum(d.totalSum || 0)} ₽</div></div>
      <div class="kpi-card"><div class="kpi-label">Применений</div><div class="kpi-value">${fmtNum(d.totalRows || 0)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Подарочные сертификаты</div><div class="kpi-value">${fmtNum(gift.totalSum || 0)} ₽<div style="font-size:11px;color:var(--muted)">${fmtNum(gift.movements || 0)} операций</div></div></div>
      <div class="kpi-card"><div class="kpi-label">Сертификаты на кофе</div><div class="kpi-value">${fmtNum(coffee.movements || 0)}<div style="font-size:11px;color:var(--muted)">операций</div></div></div>
    `;

    // По условиям
    const condTbody = document.querySelector('#promoConditionTbl tbody');
    if (condTbody) {
      condTbody.innerHTML = (d.byCondition || []).map((r, i) => `
        <tr>
          <td class="col-num">${i+1}</td>
          <td><b>${escapeHtml(r.condition)}</b></td>
          <td class="num">${fmtNum(r.sum)} ₽</td>
          <td class="num">${fmtNum(r.count)}</td>
        </tr>
      `).join('');
    }

    // По товарам
    const prodTbody = document.querySelector('#promoProductTbl tbody');
    if (prodTbody) {
      prodTbody.innerHTML = (d.byProduct || []).map((r, i) => `
        <tr>
          <td class="col-num">${i+1}</td>
          <td>${escapeHtml(r.product)}</td>
          <td class="num">${fmtNum(r.sum)} ₽</td>
          <td class="num">${fmtNum(r.count)}</td>
        </tr>
      `).join('');
    }

    // По типу документа
    const docTbody = document.querySelector('#promoDocTbl tbody');
    if (docTbody) {
      docTbody.innerHTML = (d.byDocType || []).map(r => `
        <tr>
          <td><b>${escapeHtml(r.docType)}</b></td>
          <td class="num">${fmtNum(r.sum)} ₽</td>
          <td class="num">${fmtNum(r.count)}</td>
        </tr>
      `).join('');
    }

    loadPromoDynamics();
    loadPromoByAction();
  } catch (e) {
    if (availEl) {
      availEl.classList.remove('hidden');
      availEl.innerHTML = `<b>Ошибка:</b> ${escapeHtml(e.message)}`;
    }
    if (contentEl) contentEl.style.display = 'none';
  }
}

async function loadTopCustomers() {
  const tbody = document.querySelector('#topCustomersTbl tbody');
  const noteEl = $('topCustomersNote');
  if (!tbody) return;
  try {
    const params = new URLSearchParams();
    if (analyticsState.range.from) params.set('from', analyticsState.range.from.slice(0,7));
    if (analyticsState.range.to) params.set('to', analyticsState.range.to.slice(0,7));
    if (!params.has('from')) params.set('from', state.period);
    if (!params.has('to')) params.set('to', state.period);
    const data = await fetchJson(`/api/analytics/top-customers?${params.toString()}`);
    if (!data.available || data.error) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px">${escapeHtml(data.note || data.error || 'Нет данных')}</td></tr>`;
      return;
    }
    const top = data.topCards || [];
    tbody.innerHTML = top.map((r, i) => `
      <tr>
        <td class="col-num">${i+1}</td>
        <td>${escapeHtml(r.owner || r.card)}<div style="font-size:11px;color:var(--muted)">${escapeHtml(r.card)}</div></td>
        <td class="num">${fmtNum(r.revenue)} ₽</td>
        <td class="num">${fmtNum(r.transactions)}</td>
        <td class="num">${fmtNum(r.avgTicket)} ₽</td>
      </tr>`).join('') || `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px">Нет данных за период</td></tr>`;
    if (noteEl) {
      noteEl.textContent = data.truncatedNote
        ? `⚠ ${data.truncatedNote}`
        : `${fmtNum(data.totalCards || 0)} карт, ${fmtNum(data.totalTransactions || 0)} операций, ${fmtNum(data.totalRevenue || 0)} ₽ оборота`;
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px">Ошибка: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function loadRetention() {
  const availEl = $('retentionAvailability');
  const contentEl = $('retentionContent');
  const noteEl = $('retentionBaselineNote');
  if (!availEl || !contentEl) return;
  try {
    const params = new URLSearchParams();
    if (analyticsState.range.from) params.set('from', analyticsState.range.from.slice(0,7));
    if (analyticsState.range.to) params.set('to', analyticsState.range.to.slice(0,7));
    if (!params.has('from')) params.set('from', state.period);
    if (!params.has('to')) params.set('to', state.period);
    const data = await fetchJson(`/api/analytics/customers-retention?${params.toString()}`);
    if (!data.available || data.error) {
      availEl.classList.remove('hidden');
      availEl.innerHTML = `<b>Недоступно:</b> ${escapeHtml(data.note || data.error || '')}`;
      contentEl.style.display = 'none';
      return;
    }
    availEl.classList.add('hidden');
    contentEl.style.display = '';
    const s = data.summary || {};
    $('retTotalCards').textContent = fmtNum(s.totalActiveCards || 0);
    $('retNewCards').textContent = `${fmtNum(s.newCards || 0)} (${s.newPct || 0}%)`;
    $('retReturningCards').textContent = `${fmtNum(s.returningCards || 0)} (${s.returningPct || 0}%)`;
    $('retReturningPct').textContent = `${s.returningPct || 0}%`;
    if (noteEl) {
      const b = data.baseline || {};
      noteEl.textContent = `baseline ${b.from || '?'}…${b.to || '?'} (${fmtNum(b.totalCardsKnown || 0)} известных карт)`;
    }
  } catch (e) {
    if (availEl) {
      availEl.classList.remove('hidden');
      availEl.innerHTML = `<b>Ошибка retention:</b> ${escapeHtml(e.message)}`;
    }
    if (contentEl) contentEl.style.display = 'none';
  }
}

async function loadPromoByAction() {
  const tbody = document.querySelector('#promoActionTbl tbody');
  const kpis = $('promoActionKpis');
  const bslNote = $('promoActionBslNote');
  const noteEl = $('promoActionNote');
  if (!tbody || !kpis) return;
  try {
    const params = new URLSearchParams();
    if (analyticsState.range.from) params.set('from', analyticsState.range.from.slice(0,7));
    if (analyticsState.range.to) params.set('to', analyticsState.range.to.slice(0,7));
    if (!params.has('from')) params.set('from', state.period);
    if (!params.has('to')) params.set('to', state.period);
    const data = await fetchJson(`/api/analytics/promo-by-action?${params.toString()}`);
    if (!data.available || data.error) {
      kpis.innerHTML = '';
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px">${escapeHtml(data.note || data.error || 'Нет данных')}</td></tr>`;
      return;
    }
    kpis.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Применений</div><div class="kpi-value">${fmtNum(data.totalApplications || 0)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Заказов / чеков</div><div class="kpi-value">${fmtNum(data.uniqueDocuments || 0)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Сумма скидок</div><div class="kpi-value">${fmtNum(data.totalDiscountSum || 0)} ₽</div></div>`;
    if (bslNote && data.bslLimitNote) {
      bslNote.classList.remove('hidden');
      bslNote.textContent = '⚠ ' + data.bslLimitNote;
    }
    tbody.innerHTML = (data.documents || []).map(r => `
      <tr>
        <td style="font-size:12px">${escapeHtml(r.document)}</td>
        <td>${escapeHtml(r.store)}</td>
        <td class="num">${fmtNum(r.productCount)}</td>
        <td class="num">${fmtNum(r.totalSum)} ₽</td>
        <td style="font-size:11px;color:var(--muted)">${escapeHtml(r.date)}</td>
      </tr>`).join('') || `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px">За период скидок по акциям не найдено</td></tr>`;
    if (noteEl) {
      noteEl.textContent = data.truncatedNote ? `⚠ ${data.truncatedNote}` : '';
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px">Ошибка: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function loadPromoDynamics() {
  const tbody = document.querySelector('#promoDynamicsTbl tbody');
  const noteEl = $('promoDynamicsNote');
  if (!tbody) return;
  try {
    const params = new URLSearchParams();
    if (analyticsState.range.from) params.set('from', analyticsState.range.from.slice(0,7));
    if (analyticsState.range.to) params.set('to', analyticsState.range.to.slice(0,7));
    if (!params.has('from')) params.set('from', state.period);
    if (!params.has('to')) params.set('to', state.period);
    const data = await fetchJson(`/api/analytics/promo-dynamics?${params.toString()}`);
    if (!data.available || data.error) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px">${escapeHtml(data.note || data.error || 'Нет данных')}</td></tr>`;
      return;
    }
    const top = data.topProducts || [];
    const series = data.series || [];
    tbody.innerHTML = top.map((p, i) => {
      const s = series.find(x => x.product === p.product);
      const daysActive = s ? s.points.filter(pt => pt.sum > 0).length : 0;
      return `
        <tr>
          <td class="col-num">${i+1}</td>
          <td>${escapeHtml(p.product)}</td>
          <td class="num">${fmtNum(p.sum)} ₽</td>
          <td class="num">${daysActive}</td>
        </tr>`;
    }).join('') || `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px">За период нет акционных позиций</td></tr>`;
    if (noteEl) {
      noteEl.textContent = data.truncatedNote ? `⚠ ${data.truncatedNote}` : `${fmtNum(data.totalRows || 0)} строк за период`;
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px">Ошибка: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function loadProduction() {
  const availEl = $('productionAvailability');
  const contentEl = $('productionContent');
  if (!availEl || !contentEl) return;
  try {
    const params = new URLSearchParams();
    if (analyticsState.range.from) params.set('from', analyticsState.range.from.slice(0,10));
    if (analyticsState.range.to) params.set('to', analyticsState.range.to.slice(0,10));
    const periodYM = state.period;
    const fromYM = analyticsState.range.from ? analyticsState.range.from.slice(0,7) : periodYM;
    const toYM = analyticsState.range.to ? analyticsState.range.to.slice(0,7) : periodYM;

    // Параллельно для скорости: sales-kg и production-kg
    const [salesKg, prodKg] = await Promise.all([
      fetchJson(`/api/analytics/sales-kg?${params.toString()}`).catch(e => ({ available: false, error: e.message })),
      fetchJson(`/api/analytics/production-kg?from=${fromYM}&to=${toYM}`).catch(e => ({ available: false, error: e.message }))
    ]);
    analyticsState.productionData = { salesKg, prodKg };

    // Sales-kg
    const skKpis = $('salesKgKpis');
    const skTbody = document.querySelector('#salesKgCategoryTbl tbody');
    if (!salesKg.available) {
      skKpis.innerHTML = `<div class="empty-state" style="grid-column:span 4;padding:14px">${escapeHtml(salesKg.note || salesKg.error || 'Недоступно')}</div>`;
      if (skTbody) skTbody.innerHTML = '';
    } else {
      const s = salesKg.summary || {};
      skKpis.innerHTML = `
        <div class="kpi-card"><div class="kpi-label">Всего кг продано</div><div class="kpi-value">${fmtNum(s.totalKg || 0)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Шт с весом</div><div class="kpi-value">${fmtNum(s.totalQtyMatched || 0)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Шт без веса</div><div class="kpi-value">${fmtNum(s.totalQtyUnmatched || 0)}</div></div>
        <div class="kpi-card"><div class="kpi-label">% с весом</div><div class="kpi-value">${s.matchedPct || 0}%</div></div>`;
      if (skTbody) {
        skTbody.innerHTML = (salesKg.byCategory || []).map(r => `
          <tr>
            <td><b>${escapeHtml(r.category)}</b></td>
            <td class="num">${fmtNum(r.kg)}</td>
            <td class="num">${fmtNum(r.qty)}</td>
            <td class="num">${fmtNum(r.amount)} ₽</td>
          </tr>`).join('') || `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px">Нет данных за период</td></tr>`;
      }
    }

    // Production-kg
    const pkKpis = $('productionKgKpis');
    const pkTbody = document.querySelector('#productionKgTopTbl tbody');
    if (!prodKg.available) {
      pkKpis.innerHTML = `<div class="empty-state" style="grid-column:span 4;padding:14px">${escapeHtml(prodKg.note || prodKg.error || 'Недоступно')}</div>`;
      if (pkTbody) pkTbody.innerHTML = '';
    } else {
      const s = prodKg.summary || {};
      pkKpis.innerHTML = `
        <div class="kpi-card"><div class="kpi-label">Выпущено кг</div><div class="kpi-value">${fmtNum(s.totalKg || 0)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Всего шт/ед.</div><div class="kpi-value">${fmtNum(s.totalQty || 0)}</div></div>
        <div class="kpi-card"><div class="kpi-label">SKU с весом</div><div class="kpi-value">${fmtNum(s.productsWithWeight || 0)}</div></div>
        <div class="kpi-card"><div class="kpi-label">SKU без веса</div><div class="kpi-value">${fmtNum(s.productsWithoutWeight || 0)}</div></div>`;
      if (pkTbody) {
        pkTbody.innerHTML = (prodKg.topProducts || []).map((r, i) => `
          <tr>
            <td class="col-num">${i+1}</td>
            <td>${escapeHtml(r.product)}</td>
            <td class="num">${fmtNum(r.qty)}</td>
            <td class="num">${fmtNum(r.kg)}</td>
          </tr>`).join('') || `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px">Нет выпуска за период</td></tr>`;
      }
    }

    availEl.classList.add('hidden');
    contentEl.style.display = '';
  } catch (e) {
    availEl.classList.remove('hidden');
    availEl.innerHTML = `<b>Ошибка:</b> ${escapeHtml(e.message)}`;
    contentEl.style.display = 'none';
  }
}

async function loadChequeCategories() {
  const tbody = document.querySelector('#chequeCategoriesTbl tbody');
  const totalEl = $('chequeCategoriesTotal');
  if (!tbody) return;
  try {
    const params = new URLSearchParams();
    if (analyticsState.range.from) params.set('from', analyticsState.range.from.slice(0,10));
    if (analyticsState.range.to) params.set('to', analyticsState.range.to.slice(0,10));
    const data = await fetchJson(`/api/analytics/cheque-categories?${params.toString()}`);
    if (totalEl) totalEl.textContent = fmtNum(data.totalCheques || 0);
    tbody.innerHTML = (data.byCategory || []).map(r => `
      <tr>
        <td><b>${escapeHtml(r.category)}</b></td>
        <td class="num">${fmtNum(r.chequeCount)}</td>
        <td class="num">${r.chequePct}%</td>
        <td class="num">${fmtNum(r.amount)} ₽</td>
      </tr>`).join('') || `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px">Нет данных за период</td></tr>`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px">Ошибка: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderCustomersFuture(d) {
  const el = $('customersFutureNote');
  if (!el) return;
  const items = [];
  if (d.birthdays && !d.birthdays.available) {
    items.push(`<b>Дни рождения / Гео-аналитика:</b> ${escapeHtml(d.birthdays.note)}`);
  }
  if (!items.length) { el.parentElement.style.display = 'none'; return; }
  el.innerHTML = '<b>Что появится после обновления HTTP-сервиса (новые операции):</b><br>• ' + items.join('<br>• ') +
    '<br>• Топ клиентов по обороту (через /sales-detail)' +
    '<br>• Когортный анализ возвратов клиентов через год' +
    '<br>• Гео-карта по микрорайонам Иркутска' +
    '<br>• Дни рождения сегодня/неделя → push в Telegram-бот maria-bot';
}

function switchPage(page) {
  analyticsState.currentPage = page;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('nav-active', b.dataset.page === page));
  $('page-dashboard').classList.toggle('hidden', page !== 'dashboard');
  $('page-analytics').classList.toggle('hidden', page !== 'analytics');
  const mkt = $('page-marketing'); if (mkt) mkt.classList.toggle('hidden', page !== 'marketing');
  if (page === 'marketing' && typeof mktInit === 'function') mktInit();
  setTimeout(() => urlStateWrite && urlStateWrite(), 0);
}

async function loadAnalytics() {
  try {
    const params = new URLSearchParams({ period: state.period });
    if (analyticsState.range.from) params.set('from', analyticsState.range.from);
    if (analyticsState.range.to) params.set('to', analyticsState.range.to);
    const data = await fetchJson(`/api/analytics/sales?${params.toString()}`);
    analyticsState.data = data;
    $('analyticsPeriodTag').textContent = `период ${data.period}`;
    renderByChannel();
    renderByCategory();
    renderCategoryChart();
    renderCategoryAbc();
    renderAbc();
    renderWeekly();
    renderWeekday();
    renderDaily();
    renderStoreMarkup();
    renderHourChart();
    renderHeatmap();
    renderTopMargin();
    renderReturns();
    renderComparison();
    renderCheques();
    renderDiscounts();
    renderNewProducts();
    renderCakeSegments();
    renderByStoreFormat();
    updateDateRangeStatus();
    loadChequeCategories();
  } catch (err) {
    console.error('analytics load failed', err);
  }
}

function fmtMoneyShort(v) {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1_000_000) return (v/1_000_000).toFixed(2).replace(/\.?0+$/, '') + ' млн';
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString('ru-RU');
  return v.toLocaleString('ru-RU');
}
function fmtNum(v) {
  if (!Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('ru-RU');
}
function fmtPct(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(1) + '%';
}

const CHANNEL_NAMES = { retail: 'Розница (ЧекККМ)', corporate: 'Опт / корпоративные', mixed: 'Смешанные', unknown: '— без источника' };

function renderByChannel() {
  const tbody = document.querySelector('#analyticsByChannelTbl tbody');
  if (!tbody) return;
  const rows = analyticsState.data?.byChannel || [];
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><b>${escapeHtml(CHANNEL_NAMES[r.source] || r.source)}</b></td>
      <td class="num">${r.storesCount}</td>
      <td class="num">${fmtNum(r.plan)}</td>
      <td class="num"><b>${fmtNum(r.fact)}</b></td>
      <td class="num">${r.completion ? r.completion.toFixed(1) + '%' : '—'}</td>
      <td class="num">${fmtNum(r.cost)}</td>
      <td class="num">${r.margin === null ? '—' : fmtNum(r.margin)}</td>
      <td class="num">${fmtPct(r.marginPct)}</td>
      <td class="num">${fmtNum(r.quantity)}</td>
    </tr>
  `).join('');
}

function renderByCategory() {
  const tbody = document.querySelector('#analyticsByCategoryTbl tbody');
  if (!tbody) return;
  const rows = analyticsState.data?.byCategory || [];
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><b>${escapeHtml(r.category)}</b></td>
      <td class="num">${r.products}</td>
      <td class="num"><b>${fmtNum(r.fact)}</b></td>
      <td class="num">${r.share.toFixed(1)}%</td>
      <td class="num">${fmtNum(r.cost)}</td>
      <td class="num">${r.margin === null ? '—' : fmtNum(r.margin)}</td>
      <td class="num">${fmtPct(r.marginPct)}</td>
      <td class="num">${r.markupPct === null ? '—' : r.markupPct.toFixed(0) + '%'}</td>
    </tr>
  `).join('');
}

function renderAbc() {
  const tbody = document.querySelector('#analyticsAbcTbl tbody');
  const moreEl = $('analyticsAbcMore');
  if (!tbody) return;
  let rows = analyticsState.data?.abc || [];
  if (analyticsState.abcFilter !== 'all') {
    rows = rows.filter(r => r.abc === analyticsState.abcFilter);
  }
  const total = rows.length;
  const shown = rows.slice(0, analyticsState.abcLimit);
  tbody.innerHTML = shown.map((r, i) => `
    <tr>
      <td class="col-num">${i+1}</td>
      <td>${escapeHtml(r.productName)}</td>
      <td><span class="muted" style="font-size:11px">${escapeHtml(r.category || '—')}</span></td>
      <td class="num"><span class="abc-badge abc-${r.abc}">${r.abc}</span></td>
      <td class="num">${fmtNum(r.fact)}</td>
      <td class="num">${r.share.toFixed(2)}%</td>
      <td class="num">${r.cumShare.toFixed(1)}%</td>
      <td class="num">${fmtNum(r.quantity)}</td>
      <td class="num">${fmtPct(r.marginPct)}</td>
    </tr>
  `).join('');
  if (total > analyticsState.abcLimit) {
    moreEl.classList.remove('hidden');
    moreEl.innerHTML = `Показано ${analyticsState.abcLimit} из ${total}. <button class="link-btn" id="abcShowMore">Показать ещё</button>`;
    $('abcShowMore')?.addEventListener('click', () => { analyticsState.abcLimit += 50; renderAbc(); });
  } else {
    moreEl.classList.add('hidden');
    moreEl.innerHTML = '';
  }
}

function renderWeekly() {
  const tbody = document.querySelector('#analyticsWeeklyTbl tbody');
  if (!tbody) return;
  const rows = analyticsState.data?.weekly || [];
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.weekStart}</td>
      <td class="num"><b>${fmtNum(r.fact)}</b></td>
      <td class="num">${fmtNum(r.cost)}</td>
      <td class="num">${r.margin === null ? '—' : fmtNum(r.margin)}</td>
      <td class="num">${r.cost > 0 ? ((r.fact - r.cost)/r.fact*100).toFixed(1) + '%' : '—'}</td>
      <td class="num">${fmtNum(r.quantity)}</td>
    </tr>
  `).join('');
  // Простой бар-чарт (SVG inline)
  const chart = $('analyticsWeeklyChart');
  if (!chart || rows.length === 0) { if (chart) chart.innerHTML = ''; return; }
  const maxFact = Math.max(...rows.map(r => r.fact));
  const w = 800, h = 220, padL = 60, padR = 20, padT = 20, padB = 40;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const barW = innerW / rows.length * 0.7;
  const step = innerW / rows.length;
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:240px">
    ${[0, .25, .5, .75, 1].map(t => `
      <line x1="${padL}" y1="${padT + innerH*(1-t)}" x2="${w-padR}" y2="${padT + innerH*(1-t)}" stroke="currentColor" stroke-opacity="0.08"/>
      <text x="${padL-6}" y="${padT + innerH*(1-t) + 4}" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.5">${fmtAxis(maxFact*t)}</text>
    `).join('')}
    ${rows.map((r, i) => {
      const bh = (r.fact / maxFact) * innerH;
      const x = padL + step*i + (step - barW)/2;
      const y = padT + innerH - bh;
      return `<g>
        <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="3" fill="var(--accent)" opacity="0.85">
          <title>${r.weekStart}: ${fmtNum(r.fact)} ₽</title>
        </rect>
        <text x="${x + barW/2}" y="${h - padB + 14}" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.6">${r.weekStart.slice(5)}</text>
      </g>`;
    }).join('')}
  </svg>`;
}

// Горизонтальный бар-чарт: топ-15 групп по выручке с цветовой кодировкой маржи
function renderCategoryChart() {
  const el = $('analyticsCategoryChart');
  if (!el) return;
  const rows = (analyticsState.data?.byCategory || []).slice(0, 15);
  if (!rows.length) { el.innerHTML = '<div class="empty-state" style="padding:16px">Нет данных</div>'; return; }
  const max = Math.max(...rows.map(r => r.fact));
  const labelW = 180;
  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;padding:8px 4px">${rows.map(r => {
    const w = max > 0 ? (r.fact / max * 100) : 0;
    const tone = r.marginPct === null ? '#94a3b8'
      : r.marginPct >= 70 ? '#22c55e'
      : r.marginPct >= 30 ? '#eab308'
      : '#f43f5e';
    return `<div style="display:flex;align-items:center;gap:10px;font-size:12px">
      <div style="width:${labelW}px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(r.category)}">${escapeHtml(r.category)}</div>
      <div style="flex:1;height:22px;background:var(--glass-soft);border-radius:6px;position:relative">
        <div style="width:${w}%;height:100%;background:${tone};opacity:.85;border-radius:6px"></div>
        <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);font-weight:600;color:var(--ink);text-shadow:0 0 4px var(--bg)">${fmtNum(r.fact)} ₽ · ${r.marginPct === null ? '—' : r.marginPct + '%'}</span>
      </div>
      <div style="width:60px;text-align:right;color:var(--muted)">${r.share.toFixed(1)}%</div>
    </div>`;
  }).join('')}</div>`;
}

function renderCategoryAbc() {
  const tbody = document.querySelector('#analyticsCategoryAbcTbl tbody');
  if (!tbody) return;
  const rows = analyticsState.data?.byCategoryAbc || [];
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><b>${escapeHtml(r.category)}</b></td>
      <td class="num"><span class="abc-badge abc-${r.abc}">${r.abc}</span></td>
      <td class="num">${fmtNum(r.fact)}</td>
      <td class="num">${r.share.toFixed(1)}%</td>
      <td class="num">${r.cumShare.toFixed(1)}%</td>
      <td class="num">${fmtPct(r.marginPct)}</td>
    </tr>
  `).join('');
}

function renderWeekday() {
  const tbody = document.querySelector('#analyticsWeekdayTbl tbody');
  if (!tbody) return;
  const rows = analyticsState.data?.byWeekday || [];
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><b>${escapeHtml(r.weekday)}</b></td>
      <td class="num">${r.daysCount}</td>
      <td class="num">${fmtNum(r.fact)}</td>
      <td class="num">${fmtNum(r.avgPerDay)}</td>
      <td class="num">${r.margin === null ? '—' : fmtNum(r.margin)}</td>
      <td class="num">${fmtPct(r.marginPct)}</td>
    </tr>
  `).join('');
  // Бар-чарт
  const chart = $('analyticsWeekdayChart');
  if (!chart || !rows.length) { if (chart) chart.innerHTML = ''; return; }
  const max = Math.max(...rows.map(r => r.avgPerDay));
  const w = 700, h = 200, padL = 100, padR = 20, padT = 16, padB = 16;
  const innerH = h - padT - padB;
  const rowH = innerH / rows.length;
  const barH = rowH * 0.7;
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:220px">
    ${rows.map((r, i) => {
      const bw = max > 0 ? (r.avgPerDay / max) * (w - padL - padR - 60) : 0;
      const y = padT + rowH*i + (rowH - barH)/2;
      return `<g>
        <text x="${padL - 8}" y="${y + barH/2 + 4}" text-anchor="end" font-size="11" fill="currentColor">${r.weekday.slice(0,3)}</text>
        <rect x="${padL}" y="${y}" width="${bw}" height="${barH}" rx="3" fill="var(--accent)" opacity="0.85"/>
        <text x="${padL + bw + 6}" y="${y + barH/2 + 4}" font-size="11" fill="currentColor" fill-opacity=".7">${fmtNum(r.avgPerDay)} ₽/день</text>
      </g>`;
    }).join('')}
  </svg>`;
}

function renderDaily() {
  const chart = $('analyticsDailyChart');
  if (!chart) return;
  const rows = analyticsState.data?.daily || [];
  if (!rows.length) { chart.innerHTML = '<div class="empty-state" style="padding:16px">Нет данных</div>'; return; }
  const max = Math.max(...rows.map(r => r.fact));
  const w = 900, h = 240, padL = 70, padR = 20, padT = 20, padB = 36;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const step = innerW / rows.length;
  const barW = step * 0.7;
  // Накопительная сумма для линии
  let cum = 0;
  const cumPoints = rows.map((r, i) => {
    cum += r.fact;
    return { x: padL + step*i + step/2, y: padT + innerH - (cum / (rows.reduce((s,r)=>s+r.fact,0)||1)) * innerH };
  });
  const linePath = cumPoints.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ',' + p.y).join(' ');
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:260px">
    ${[0, .25, .5, .75, 1].map(t => `
      <line x1="${padL}" y1="${padT + innerH*(1-t)}" x2="${w-padR}" y2="${padT + innerH*(1-t)}" stroke="currentColor" stroke-opacity="0.08"/>
      <text x="${padL-6}" y="${padT + innerH*(1-t) + 4}" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.5">${fmtAxis(max*t)}</text>
    `).join('')}
    ${rows.map((r, i) => {
      const bh = max > 0 ? (r.fact / max) * innerH : 0;
      const x = padL + step*i + (step - barW)/2;
      const y = padT + innerH - bh;
      const day = Number(r.date.slice(-2));
      return `<g>
        <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="2" fill="var(--accent)" opacity="0.75">
          <title>${r.date}: ${fmtNum(r.fact)} ₽</title>
        </rect>
        ${day % 5 === 0 || i === rows.length - 1 ? `<text x="${x + barW/2}" y="${h - padB + 14}" text-anchor="middle" font-size="9" fill="currentColor" fill-opacity="0.6">${day}</text>` : ''}
      </g>`;
    }).join('')}
    <path d="${linePath}" stroke="#f43f5e" stroke-width="2" fill="none" opacity="0.7"/>
    ${cumPoints.map(p => `<circle cx="${p.x}" cy="${p.y}" r="2" fill="#f43f5e" opacity="0.8"/>`).join('')}
  </svg>
  <div style="text-align:right;font-size:11px;color:var(--muted);margin-top:4px">Красная линия — накопительная доля выручки</div>`;
}

function renderStoreMarkup() {
  const tbody = document.querySelector('#analyticsStoreMarkupTbl tbody');
  if (!tbody) return;
  const rows = analyticsState.data?.byStoreMarkup || [];
  tbody.innerHTML = rows.map((r, i) => `
    <tr>
      <td class="col-num">${i+1}</td>
      <td><b>${escapeHtml(r.storeName)}</b></td>
      <td><span class="muted" style="font-size:11px">${escapeHtml(CHANNEL_NAMES[r.source] || r.source || '—')}</span></td>
      <td class="num">${fmtNum(r.fact)}</td>
      <td class="num">${fmtNum(r.cost)}</td>
      <td class="num">${r.margin === null ? '—' : fmtNum(r.margin)}</td>
      <td class="num">${fmtPct(r.marginPct)}</td>
      <td class="num"><b>${r.markupPct === null ? '—' : r.markupPct.toFixed(0) + '%'}</b></td>
    </tr>
  `).join('');
}

function renderHourChart() {
  const chart = $('analyticsHourChart');
  if (!chart) return;
  const rows = analyticsState.data?.byHour || [];
  if (!rows.length) { chart.innerHTML = '<div class="empty-state" style="padding:16px">Нет данных</div>'; return; }
  const max = Math.max(...rows.map(r => r.fact));
  const w = 900, h = 240, padL = 60, padR = 20, padT = 20, padB = 40;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const step = innerW / 24;
  const barW = step * 0.7;
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:260px">
    ${[0, .25, .5, .75, 1].map(t => `
      <line x1="${padL}" y1="${padT + innerH*(1-t)}" x2="${w-padR}" y2="${padT + innerH*(1-t)}" stroke="currentColor" stroke-opacity="0.08"/>
      <text x="${padL-6}" y="${padT + innerH*(1-t) + 4}" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.5">${fmtAxis(max*t)}</text>
    `).join('')}
    ${rows.map(r => {
      const bh = max > 0 ? (r.fact / max) * innerH : 0;
      const x = padL + step*r.hour + (step - barW)/2;
      const y = padT + innerH - bh;
      const peak = r.fact / max > 0.7;
      return `<g>
        <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="3" fill="${peak ? '#22c55e' : 'var(--accent)'}" opacity="${peak ? 0.95 : 0.75}">
          <title>${r.hour}:00 — ${fmtNum(r.fact)} ₽ · ${r.txCount} строк</title>
        </rect>
        ${r.hour % 2 === 0 ? `<text x="${x + barW/2}" y="${h - padB + 14}" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.65">${r.hour}</text>` : ''}
      </g>`;
    }).join('')}
    <text x="${w/2}" y="${h - 4}" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.5">часы (Иркутск UTC+8)</text>
  </svg>`;
}

function renderHeatmap() {
  const el = $('analyticsHeatmap');
  if (!el) return;
  const cells = analyticsState.data?.heatmap || [];
  if (!cells.length) { el.innerHTML = '<div class="empty-state" style="padding:16px">Нет данных</div>'; return; }
  const max = Math.max(...cells.map(c => c.fact));
  const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const cellSize = 26;
  const labelW = 36;
  const grid = {};
  cells.forEach(c => { grid[`${c.day}-${c.hour}`] = c; });
  el.innerHTML = `
    <div style="display:flex;gap:1px;align-items:center;font-size:10px;color:var(--muted);margin-bottom:4px">
      <div style="width:${labelW}px"></div>
      ${Array.from({length:24}, (_,h)=>`<div style="width:${cellSize}px;text-align:center">${h}</div>`).join('')}
    </div>
    ${days.map((dName, d) => `
      <div style="display:flex;gap:1px;align-items:center;margin-bottom:1px">
        <div style="width:${labelW}px;font-size:11px;color:var(--muted)">${dName}</div>
        ${Array.from({length:24}, (_,h) => {
          const c = grid[`${d}-${h}`] || { fact: 0, count: 0 };
          const intensity = max > 0 ? c.fact / max : 0;
          const bg = intensity === 0
            ? 'var(--glass-soft)'
            : `rgba(168, 85, 247, ${0.15 + intensity * 0.85})`;
          return `<div title="${dName} ${h}:00 — ${fmtNum(c.fact)} ₽ · ${c.count} строк" style="width:${cellSize}px;height:${cellSize}px;background:${bg};border-radius:3px"></div>`;
        }).join('')}
      </div>
    `).join('')}
    <div style="font-size:10px;color:var(--muted);margin-top:8px">Часы Иркутск (UTC+8) · ховер ячейки для деталей</div>
  `;
}

function renderTopMargin() {
  const tbody = document.querySelector('#analyticsTopMarginTbl tbody');
  if (!tbody) return;
  const rows = analyticsState.data?.topMargin || [];
  tbody.innerHTML = rows.map((r, i) => `
    <tr>
      <td class="col-num">${i+1}</td>
      <td><b>${escapeHtml(r.productName)}</b></td>
      <td><span class="muted" style="font-size:11px">${escapeHtml(r.category || '—')}</span></td>
      <td class="num"><span class="abc-badge abc-${r.abc}">${r.abc}</span></td>
      <td class="num">${fmtNum(r.fact)}</td>
      <td class="num"><b>${fmtNum(r.margin)}</b></td>
      <td class="num">${fmtPct(r.marginPct)}</td>
      <td class="num">${fmtNum(r.quantity)}</td>
    </tr>
  `).join('');
}

function renderReturns() {
  const r = analyticsState.data?.returns;
  if (!r) return;

  const summary = $('analyticsReturnsSummary');
  if (summary) {
    summary.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Сумма возвратов</div><div class="kpi-value">${fmtNum(r.totalAmount)} ₽</div></div>
      <div class="kpi-card"><div class="kpi-label">Количество единиц</div><div class="kpi-value">${fmtNum(r.totalQuantity)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Строк возвратов</div><div class="kpi-value">${r.rowsCount}</div></div>
    `;
  }

  const byStoreTbody = document.querySelector('#analyticsReturnsByStoreTbl tbody');
  if (byStoreTbody) {
    byStoreTbody.innerHTML = (r.byStore || []).slice(0, 20).map(s => `
      <tr>
        <td>${escapeHtml(s.storeName)}</td>
        <td class="num">${fmtNum(s.amount)}</td>
        <td class="num">${fmtNum(s.quantity)}</td>
      </tr>
    `).join('') || '<tr><td colspan="3" class="empty-state" style="padding:8px">Возвратов нет</td></tr>';
  }

  const byProductTbody = document.querySelector('#analyticsReturnsByProductTbl tbody');
  if (byProductTbody) {
    byProductTbody.innerHTML = (r.byProduct || []).slice(0, 20).map(p => `
      <tr>
        <td>${escapeHtml(p.productName)}</td>
        <td class="num">${fmtNum(p.amount)}</td>
        <td class="num">${fmtNum(p.quantity)}</td>
      </tr>
    `).join('') || '<tr><td colspan="3" class="empty-state" style="padding:8px">Возвратов нет</td></tr>';
  }
}

// ── Date range фильтр ─────────────────────────────────────────────────
function initDateRange() {
  $('drFrom')?.addEventListener('change', () => { applyDateRange($('drFrom').value, $('drTo').value); });
  $('drTo')?.addEventListener('change', () => { applyDateRange($('drFrom').value, $('drTo').value); });
  $('drApply')?.addEventListener('click', () => applyDateRange($('drFrom').value, $('drTo').value));
  $('drReset')?.addEventListener('click', () => applyDateRange(null, null));
  document.querySelectorAll('.dr-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dr-preset').forEach(b => b.classList.toggle('active', b === btn));
      const range = computePresetRange(btn.dataset.preset);
      applyDateRange(range.from, range.to);
    });
  });
}

function computePresetRange(preset) {
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);
  const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };

  switch (preset) {
    case 'today': {
      const d = startOfDay(today);
      return { from: fmt(d), to: fmt(d) };
    }
    case '7d': {
      const from = startOfDay(today); from.setDate(from.getDate() - 6);
      return { from: fmt(from), to: fmt(today) };
    }
    case '14d': {
      const from = startOfDay(today); from.setDate(from.getDate() - 13);
      return { from: fmt(from), to: fmt(today) };
    }
    case '30d': {
      const from = startOfDay(today); from.setDate(from.getDate() - 29);
      return { from: fmt(from), to: fmt(today) };
    }
    case 'month': {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      const to = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: fmt(from), to: fmt(to) };
    }
    case 'prev-month': {
      const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const to = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: fmt(from), to: fmt(to) };
    }
    default:
      return { from: null, to: null };
  }
}

async function applyDateRange(from, to) {
  analyticsState.range.from = from || null;
  analyticsState.range.to = to || null;
  if ($('drFrom')) $('drFrom').value = from || '';
  if ($('drTo')) $('drTo').value = to || '';
  // Если from/to задан — синхронизируем period с месяцем from
  if (from) {
    const newPeriod = from.slice(0, 7);
    if (newPeriod !== state.period) {
      state.period = newPeriod;
      if ($('periodSelect')) $('periodSelect').value = newPeriod;
    }
  }
  // Сбрасываем кеш клиентов и промо
  analyticsState.customersData = null;
  analyticsState.promoData = null;
  // Визуальная обратная связь — пользователь видит что клик дошёл
  const applyBtn = $('drApply');
  const status = $('drStatus');
  const originalBtnText = applyBtn?.textContent;
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Загружается…'; }
  if (status) status.textContent = 'загружается…';
  try {
    await loadAnalytics();
    if (analyticsState.currentTab === 'customers') await loadCustomers();
    if (analyticsState.currentTab === 'promo') await loadPromo();
  } catch (e) {
    console.error('applyDateRange failed', e);
    if (status) status.textContent = 'ошибка: ' + e.message;
  } finally {
    if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = originalBtnText || 'Применить'; }
  }
}

function updateDateRangeStatus() {
  const el = $('drStatus');
  if (!el) return;
  const r = analyticsState.data?.range;
  if (!r) { el.textContent = `показан весь период ${state.period}`; return; }
  el.textContent = `период: ${r.from || '−∞'} … ${r.to || '+∞'}`;
}

// ── Чеки и средний чек ─────────────────────────────────────────────────
function renderCheques() {
  const c = analyticsState.data?.cheques;
  const emptyEl = $('analyticsChequesEmpty');
  const contentEl = $('analyticsChequesContent');
  if (!c) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    if (contentEl) contentEl.style.display = 'none';
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');
  if (contentEl) contentEl.style.display = '';

  const totalsEl = $('analyticsChequesTotals');
  if (totalsEl) {
    totalsEl.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Всего чеков</div><div class="kpi-value">${fmtNum(c.totals.chequeCount)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Средний чек</div><div class="kpi-value">${fmtNum(c.totals.avgCheque)} ₽</div></div>
      <div class="kpi-card"><div class="kpi-label">С картой</div><div class="kpi-value">${c.totals.cardSharePct}%</div></div>
      <div class="kpi-card"><div class="kpi-label">Чеков/магазин</div><div class="kpi-value">${fmtNum(c.totals.avgChequesPerStore)}</div></div>
    `;
  }
  const tbody = document.querySelector('#analyticsChequesByStoreTbl tbody');
  if (tbody) {
    tbody.innerHTML = c.byStore.map((s, i) => `
      <tr>
        <td class="col-num">${i+1}</td>
        <td><b>${escapeHtml(s.storeName)}</b></td>
        <td class="num">${fmtNum(s.chequeCount)}</td>
        <td class="num"><b>${fmtNum(s.avgCheque)}</b> ₽</td>
        <td class="num">${fmtNum(s.withCardCount)}</td>
        <td class="num">${s.cardSharePct}%</td>
        <td class="num">${fmtNum(s.factSum)}</td>
      </tr>
    `).join('');
  }
}

function renderDiscounts() {
  const c = analyticsState.data?.cheques;
  const emptyEl = $('analyticsDiscountsEmpty');
  const contentEl = $('analyticsDiscountsContent');
  if (!c || !c.discountBreakdown || c.discountBreakdown.length === 0) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    if (contentEl) contentEl.style.display = 'none';
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');
  if (contentEl) contentEl.style.display = '';

  const chart = $('analyticsDiscountsChart');
  if (!chart) return;
  const items = c.discountBreakdown;
  const total = items.reduce((s, i) => s + i.amount, 0);
  const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899'];
  chart.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;padding:8px 4px">
      ${items.map((d, i) => {
        const w = total > 0 ? (d.amount / total * 100) : 0;
        const color = colors[i % colors.length];
        return `<div style="display:flex;align-items:center;gap:10px;font-size:12px">
          <div style="width:180px;color:var(--ink)">${escapeHtml(d.type)}</div>
          <div style="flex:1;height:22px;background:var(--glass-soft);border-radius:6px;position:relative">
            <div style="width:${w}%;height:100%;background:${color};opacity:.85;border-radius:6px"></div>
            <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);font-weight:600;color:var(--ink);text-shadow:0 0 4px var(--bg)">${fmtNum(d.amount)} ₽</span>
          </div>
          <div style="width:60px;text-align:right;color:var(--muted)">${w.toFixed(1)}%</div>
        </div>`;
      }).join('')}
      <div style="text-align:right;margin-top:8px;font-size:13px;color:var(--muted)">Итого скидок: <b style="color:var(--ink)">${fmtNum(total)} ₽</b></div>
    </div>
  `;
}

// ── Новые позиции в ассортименте ──────────────────────────────────────
function renderNewProducts() {
  const rows = analyticsState.data?.newProducts || [];
  const tbody = document.querySelector('#analyticsNewProductsTbl tbody');
  const emptyEl = $('analyticsNewProductsEmpty');
  if (!rows.length) {
    if (tbody) tbody.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');
  if (tbody) {
    tbody.innerHTML = rows.slice(0, 50).map((r, i) => `
      <tr>
        <td class="col-num">${i+1}</td>
        <td><b>${escapeHtml(r.productName)}</b></td>
        <td><span class="muted" style="font-size:11px">${escapeHtml(r.category || '—')}</span></td>
        <td>${r.firstSoldAt}</td>
        <td class="num">${fmtNum(r.fact)}</td>
        <td class="num">${fmtNum(r.quantity)}</td>
        <td class="num">${fmtPct(r.marginPct)}</td>
      </tr>
    `).join('');
  }
}

// ── Ценовые сегменты тортов и пирогов ─────────────────────────────────
function renderCakeSegments() {
  const rows = analyticsState.data?.cakeSegments || [];
  const tbody = document.querySelector('#analyticsCakeSegmentsTbl tbody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state" style="padding:8px">Нет данных о тортах/пирогах в этом периоде</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><b>${escapeHtml(r.segment)}</b></td>
      <td class="num">${r.products}</td>
      <td class="num">${fmtNum(r.quantity)}</td>
      <td class="num"><b>${fmtNum(r.fact)}</b></td>
      <td class="num">${r.share.toFixed(1)}%</td>
      <td class="num">${r.margin === null ? '—' : fmtNum(r.margin)}</td>
      <td class="num">${fmtPct(r.marginPct)}</td>
    </tr>
  `).join('');
}

// ── Средний чек по форматам магазинов ─────────────────────────────────
function renderByStoreFormat() {
  const rows = analyticsState.data?.byStoreFormat;
  const tbody = document.querySelector('#analyticsByFormatTbl tbody');
  const emptyEl = $('analyticsByFormatEmpty');
  const contentEl = $('analyticsByFormatContent');
  if (!rows || rows.length === 0) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    if (contentEl) contentEl.style.display = 'none';
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');
  if (contentEl) contentEl.style.display = '';
  if (tbody) {
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><b>${escapeHtml(r.format)}</b></td>
        <td class="num">${r.storeCount}</td>
        <td class="num">${fmtNum(r.chequeCount)}</td>
        <td class="num"><b>${fmtNum(r.avgCheque)}</b> ₽</td>
        <td class="num">${r.cardSharePct}%</td>
        <td class="num">${fmtNum(r.factSum)}</td>
      </tr>
    `).join('');
  }
}

// ── Сравнительный радар-чарт ──────────────────────────────────────────
function renderComparison() {
  const c = analyticsState.data?.comparison;
  if (!c) return;
  const tbody = document.querySelector('#comparisonTbl tbody');
  if (tbody) {
    tbody.innerHTML = (c.stores || []).map((s, i) => `
      <tr>
        <td class="col-num">${i+1}</td>
        <td><b>${escapeHtml(s.storeName)}</b></td>
        <td class="num">${s.raw.completion.toFixed(1)}%</td>
        <td class="num">${s.raw.marginPct.toFixed(1)}%</td>
        <td class="num">${s.raw.markupPct.toFixed(0)}%</td>
        <td class="num">${fmtNum(s.raw.avgRow)}</td>
        <td class="num">${(s.raw.fact / (c.stores.reduce((sum,x)=>sum+x.raw.fact,0)||1) * 100).toFixed(1)}%</td>
      </tr>
    `).join('');
  }

  const chart = $('comparisonRadar');
  if (!chart) return;
  const stores = c.stores || [];
  const metrics = c.metrics || [];
  if (!stores.length || !metrics.length) { chart.innerHTML = '<div class="empty-state" style="padding:16px">Нет данных</div>'; return; }

  // Рисуем сетку из 4 магазинов на чарт (топ-4 по выручке), иначе перекрытие
  const top = stores.slice(0, 4);
  const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899'];
  const w = 600, h = 480, cx = w/2, cy = h/2 + 10, R = 160;
  const N = metrics.length;
  const angle = (i) => (Math.PI * 2 * i / N) - Math.PI/2;

  // Сеточные кольца
  const rings = [20, 40, 60, 80, 100];
  const ringsSvg = rings.map(r => {
    const pts = metrics.map((_, i) => {
      const a = angle(i);
      const rr = R * (r/100);
      return `${cx + Math.cos(a) * rr},${cy + Math.sin(a) * rr}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-opacity="0.08"/>`;
  }).join('');

  // Спицы
  const spokes = metrics.map((_, i) => {
    const a = angle(i);
    return `<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(a)*R}" y2="${cy + Math.sin(a)*R}" stroke="currentColor" stroke-opacity="0.1"/>`;
  }).join('');

  // Подписи метрик
  const labels = metrics.map((m, i) => {
    const a = angle(i);
    const lr = R + 26;
    const x = cx + Math.cos(a) * lr;
    const y = cy + Math.sin(a) * lr;
    const anchor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" font-size="11" fill="currentColor" fill-opacity="0.75">${m}</text>`;
  }).join('');

  // Полигоны магазинов
  const polys = top.map((s, idx) => {
    const pts = s.normalized.map((v, i) => {
      const a = angle(i);
      const rr = R * Math.min(v, 100) / 100;
      return `${cx + Math.cos(a)*rr},${cy + Math.sin(a)*rr}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="${colors[idx]}" fill-opacity="0.18" stroke="${colors[idx]}" stroke-width="2"/>`;
  }).join('');

  // Точки
  const dots = top.map((s, idx) => s.normalized.map((v, i) => {
    const a = angle(i);
    const rr = R * Math.min(v, 100) / 100;
    return `<circle cx="${cx + Math.cos(a)*rr}" cy="${cy + Math.sin(a)*rr}" r="3" fill="${colors[idx]}"/>`;
  }).join('')).join('');

  // Легенда
  const legend = top.map((s, idx) => `
    <div style="display:flex;align-items:center;gap:6px;font-size:12px">
      <span style="width:14px;height:14px;background:${colors[idx]};border-radius:3px;opacity:0.7"></span>
      <b>${escapeHtml(s.storeName)}</b>
    </div>
  `).join('');

  chart.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:500px">
      ${ringsSvg}${spokes}${labels}${polys}${dots}
    </svg>
    <div style="display:flex;gap:18px;flex-wrap:wrap;justify-content:center;margin-top:6px">${legend}</div>
    <div style="text-align:center;font-size:11px;color:var(--muted);margin-top:6px">Топ-4 магазина по выручке. Все метрики нормализованы 0–100 для сопоставимости.</div>
  `;
}

// CSV экспорт по нажатию на data-csv кнопки
function initCsvButtons() {
  document.querySelectorAll('#page-analytics [data-csv]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.csv;
      const d = analyticsState.data;
      if (!d) return;
      const period = d.period;
      const map = {
        channel:    { rows: d.byChannel,      file: `analytics-channels-${period}.csv`,    fields: ['source','storesCount','plan','fact','cost','margin','marginPct','quantity','completion'] },
        category:   { rows: d.byCategory,     file: `analytics-categories-${period}.csv`,  fields: ['category','products','fact','share','cost','margin','marginPct','markupPct','quantity'] },
        categoryAbc:{ rows: d.byCategoryAbc,  file: `analytics-category-abc-${period}.csv`,fields: ['category','abc','fact','share','cumShare','marginPct'] },
        abc:        { rows: d.abc,            file: `analytics-abc-${period}.csv`,         fields: ['productId','productName','category','abc','fact','share','cumShare','quantity','marginPct'] },
        weekly:     { rows: d.weekly,         file: `analytics-weekly-${period}.csv`,      fields: ['weekStart','fact','cost','margin','quantity'] },
        weekday:    { rows: d.byWeekday,      file: `analytics-weekday-${period}.csv`,     fields: ['weekday','daysCount','fact','avgPerDay','margin','marginPct'] },
        daily:      { rows: d.daily,          file: `analytics-daily-${period}.csv`,       fields: ['date','fact','cost','margin','quantity'] },
        storeMarkup:{ rows: d.byStoreMarkup,  file: `analytics-store-markup-${period}.csv`,fields: ['storeId','storeName','source','fact','cost','margin','marginPct','markupPct'] },
        topMargin:  { rows: d.topMargin,      file: `analytics-top-margin-${period}.csv`,  fields: ['productName','category','abc','fact','margin','marginPct','quantity'] },
        returns:    { rows: d.returns?.byProduct || [], file: `analytics-returns-${period}.csv`, fields: ['productName','amount','quantity'] },
        chequesByStore: { rows: d.cheques?.byStore || [], file: `analytics-cheques-${period}.csv`, fields: ['storeName','chequeCount','avgCheque','withCardCount','cardSharePct','factSum'] },
        newProducts: { rows: d.newProducts || [], file: `analytics-new-products-${period}.csv`, fields: ['productName','category','firstSoldAt','fact','quantity','marginPct'] },
        cakeSegments: { rows: d.cakeSegments || [], file: `analytics-cake-segments-${period}.csv`, fields: ['segment','products','quantity','fact','share','margin','marginPct'] }
      };
      const def = map[kind];
      if (!def) return;
      const rows = (def.rows || []).map(r => {
        const obj = {};
        def.fields.forEach(f => obj[f] = r[f]);
        return obj;
      });
      exportCsv(rows, def.file);
    });
  });
}

const PENDING_REPORTS = [
  { title: '✓ Средний чек и количество чеков', note: 'ГОТОВО — раздел «Чеки» в табе «Сеть» заполнится после деплоя BSL у Hellstaff' },
  { title: '✓ % чеков с дисконтной картой', note: 'ГОТОВО — приходит вместе с чеками' },
  { title: '✓ Скидки по видам', note: 'ГОТОВО — разбивка ручная/авто/подарочные/бонусы' },
  { title: '✓ Новые позиции (свежие SKU)', note: 'ГОТОВО — вычисляется на сервере по первому soldAt, в табе «Товары». Будет точнее когда в БД накопится история нескольких месяцев.' },
  { title: '✓ Торты по ценовым сегментам', note: 'ГОТОВО — по средней цене за единицу: до 300 / 300-500 / 500-800 / 800-1500 / 1500+, в табе «Товары»' },
  { title: '✓ Средний чек по форматам магазинов', note: 'ГОТОВО на сервере — заполнится после того как в 1С заполнят реквизит Склад.ФорматМагазина (BSL уже умеет передавать)' },
  { title: '✓ Новые / постоянные клиенты', note: 'ГОТОВО — блок в табе «Клиенты». Сравниваем bonus-карты текущего периода с baseline 6 мес.' },
  { title: '✓ Доли категорий в количестве чеков', note: 'ГОТОВО — секция в табе «Товары». Чек восстанавливается из БД sales по (магазин × время до секунды).' },
  { title: '✓ Динамика акционных позиций', note: 'ГОТОВО — блок в табе «Промо». Топ-10 акционных товаров за период (из ПредоставленныеСкидки).' },
  { title: '✓ Топ клиентов по обороту', note: 'ГОТОВО — добавлено после probe 1С. РегистрНакопления.ПродажиПоДисконтнымКартам отдаёт выручку по карте (отдельно от бонусов).' },
  { title: '⏳ Продано в килограммах', note: 'Нужна правка BSL: функция ВыполнитьProductsDetail обращается к Н.БазоваяЕдиницаИзмерения.Коэффициент, которого нет в УПП Маши. После правки — заработает через ф_ВесШтукивКг.' },
  { title: '⏳ Выпуск продукции в кг', note: 'РегистрНакопления.ВыпускПродукции в УПП Маши пустой за апрель. Нужно подтверждение — в каком регистре реально лежат данные о выпуске (Выпуск? ВыпускПродукцииНаработка?).' }
];

function renderPendingReports() {
  const el = $('analyticsPending');
  if (!el) return;
  el.innerHTML = `<div class="pending-list">` + PENDING_REPORTS.map(r => `
    <div class="pending-card">
      <div class="pending-card-title">${escapeHtml(r.title)}</div>
      <div class="pending-card-note">${escapeHtml(r.note)}</div>
    </div>
  `).join('') + `</div>`;
}

init();

/* ── Маркетинг: помесячные данные + рендер с выбором периода ── */
var MKT = {
  months: ['Январь','Февраль','Март','Апрель','Май*'],
  revenue:[27298107,27785955,34771425,31011451,24039792],
  cheques:[23020,24716,28072,27806,25372],
  cardPct:[86.3,83.2,79.5,76.8,74.1],
  bonus:[788087,817449,1359668,1513728,1102186],
  smsCnt:[3,10,13,5,7],
  smsSent:[6060,24579,28464,3782,5774],
  smsCost:[41581,119938,193691,29937,45745],
  ctxCost:[1827,5177,46837,38673,50878],
  ctxClicks:[244,869,3866,3197,2959],
  ctxPurch:[10,13,296,147,106],
  gis:[10131,10633,12584,12412,8662],
  gisAct:[11386,11233,12725,12591,8451],
  sweet:[0,1,26,80,157],
  sweetCards:[0,1,2,35,54],
  sweetPts:[0,3,0,147,273]
};
function mNum(n){ return Math.round(n).toLocaleString('ru-RU'); }
function mNum1(n){ return (Math.round(n*10)/10).toLocaleString('ru-RU'); }
function mKpi(v,l){ return '<div class="mkt-kpi"><div class="mkt-v">'+v+'</div><div class="mkt-l">'+l+'</div></div>'; }
function mTbl(cols, rows, total){
  var th = cols.map(function(c,i){ return '<th'+(i?' class="num"':'')+'>'+c+'</th>'; }).join('');
  var body = rows.map(function(r){ return '<tr>'+r.map(function(v,i){ return '<td'+(i?' class="num"':'')+'>'+v+'</td>'; }).join('')+'</tr>'; }).join('');
  var tot = total ? '<tr class="mkt-total">'+total.map(function(v,i){ return '<td'+(i?' class="num"':'')+'>'+v+'</td>'; }).join('')+'</tr>' : '';
  return '<table><thead><tr>'+th+'</tr></thead><tbody>'+body+tot+'</tbody></table>';
}
function mAxisFmt(n){ n=Math.round(n); if(n>=1e6) return (Math.round(n/1e5)/10).toLocaleString('ru-RU')+' млн'; if(n>=1e3) return Math.round(n/1e3)+'к'; return ''+n; }
function mBars(elId, labels, values, color, unit){
  var el=document.getElementById(elId); if(!el) return;
  var w=720,h=230,padL=58,padR=14,padT=14,padB=32, iw=w-padL-padR, ih=h-padT-padB;
  var max=Math.max.apply(null, values.concat([1])), step=iw/labels.length, bw=step*0.6;
  var grid=[0,.25,.5,.75,1].map(function(t){ var y=padT+ih*(1-t); return '<line x1="'+padL+'" y1="'+y+'" x2="'+(w-padR)+'" y2="'+y+'" stroke="currentColor" stroke-opacity="0.08"/><text x="'+(padL-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.5">'+mAxisFmt(max*t)+'</text>'; }).join('');
  var bars=labels.map(function(lb,i){ var bh=values[i]/max*ih, x=padL+step*i+(step-bw)/2, y=padT+ih-bh; return '<g><rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(bh,0).toFixed(1)+'" rx="3" fill="'+color+'" opacity="0.85"><title>'+lb+': '+mNum(values[i])+(unit||'')+'</title></rect><text x="'+(x+bw/2).toFixed(1)+'" y="'+(h-padB+14)+'" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.6">'+lb+'</text></g>'; }).join('');
  el.innerHTML='<svg viewBox="0 0 '+w+' '+h+'" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:230px">'+grid+bars+'</svg>';
}
function mGroup(elId, labels, a, b, ca, cb){
  var el=document.getElementById(elId); if(!el) return;
  var w=720,h=230,padL=58,padR=14,padT=14,padB=32, iw=w-padL-padR, ih=h-padT-padB;
  var max=Math.max.apply(null, a.concat(b).concat([1])), step=iw/labels.length, bw=step*0.30;
  var grid=[0,.25,.5,.75,1].map(function(t){ var y=padT+ih*(1-t); return '<line x1="'+padL+'" y1="'+y+'" x2="'+(w-padR)+'" y2="'+y+'" stroke="currentColor" stroke-opacity="0.08"/><text x="'+(padL-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.5">'+mAxisFmt(max*t)+'</text>'; }).join('');
  var bars=labels.map(function(lb,i){ var x0=padL+step*i+(step-bw*2-4)/2, ha=a[i]/max*ih, hb=b[i]/max*ih; return '<g><rect x="'+x0.toFixed(1)+'" y="'+(padT+ih-ha).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(ha,0).toFixed(1)+'" rx="2" fill="'+ca+'" opacity="0.85"><title>'+lb+' SMS: '+mNum(a[i])+' ₽</title></rect><rect x="'+(x0+bw+4).toFixed(1)+'" y="'+(padT+ih-hb).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(hb,0).toFixed(1)+'" rx="2" fill="'+cb+'" opacity="0.85"><title>'+lb+' Контекст: '+mNum(b[i])+' ₽</title></rect><text x="'+(x0+bw+2).toFixed(1)+'" y="'+(h-padB+14)+'" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.6">'+lb+'</text></g>'; }).join('');
  el.innerHTML='<svg viewBox="0 0 '+w+' '+h+'" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:230px">'+grid+bars+'</svg>';
}
function mktRender(){
  var fromEl=document.getElementById('mktFrom'), toEl=document.getElementById('mktTo');
  if(!fromEl||!toEl) return;
  var a=+fromEl.value, b=+toEl.value, lo=Math.min(a,b), hi=Math.max(a,b), idx=[];
  for(var i=lo;i<=hi;i++) idx.push(i);
  function sum(arr){ return idx.reduce(function(s,i){return s+arr[i];},0); }
  var rev=sum(MKT.revenue), smsC=sum(MKT.smsCost), ctxC=sum(MKT.ctxCost), smsS=sum(MKT.smsSent), pur=sum(MKT.ctxPurch), chq=sum(MKT.cheques);
  document.getElementById('mktKpis').innerHTML =
    mKpi(mNum(rev)+' ₽','Выручка') +
    mKpi(mNum(smsC+ctxC)+' ₽','Платный маркетинг (SMS+контекст)') +
    mKpi(mNum(smsS),'SMS отправлено ('+mNum(smsC)+' ₽)') +
    mKpi(mNum(pur),'Покупок с рекламы ('+mNum(ctxC)+' ₽)');
  document.getElementById('mktSms').innerHTML = mTbl(
    ['Месяц','Рассылок','SMS отправлено','Стоимость, ₽','Цена SMS, ₽'],
    idx.map(function(i){ return [MKT.months[i], mNum(MKT.smsCnt[i]), mNum(MKT.smsSent[i]), mNum(MKT.smsCost[i]), MKT.smsSent[i]?mNum1(MKT.smsCost[i]/MKT.smsSent[i]):'—']; }),
    ['Итого', mNum(sum(MKT.smsCnt)), mNum(smsS), mNum(smsC), smsS?mNum1(smsC/smsS):'—']);
  document.getElementById('mktCtx').innerHTML = mTbl(
    ['Месяц','Расход, ₽','Клики','Покупок','CPA, ₽'],
    idx.map(function(i){ return [MKT.months[i], mNum(MKT.ctxCost[i]), mNum(MKT.ctxClicks[i]), mNum(MKT.ctxPurch[i]), MKT.ctxPurch[i]?mNum(MKT.ctxCost[i]/MKT.ctxPurch[i]):'—']; }),
    ['Итого', mNum(ctxC), mNum(sum(MKT.ctxClicks)), mNum(pur), pur?mNum(ctxC/pur):'—']);
  document.getElementById('mktGis').innerHTML = mTbl(
    ['Месяц','Переходов на карточку','Действий на странице'],
    idx.map(function(i){ return [MKT.months[i], mNum(MKT.gis[i]), mNum(MKT.gisAct[i])]; }),
    ['Итого', mNum(sum(MKT.gis)), mNum(sum(MKT.gisAct))]);
  document.getElementById('mktSweet').innerHTML = mTbl(
    ['Месяц','Выполнений','Активных карт','Баллов'],
    idx.map(function(i){ return [MKT.months[i], mNum(MKT.sweet[i]), mNum(MKT.sweetCards[i]), mNum(MKT.sweetPts[i])]; }),
    ['Итого', mNum(sum(MKT.sweet)), '—', mNum(sum(MKT.sweetPts))]);
  var wCard = chq ? idx.reduce(function(s,i){return s+MKT.cardPct[i]*MKT.cheques[i];},0)/chq : 0;
  document.getElementById('mktSales').innerHTML = mTbl(
    ['Месяц','Выручка, ₽','Чеков','Ср. чек, ₽','Карта лоял.','Бонусами, ₽'],
    idx.map(function(i){ return [MKT.months[i], mNum(MKT.revenue[i]), mNum(MKT.cheques[i]), mNum(MKT.revenue[i]/MKT.cheques[i]), mNum1(MKT.cardPct[i])+' %', mNum(MKT.bonus[i])]; }),
    ['Итого', mNum(rev), mNum(chq), mNum(rev/chq), mNum1(wCard)+' %', mNum(sum(MKT.bonus))]);
  var lbls=idx.map(function(i){return MKT.months[i].slice(0,3);});
  mBars('mktChartRev', lbls, idx.map(function(i){return MKT.revenue[i];}), 'var(--accent)', ' ₽');
  mGroup('mktChartSpend', lbls, idx.map(function(i){return MKT.smsCost[i];}), idx.map(function(i){return MKT.ctxCost[i];}), '#b8860b', 'var(--accent)');
  var lg=document.getElementById('mktChartLegend'); if(lg) lg.innerHTML='<span class="mkt-lg"><i style="background:#b8860b"></i>SMS</span><span class="mkt-lg"><i style="background:var(--accent)"></i>Контекст</span>';
  mBars('mktChartPurch', lbls, idx.map(function(i){return MKT.ctxPurch[i];}), 'var(--accent)', ' шт');
  mBars('mktChartGis', lbls, idx.map(function(i){return MKT.gis[i];}), '#b8860b', '');
}
function mktCsvN(n, dec){ return dec ? (Math.round(n*100)/100).toFixed(2).replace('.',',') : String(Math.round(n)); }
function mktExport(){
  var fromEl=document.getElementById('mktFrom'), toEl=document.getElementById('mktTo');
  if(!fromEl||!toEl) return;
  var a=+fromEl.value,b=+toEl.value,lo=Math.min(a,b),hi=Math.max(a,b),idx=[];
  for(var i=lo;i<=hi;i++) idx.push(i);
  function sum(arr){ return idx.reduce(function(s,i){return s+arr[i];},0); }
  var L=[], push=function(arr){ L.push(arr.map(function(v){return String(v).replace(/;/g,',');}).join(';')); }, nm=function(i){return MKT.months[i].replace('*','');};
  push(['Маркетинг «Мария» — '+nm(lo)+'–'+nm(hi)+' 2026']); L.push('');
  push(['Показатель','Значение']);
  push(['Выручка, руб', mktCsvN(sum(MKT.revenue))]);
  push(['Платный маркетинг (SMS+контекст), руб', mktCsvN(sum(MKT.smsCost)+sum(MKT.ctxCost))]);
  push(['SMS отправлено', mktCsvN(sum(MKT.smsSent))]);
  push(['Покупок с рекламы', mktCsvN(sum(MKT.ctxPurch))]); L.push('');
  push(['SMS-рассылки']); push(['Месяц','Рассылок','Отправлено','Стоимость руб','Цена SMS руб']);
  idx.forEach(function(i){ push([nm(i), MKT.smsCnt[i], MKT.smsSent[i], MKT.smsCost[i], mktCsvN(MKT.smsCost[i]/MKT.smsSent[i],1)]); });
  push(['Итого', sum(MKT.smsCnt), sum(MKT.smsSent), sum(MKT.smsCost), mktCsvN(sum(MKT.smsCost)/sum(MKT.smsSent),1)]); L.push('');
  push(['Контекст (Яндекс.Директ)']); push(['Месяц','Расход руб','Клики','Покупок','CPA руб']);
  idx.forEach(function(i){ push([nm(i), MKT.ctxCost[i], MKT.ctxClicks[i], MKT.ctxPurch[i], MKT.ctxPurch[i]?mktCsvN(MKT.ctxCost[i]/MKT.ctxPurch[i]):'']); });
  var pur=sum(MKT.ctxPurch); push(['Итого', sum(MKT.ctxCost), sum(MKT.ctxClicks), pur, pur?mktCsvN(sum(MKT.ctxCost)/pur):'']); L.push('');
  push(['2ГИС']); push(['Месяц','Переходов на карточку','Действий']);
  idx.forEach(function(i){ push([nm(i), MKT.gis[i], MKT.gisAct[i]]); });
  push(['Итого', sum(MKT.gis), sum(MKT.gisAct)]); L.push('');
  push(['Сладкий чек']); push(['Месяц','Выполнений','Активных карт','Баллов']);
  idx.forEach(function(i){ push([nm(i), MKT.sweet[i], MKT.sweetCards[i], MKT.sweetPts[i]]); });
  push(['Итого', sum(MKT.sweet), '', sum(MKT.sweetPts)]); L.push('');
  push(['Продажи и лояльность']); push(['Месяц','Выручка руб','Чеков','Ср.чек руб','Карта лоял. %','Бонусами руб']);
  idx.forEach(function(i){ push([nm(i), MKT.revenue[i], MKT.cheques[i], mktCsvN(MKT.revenue[i]/MKT.cheques[i]), mktCsvN(MKT.cardPct[i],1), MKT.bonus[i]]); });
  var chq=sum(MKT.cheques), rev=sum(MKT.revenue); push(['Итого', rev, chq, mktCsvN(rev/chq), '', sum(MKT.bonus)]); L.push('');
  push(['SEO / источники трафика (за весь период янв–май)']); push(['Канал','Визиты','Доля %']);
  [['Переходы из поиска (SEO)',173894,'69,9'],['Прямые заходы',37516,'15,1'],['Переходы по рекламе',23685,'9,5'],['Переходы по ссылкам',7809,'3,1'],['Внутренние',3918,'1,6'],['Соцсети/рекоменд./мессенджеры',1886,'0,8'],['Всего',248708,'100']].forEach(push);
  var csv='﻿'+L.join('\n');
  var el=document.createElement('a');
  el.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  el.download='maria-marketing-2026-m'+(lo+1)+'-m'+(hi+1)+'.csv';
  el.click();
}
var COMPETITORS = [
  { name:'Мария', us:true, site:'maria-irk.ru', points:'~17–22 (Иркутск) + Ангарск',
    social:'IG @fabrika_maria ~32 тыс.; VK, Telegram, ОК', followers:'~32 тыс. (IG)', rating:'2ГИС ~4,4 (разброс 4,1–4,7)',
    loyalty:'«Любимый покупатель»: кэшбэк 5/7/10 %, оплата до 30 % бонусами, 600 приветств.; клуб «Мария для своих» (100к+); геймификация «Сладкий чек»',
    online:'да + ЛК', products:'торты (флагман «Зебра»), бенто от 690 ₽, пирожные, пироги, выпечка, кофе, конфеты ручной работы',
    promos:'торт месяца −20 %, комбо кофе+круассан 349 ₽, розыгрыш «Сладкий чек» (iPhone 17/MacBook), 1000 бонусов за отзыв',
    strong:'лучшая на рынке программа лояльности (кэшбэк + клуб 100к+), сильное SEO/контент (~70 % трафика), TG Mini App',
    weak:'часть точек проседает по рейтингу (4,1–4,3); охват и подписчики меньше, чем у Стефании' },
  { name:'Стефания', site:'stefanycake.ru', points:'~31–39 (Иркутск, Ангарск, Шелехов, Усолье, Черемхово)',
    social:'IG @stefanycake ~45 тыс. (2233 поста); VK, ОК, Telegram, Viber', followers:'~45 тыс. (IG)', rating:'2ГИС 4,7 (~1412 оценок) — топ рынка',
    loyalty:'Накопительной программы публично НЕТ; «кофейная карта», −10 % на пироги от 5 кг',
    online:'да + ЛК', products:'торты, бенто, десерты, пироги, выпечка, мороженое, вареники, меню кафе',
    promos:'лотерея ДОБРОКАР (авто Jaecoo J7), «кофейная карта»',
    strong:'лидер по числу точек и подписчикам, узнаваемость, премиум-эстетика, стабильно высокий рейтинг',
    weak:'нет накопительной программы лояльности (отстаёт от «Марии»), акции разовые' },
  { name:'Этика', site:'etikacakes.ru', points:'~7 (Иркутск) + суб-бренд etika.bakery',
    social:'IG @etika.cakes ~22 тыс. + @etika.bakery ~5,4 тыс.', followers:'~27 тыс. (IG)', rating:'2ГИС 4,4 (~435); «Лучшая кондитерская 2023»',
    loyalty:'Программы баллов публично не найдено',
    online:'да', products:'торты на заказ от 2090 ₽, бенто от 1590 ₽, пирожные, макаронс, трайфлы, кофе',
    promos:'н/д', strong:'молодёжный кофейня-формат, эстетика, премия «Лучшая кондитерская 2023»',
    weak:'мало точек (~7), нет программы лояльности' },
  { name:'Cake Home', site:'cakehome.ru', points:'~20–24 (Иркутск, Ангарск, Шелехов, Хомутово)',
    social:'VK, Facebook* (счётчики н/д)', followers:'н/д', rating:'2ГИС 4,6 (~90)',
    loyalty:'Бонусная программа (детали н/д)',
    online:'да + ЛК + конструктор торта (кастомизация)', products:'торты (Медовик, Киевский), выпечка, пироги, макаронс, профитроли, зефир',
    promos:'н/д', strong:'единственный с конструктором торта, семейный крафт-образ, широкая сеть',
    weak:'мало отзывов (~90), слабое присутствие в соцсетях' },
  { name:'ЯХОНТ', site:'', points:'~16–18 (Иркутск) + Хомутово, Братск, Улан-Удэ (28+ регион)',
    social:'н/д', followers:'н/д', rating:'2ГИС нестабильно (2,8–4,7); жалобы на сроки',
    loyalty:'Не найдено',
    online:'да (партнёрство со «Сладким клубом» — фотопечать)', products:'торты (шоколадные/ягодные/детские/муссовые), макаронс, кейк-попсы, нарезка (Наполеон, Медовик), 675–1890 ₽/кг',
    promos:'н/д', strong:'широкая региональная сеть, массовое производство, без выходных',
    weak:'нестабильный рейтинг (до 2,8), жалобы на срыв сроков, нет лояльности' }
];
var COMP_INSIGHTS = [
  '<b>Лояльность — главное преимущество «Марии»:</b> единственный игрок с прозрачным многоуровневым кэшбэком (5/7/10 %, оплата до 30 % бонусами) + клуб на 100к+. У Стефании, Этики, ЯХОНТа накопительных программ публично нет — это конкурентный ров, его стоит активно продвигать.',
  '<b>Охват и рейтинг — отставание от Стефании:</b> у неё больше точек (~31–39 vs ~17–22), подписчиков (~45 vs ~32 тыс. IG) и стабильнее рейтинг 2ГИС (4,7 vs ~4,4, часть точек «Марии» 4,1–4,3). Приоритет — подтянуть слабые точки и работать с отзывами.',
  '<b>Конструктор торта — свободная ниша:</b> онлайн-конструктор есть только у Cake Home. «Мария» может занять её первой как точку дифференциации.',
  '<b>Позиционирование «посередине»:</b> Стефания — премиум, ЯХОНТ — эконом/масса. «Мария» с домашними рецептами и флагманом «Зебра» в выгодной середине, но без яркого премиум-образа — риск «застрять посередине».',
  '<b>Битва в VK/Telegram:</b> Instagram в РФ ограничен; публичных счётчиков VK/TG нет ни у кого — это зона, где «Мария» может обойти конкурентов с меньшими затратами.'
];
var REVIEWS = {
  'Мария': { rating:'2ГИС 4,4 (748) · Otzovik 2,0', pros:'вкус, оформление тортов, кофе, ранний режим (7:30)', cons:'БРАК (посторонние предметы в продукции!), нет реакции на жалобы, срывы заказов, цена/качество' },
  'Стефания': { rating:'2ГИС 4,8 (950) — топ рынка', pros:'свежесть, демократичные цены, персонал, выбор', cons:'волосы/грязь в кофемашине, менее пропитано, нехватка в час пик, сбои бонусов' },
  'Этика': { rating:'2ГИС 4,6 (1286)', pros:'вкус, интерьер с видом на Ангару, официанты', cons:'«цены космос», маленькие порции, медленный сервис, нет в наличии' },
  'Cake Home': { rating:'2ГИС 4,5 (335)', pros:'вкус, «лучший кофе в Иркутске», персонал, атмосфера', cons:'дорого/цены растут, суховато, неудобный вход и парковка, накладки с бронями' },
  'ЯХОНТ': { rating:'2ГИС 4,5 (141)', pros:'низкие цены, свежесть, ассортимент классики, скидки на ДР', cons:'СРЫВЫ ЗАКАЗОВ к дате (главное), кофе и сервис' }
};
function renderCompetitors(){
  var el=document.getElementById('mktComp'); if(!el) return;
  var cols=['Компания','Точки','Соцсети / подписчики','Рейтинг','Программа лояльности','Онлайн-заказ'];
  var th=cols.map(function(c){ return '<th>'+c+'</th>'; }).join('');
  var trs=COMPETITORS.map(function(c){
    return '<tr'+(c.us?' class="mkt-total"':'')+'><td>'+c.name+'</td><td>'+c.points+'</td><td>'+(c.followers&&c.followers!=='н/д'?c.followers:c.social)+'</td><td>'+(((REVIEWS[c.name]||{}).rating)||c.rating)+'</td><td>'+c.loyalty+'</td><td>'+c.online+'</td></tr>';
  }).join('');
  function r(k,v){ return v?'<dt>'+k+'</dt><dd>'+v+'</dd>':''; }
  var cards=COMPETITORS.map(function(c){
    return '<div class="mkt-comp-card'+(c.us?' mkt-comp-us':'')+'">'+
      '<div class="mkt-comp-h">'+c.name+(c.us?' <span class="mkt-badge">это мы</span>':'')+'</div>'+
      (c.site?'<div class="mkt-comp-site"><a href="https://'+c.site+'" target="_blank" rel="noopener">'+c.site+'</a></div>':'')+
      '<dl class="mkt-comp-dl">'+ r('Точки',c.points)+r('Продукция',c.products)+r('Акции/предложения',c.promos)+r('Соцсети',c.social)+r('Рейтинг',((REVIEWS[c.name]||{}).rating)||c.rating)+r('Хвалят (отзывы)',(REVIEWS[c.name]||{}).pros)+r('Ругают (отзывы)',(REVIEWS[c.name]||{}).cons)+
      (c.strong?'<dt class="ok">Сильные стороны</dt><dd>'+c.strong+'</dd>':'')+
      (c.weak?'<dt class="bad">Слабые стороны</dt><dd>'+c.weak+'</dd>':'')+ '</dl></div>';
  }).join('');
  var ins='<div class="mkt-comp-ins"><div class="mkt-chart-t">Ключевые выводы</div><ul>'+COMP_INSIGHTS.map(function(x){return '<li>'+x+'</li>';}).join('')+'</ul></div>';
  el.innerHTML='<div class="table-wrap"><table><thead><tr>'+th+'</tr></thead><tbody>'+trs+'</tbody></table></div><div class="mkt-comp-cards">'+cards+'</div>'+ins;
}
var SOCIAL = [
  { name:'Мария', us:true, tg:'3 920', tgReach:'~200–440', ig:'~32 000', igReels:'~3,8 тыс (0,6–10к)', vk:'н/д' },
  { name:'Стефания', tg:'73 871', tgReach:'~5 000–8 800', ig:'~45 000', igReels:'~15 тыс (7–25к)', vk:'н/д' },
  { name:'Cake Home', tg:'5 340', tgReach:'~700–1 100', ig:'~38 000', igReels:'~7,5 тыс (вир. до 107к)', vk:'н/д' },
  { name:'Этика', tg:'2 070', tgReach:'~650–1 230 (выс. ER)', ig:'~22 000', igReels:'~4,6 тыс', vk:'н/д' },
  { name:'ЯХОНТ', tg:'359', tgReach:'~80–390', ig:'н/д', igReels:'~0,6 тыс', vk:'н/д' }
];
function renderSocial(){
  var el=document.getElementById('mktSocial'); if(!el) return;
  var cols=['Компания','Telegram, подп.','TG охват, просм./пост','Instagram, подп.','IG Reels, просм./рилс','VK'];
  var th=cols.map(function(c,i){ return '<th'+(i?' class="num"':'')+'>'+c+'</th>'; }).join('');
  var trs=SOCIAL.map(function(s){ return '<tr'+(s.us?' class="mkt-total"':'')+'><td>'+s.name+'</td><td class="num">'+s.tg+'</td><td class="num">'+s.tgReach+'</td><td class="num">'+s.ig+'</td><td class="num">'+(s.igReels||'н/д')+'</td><td class="num">'+s.vk+'</td></tr>'; }).join('');
  el.innerHTML='<div class="table-wrap"><table><thead><tr>'+th+'</tr></thead><tbody>'+trs+'</tbody></table></div>'+
    '<div class="mkt-comp-ins" style="margin-top:12px"><b>Вывод по соцсетям:</b> по видео «Мария» отстаёт. <b>IG Reels</b>: ~3,8 тыс просм./рилс vs ~15 тыс у Стефании (×4) и ~7,5 тыс у Cake Home (с виральными до 107к); сопоставимо с Этикой, выше ЯХОНТа. <b>Telegram</b>: подписчиков ×19 и охвата поста ×15–20 меньше Стефании — самый недоиспользованный канал. Instagram-подписчики — паритет (3-е место, 32к). VK-охваты приватны (счётчик подписчиков под анти-ботом — снять вручную с залогиненного VK). Просмотры IG Reels — публичные (счётчик на рилсе), по 12 последним.</div>';
}
var TOP_PRODUCTS = [
  ['Торт Шоколадно-вишнёвый',3555711,2930],['Торт Три шоколада',3546145,1737],['Торт Банан-солёная карамель',2935843,1814],['Кофе Большой Капучино',2879729,11390],['Торт Зебра ср.',2808533,1902],['Торт Лавандовый',2464113,1770],['Торт Медовик малиновый',2446459,1776],['Торт Домашний с брусникой мини',2345314,1504],['Торт Молочная девочка',2290454,1716],['Торт Ореум',2138496,1563],['Торт Молочная девочка с клубникой',2087554,1283],['Торт Графские развалины ср',1999805,1524],['Торт Медовик ср',1962977,1568],['Торт Карамельная девочка',1891129,1305],['Торт Королевский',1835230,1335]
];
var CATEGORIES = [
  ['Торты целые',55135567],['Пирожные',21127701],['Стрит-фуд',8019151],['Кофе с собой',7989198],['Торты кусочки',7725087],['Выпечка сладкая',6913400],['Рулеты',6517416],['Пироги целые',5148008],['Блюда',4911741],['Пироги кусочки',1755024],['Кофе',1704047],['Хлеб',1631557],['Пироги заказные',1426635]
];
var PRICES = [
  ['Торт на заказ','1350–2320 ₽/шт','525–1350 ₽/кг','от 2090 ₽/кг','1690–2990 ₽/кг','640–1700 ₽/шт'],
  ['Бенто-торт','от 690 ₽','1000 ₽','от 1590 ₽','350–520 ₽','от 495 ₽'],
  ['Кусочек / пирожное','н/д','89–199 ₽','95–460 ₽','н/д','н/д'],
  ['Макаронс, ₽/шт','н/д','109 ₽','135 ₽','120 ₽','131 ₽'],
  ['Капучино','210–360 ₽','н/д','н/д','н/д','н/д']
];
function renderProducts(){
  var tp=document.getElementById('mktTopProd'), ct=document.getElementById('mktCats');
  if(tp){ tp.innerHTML='<table><thead><tr><th>Товар</th><th class="num">Выручка ₽</th><th class="num">Шт</th></tr></thead><tbody>'+
    TOP_PRODUCTS.map(function(r,i){ return '<tr><td>'+(i+1)+'. '+r[0]+'</td><td class="num">'+mNum(r[1])+'</td><td class="num">'+mNum(r[2])+'</td></tr>'; }).join('')+'</tbody></table>'; }
  if(ct){ var tot=CATEGORIES.reduce(function(s,r){return s+r[1];},0);
    ct.innerHTML='<table><thead><tr><th>Категория</th><th class="num">Выручка ₽</th><th class="num">Доля</th></tr></thead><tbody>'+
    CATEGORIES.map(function(r){ return '<tr><td>'+r[0]+'</td><td class="num">'+mNum(r[1])+'</td><td class="num">'+(r[1]/tot*100).toFixed(1).replace('.',',')+' %</td></tr>'; }).join('')+'</tbody></table>'; }
}
function renderPrices(){
  var el=document.getElementById('mktPrices'); if(!el) return;
  var head=['Позиция','Мария','Стефания','Этика','Cake Home','ЯХОНТ'];
  el.innerHTML='<div class="table-wrap"><table><thead><tr>'+head.map(function(h){return '<th>'+h+'</th>';}).join('')+'</tr></thead><tbody>'+
    PRICES.map(function(r){ return '<tr><td>'+r[0]+'</td><td class="mkt-priceus">'+r[1]+'</td><td>'+r[2]+'</td><td>'+r[3]+'</td><td>'+r[4]+'</td><td>'+r[5]+'</td></tr>'; }).join('')+'</tbody></table></div>'+
    '<div class="mkt-comp-ins" style="margin-top:12px"><b>Вывод по ценам:</b> «Мария» — в середине. Бенто от 690 ₽ — самый дешёвый старт на рынке (трафик-драйвер). Целые торты дороже эконом-сетей (Стефания от 525 ₽/кг, ЯХОНТ от 640 ₽/шт), но дешевле премиума (Этика от 2090 ₽/кг, Cake Home до 2990 ₽/кг). Кофе-меню — единственное публичное на рынке.</div>';
}
var _mktInited=false;
function mktInit(){
  var fromEl=document.getElementById('mktFrom'), toEl=document.getElementById('mktTo');
  if(!fromEl||!toEl) return;
  if(!_mktInited){
    var opts = MKT.months.map(function(m,i){ return '<option value="'+i+'">'+m.replace('*','')+'</option>'; }).join('');
    fromEl.innerHTML=opts; toEl.innerHTML=opts; fromEl.value='0'; toEl.value=String(MKT.months.length-1);
    fromEl.addEventListener('change', mktRender);
    toEl.addEventListener('change', mktRender);
    var eb=document.getElementById('mktExportBtn'); if(eb) eb.addEventListener('click', mktExport);
    renderCompetitors();
    renderSocial();
    renderProducts();
    renderPrices();
    var seo=document.getElementById('mktSeo');
    if(seo) seo.innerHTML = mTbl(
      ['Канал (янв–май)','Визиты','Доля'],
      [['Переходы из поиска (SEO)','173 894','69,9 %'],['Прямые заходы','37 516','15,1 %'],['Переходы по рекламе','23 685','9,5 %'],['Переходы по ссылкам','7 809','3,1 %'],['Внутренние','3 918','1,6 %'],['Соцсети / рекоменд. / мессенджеры','1 886','0,8 %']],
      ['Всего','248 708','100 %']);
    _mktInited=true;
  }
  mktRender();
}

