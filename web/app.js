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
  trendWindow: 12,
  // Пер-блочный выбор месяца: blockPeriods[key] = 'YYYY-MM' либо отсутствует
  // (тогда блок следует общему state.period). summaryCache — кэш summary по
  // периодам, чтобы не дёргать /api/dashboard/summary повторно.
  blockPeriods: {},
  summaryCache: new Map()
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
  // Ретраи на транзиентные сбои (5xx / сеть / таймаут) — бэкенд иногда таймаутит
  // на запросе к 1С/БД. Повторяем ТОЛЬКО идемпотентные GET/HEAD: мутации
  // (POST/PUT/DELETE) не повторяем, чтобы не было двойной записи. 4xx не ретраим.
  const method = (opts.method || 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'HEAD';
  const maxAttempts = idempotent ? 3 : 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers = { ...(opts.headers || {}) };
    if (state.sessionToken) headers['X-Session-Token'] = state.sessionToken;
    if (state.userToken) headers['X-User-Token'] = state.userToken;
    // credentials: 'same-origin' — отправляем httpOnly auth-cookies
    const o = { ...opts, headers, credentials: opts.credentials || 'same-origin' };
    // Жёсткий таймаут 90 сек чтобы fetch не висел вечно при сетевых заминках
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 90000);
    o.signal = ac.signal;
    try {
      const res = await fetch(path, o);
      if (res.ok) return await res.json();
      const b = await res.json().catch(() => ({ error: 'Ошибка запроса' }));
      const err = new Error(b.error || 'Ошибка запроса');
      err.status = res.status;
      err.retriable = idempotent && res.status >= 500; // транзиентные серверные
      throw err;
    } catch (e) {
      lastErr = (e.name === 'AbortError')
        ? Object.assign(new Error('Таймаут запроса (90 сек)'), { retriable: idempotent })
        : e;
      // сетевой сбой fetch (TypeError «Failed to fetch») не имеет .status
      if (lastErr.retriable === undefined) lastErr.retriable = idempotent && lastErr.status === undefined;
      if (!lastErr.retriable || attempt === maxAttempts) throw lastErr;
      console.warn(`[fetchJson] ${path} — попытка ${attempt}/${maxAttempts} не удалась (${lastErr.message}), повтор…`);
    } finally {
      clearTimeout(t);
    }
    await new Promise(r => setTimeout(r, attempt * 700)); // бэкофф 0.7с, 1.4с
  }
  throw lastErr || new Error('Ошибка запроса');
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
  const maxVal = Math.max(...pts.flatMap(p => [p.plan, p.fact, p.factPrevYear || 0]), 1);
  const xp = i => pad.l + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
  const yp = v => pad.t + ph - (v / maxVal) * ph;

  // YoY: линия факта того же месяца год назад. Разрывается там, где данных
  // за прошлый год нет (factPrevYear === null), чтобы не врать интерполяцией.
  let pyD = '', pyOpen = false, pyHasAny = false;
  pts.forEach((p, i) => {
    if (p.factPrevYear != null) {
      pyD += `${pyOpen ? 'L' : 'M'}${xp(i).toFixed(1)},${yp(p.factPrevYear).toFixed(1)} `;
      pyOpen = true; pyHasAny = true;
    } else {
      pyOpen = false;
    }
  });
  const pyDots = pyHasAny ? pts.map((p, i) => p.factPrevYear == null ? '' :
    `<circle cx="${xp(i).toFixed(1)}" cy="${yp(p.factPrevYear).toFixed(1)}" r="2.5" fill="#a855f7"><title>${bpMonthLabel(p.prevYearPeriod)}: ${fmtAxis(p.factPrevYear)}</title></circle>`).join('') : '';

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
    return `<circle cx="${xp(i).toFixed(1)}" cy="${yp(p.fact).toFixed(1)}" r="${dotR}" fill="${clr}" stroke="white" stroke-width="2"><title>${bpMonthLabel(p.period)}: факт ${fmtAxis(p.fact)} · ${p.completion}% плана</title></circle>
    <circle cx="${xp(i).toFixed(1)}" cy="${yp(p.plan).toFixed(1)}" r="2.5" fill="white" stroke="#9ca3af" stroke-width="1.5"><title>${bpMonthLabel(p.period)}: план ${fmtAxis(p.plan)}</title></circle>${pctLabel}`;
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
    ${pyHasAny ? `<path d="${pyD.trim()}" fill="none" stroke="#a855f7" stroke-width="2" stroke-dasharray="2,3" opacity="0.85"/>${pyDots}` : ''}
    <path d="${factD}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}${xlabels}
    <text x="${pad.l}" y="${H - 4}" fill="var(--hint)" font-size="10">─ ─ план</text>
    <text x="${pad.l + 54}" y="${H - 4}" fill="var(--accent)" font-size="10">─── факт</text>
    ${pyHasAny ? `<text x="${pad.l + 108}" y="${H - 4}" fill="#a855f7" font-size="10">··· факт пр. года</text>` : ''}
  </svg>`;
}

// ── AI-нарратив «Маша рассказывает» — приоритетная плашка над KPI ───────────
function renderAiNarrative(text) {
  const section = $('aiNarrativeSection');
  const textEl = $('aiNarrativeText');
  const toggle = $('aiNarrativeToggle');
  if (!section || !textEl) return;
  if (!text || !String(text).trim()) {
    section.classList.add('hidden');
    return;
  }
  textEl.innerHTML = escapeHtml(String(text)).replace(/\n/g, '<br>');
  section.classList.remove('hidden');
  // По умолчанию свёрнут (2 строки) — чтобы KPI были над сгибом («5 секунд»)
  section.classList.add('collapsed');
  if (toggle) {
    toggle.textContent = 'Развернуть';
    // кнопку показываем только если текст реально длиннее 2 строк
    requestAnimationFrame(() => {
      const overflowing = textEl.scrollHeight > textEl.clientHeight + 2;
      toggle.classList.toggle('hidden', !overflowing);
    });
    if (!toggle.dataset.wired) {
      toggle.dataset.wired = '1';
      toggle.addEventListener('click', () => {
        const collapsed = section.classList.toggle('collapsed');
        toggle.textContent = collapsed ? 'Развернуть' : 'Свернуть';
      });
    }
  }
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
    // Спокойная палитра: нейтральный серо-тёплый тинт по интенсивности (тема-агностично),
    // насыщенный цвет НЕ используем — сильный/слабый день помечены кольцом (зелёное/красное).
    const alpha = 0.05 + intensity * 0.40;
    const isWeekend = i >= 5;
    const isBest = best && best.i === i && v > 0;
    const isWorst = worst && worst.i === i && v > 0 && ranked.length > 1;
    const cls = `weekday-cell ${isWeekend ? 'weekend' : ''} ${isBest ? 'is-best' : ''} ${isWorst ? 'is-worst' : ''}`;
    const subline = v > 0 ? `${fmtMoneyShort(v)}/день` : '—';
    const days = countsByDow[i];
    return `<div class="${cls}" style="background: rgba(128, 120, 130, ${alpha.toFixed(2)})" title="${labels[i]}: ${days} ${days === 1 ? 'день' : 'дн.'}, медианная выручка ${formatMoney(v)} ₽">
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
    subEl.textContent = `тренды кондитерки и что внедрить — AI-обзор рынка на сегодня (не зависит от выбранного месяца) · ${ago}`;
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

// count-up: анимируем число внутри .kpi-value (0 → значение, easeOutCubic),
// сохраняя суффикс (М ₽ / % / ...) и группировку. Финал — точная исходная строка.
let _kpiAnimPeriod = null;
function animateKpiNumbers() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('#kpis .kpi-value').forEach(el => {
    const raw = el.textContent.trim();
    const m = raw.match(/^(-?[\d\s.,]+?)\s*([^\d]*)$/);
    if (!m) return;
    const numStr = m[1].replace(/\s/g, '').replace(',', '.');
    const target = parseFloat(numStr);
    if (!isFinite(target)) return;
    const suffix = m[2] ? ' ' + m[2] : '';
    const decimals = (numStr.split('.')[1] || '').length;
    const dur = 650, start = performance.now();
    const fmt = (v) => {
      const [int, dec] = v.toFixed(decimals).split('.');
      const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      return (dec ? grouped + '.' + dec : grouped) + suffix;
    };
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      if (p < 1) { el.textContent = fmt(target * eased); requestAnimationFrame(step); }
      else { el.textContent = raw; }
    };
    requestAnimationFrame(step);
  });
}

// Дописывает на карточку «Маржа» реальную маржу из 1С (за закрытый месяц).
// Асинхронно (не блокирует summary). Эндпоинт кэширован 6ч → дёшево.
function loadRealMarginBadge(period){
  if(!state.realMarginCache) state.realMarginCache={};
  var apply=function(d){
    if(!d || !d.costed || d.marginPct==null || state.period!==period) return;
    var sub=document.querySelector('#kpis [data-kpi-id="margin"] .kpi-sub');
    if(sub && sub.innerHTML.indexOf('из 1С')<0){
      sub.innerHTML += ' <span class="kpi-delta" title="Реальная маржа из 1С — себестоимость = материалы в производство (УчётЗатрат), за закрытый месяц. Совпадает с отчётом «Валовая прибыль».">· из 1С: '+mNum1(d.marginPct)+' %</span>';
    }
  };
  if(state.realMarginCache[period]){ apply(state.realMarginCache[period]); return; }
  fetchJson('/api/marketing/gross-profit?period='+period).then(function(d){
    if(d && !d.unavailable && !d.error){ state.realMarginCache[period]=d; apply(d); }
  }).catch(function(){});
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

  // Сравнение vs прошлый месяц. Для ТЕКУЩЕГО (неполного) месяца пропорционируем
  // прошлый месяц к доле пройденных дней — иначе в начале месяца всегда «−75%».
  const prev = summary.prevPeriod?.totals;
  const cmpFrac = (today.isCurrentMonth && f && f.totalDays > 0 && isNum(today.elapsedDaysFractional))
    ? Math.min(today.elapsedDaysFractional / f.totalDays, 1) : 1;
  const cmpProRated = cmpFrac < 1;
  const vsPrev = (key) => {
    if (!prev || !isNum(prev[key]) || prev[key] === 0) return '';
    const base = prev[key] * cmpFrac;
    if (base === 0) return '';
    const cur = summary.totals[key] || 0;
    const deltaPct = ((cur - base) / base) * 100;
    if (Math.abs(deltaPct) < 0.1) return '';
    const sign = deltaPct > 0 ? '↑' : '↓';
    const cls = deltaPct > 0 ? 'kpi-delta-up' : 'kpi-delta-down';
    const note = cmpProRated ? 'vs прошл.мес (к этому дню)' : 'vs прошл.мес';
    const title = cmpProRated ? ` title="Оценка: прошлый месяц × доля пройденных дней (${Math.round(cmpFrac*100)}%)"` : '';
    return ` <span class="kpi-delta ${cls}"${title}>${sign}${Math.abs(deltaPct).toFixed(0)}% ${note}</span>`;
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
    // yoyTodayFact теперь ОЦЕНКА: полный факт прошлого года, пропорционированный
    // по доле пройденных дней (sold_at ≠ дата продажи, точный срез по дню нельзя).
    const yr = (today.yoyTodayPeriod || '').slice(0, 4);
    const est = today.yoyTodayEstimated ? '≈' : '';
    const yearsTag = today.yoyTodayYearsBack > 1 ? ` (${today.yoyTodayYearsBack} года назад)` : '';
    const label = `${est} vs ${yr} к этому дню${yearsTag}`;
    factSub += ` · <span class="kpi-delta ${cls}" title="Оценка: полный факт ${yr} × доля пройденных дней месяца. Точный срез по дню недоступен (sold_at в БД = время выгрузки, не продажи).">${arrow}${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(0)}% ${label}</span>`;
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
    { id: 'margin', label: 'Маржа' + (summary.costEstimated ? ' (оценка)' : ''), value: moneyShort(summary.totals.margin),
      sub: (isNum(summary.totals.marginPct) ? `${summary.totals.marginPct}% от выр.${summary.costEstimated ? ' · оценка (cost подогнан под markup)' : ''}` : 'нет данных от 1С') + vsPrev('margin'),
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

  // count-up анимация цифр — только при первой отрисовке периода (не на 30с-рефреше)
  if (_kpiAnimPeriod !== state.period) { _kpiAnimPeriod = state.period; animateKpiNumbers(); }

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
function renderCmpCard(label, c, curFact) {
  if (!c?.hasData) {
    return `<div class="cmp-card neutral">
      <div class="cmp-period">${label}</div>
      <div class="empty-state" style="padding:8px 0">Нет данных за прошлый период.</div>
    </div>`;
  }
  const tone = c.factDelta >= 0 ? 'good' : 'bad';
  // Пропорциональное сравнение неполного месяца — помечаем «(к этому дню, ≈)».
  const proNote = c.proRated
    ? ` <span class="muted" title="Прошлый месяц взят пропорционально пройденной доле дней (${Math.round((c.elapsedFraction || 0) * 100)}%), иначе неполный месяц всегда показывает «провал».">· к этому дню ≈</span>`
    : '';
  const prevBarLbl = c.proRated ? `${c.previousPeriod} ≈` : c.previousPeriod;
  // Мини-бары «сейчас vs период сравнения» по факту выручки.
  let barsHtml = '';
  if (isNum(curFact)) {
    const prevFact = curFact - c.factDelta;
    const mx = Math.max(curFact, prevFact, 1);
    const wNow = (curFact / mx * 100).toFixed(1);
    const wPrev = (Math.max(prevFact, 0) / mx * 100).toFixed(1);
    barsHtml = `<div class="cmp-bars">
      <div class="cmp-bar-row"><span class="cmp-bar-lbl">сейчас</span><span class="cmp-bar-track"><span class="cmp-bar-fill now" style="width:${wNow}%"></span></span><span class="cmp-bar-val">${fmtMoneyShort(curFact)}</span></div>
      <div class="cmp-bar-row"><span class="cmp-bar-lbl">${prevBarLbl}</span><span class="cmp-bar-track"><span class="cmp-bar-fill prev" style="width:${wPrev}%"></span></span><span class="cmp-bar-val">${fmtMoneyShort(prevFact)}</span></div>
    </div>`;
  }
  return `<div class="cmp-card ${tone}">
    <div class="cmp-period">${label} (${c.previousPeriod})${proNote}</div>
    ${barsHtml}
    <div class="cmp-rows">
      <div class="cmp-row"><span>Факт</span><strong class="${c.factDelta >= 0 ? 'positive' : 'negative'}">${signed(c.factDelta, formatMoney)}</strong></div>
      <div class="cmp-row"><span>Изм. %</span><strong class="${c.factDelta >= 0 ? 'positive' : 'negative'}">${signed(c.factDeltaPercent, v => v.toFixed(1) + '%')}</strong></div>
      <div class="cmp-row"><span>Выполнение</span><strong class="${c.completionDelta >= 0 ? 'positive' : 'negative'}">${signed(c.completionDelta, v => v.toFixed(1) + ' п.п.')}</strong></div>
      <div class="cmp-row cmp-row-margin"><span>Маржа</span><strong class="${!isNum(c.marginDelta) ? '' : c.marginDelta >= 0 ? 'positive' : 'negative'}">${isNum(c.marginDelta) ? signed(c.marginDelta, formatMoney) : '—'}</strong></div>
      <div class="cmp-row"><span>Количество</span><strong class="${c.quantityDelta >= 0 ? 'positive' : 'negative'}">${signed(c.quantityDelta, formatNum)}</strong></div>
    </div>
  </div>`;
}

// ВАЖНО: называется renderDashComparison, а не renderComparison — ниже в файле
// есть второй function renderComparison() для таба аналитики (пишет в
// #comparisonTbl). Объявления функций хойстятся, и одноимённая затирала бы эту.
function renderDashComparison(summary) {
  const yoyLabel = summary.yoy?.yearsBack > 1
    ? `vs. тот же месяц ${summary.yoy.yearsBack} года назад`
    : 'vs. тот же месяц год назад';
  const curFact = summary.totals?.fact;
  $('comparisonPanel').innerHTML =
    renderCmpCard('vs. прошлый месяц', summary.comparison, curFact) +
    renderCmpCard(yoyLabel, summary.yoy, curFact);
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
          <div class="pct-track"><div class="pct-bar" style="width:${Math.min(s.percent, 140)}%"></div></div>
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
    const notes = (data.comments || [])
      .slice()
      .sort((a, b) => new Date(b.eventDate || b.createdAt || 0) - new Date(a.eventDate || a.createdAt || 0)) // новые сверху
      .slice(0, 20);
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
  const sorted = state.comments
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); // новые сверху
  el.innerHTML = sorted.map(c => `
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
  if (page && (page === 'dashboard' || page === 'analytics' || page === 'marketing')) {
    if (typeof switchPage === 'function') switchPage(page);
    // При восстановлении страницы «Аналитика» из URL грузим её данные —
    // switchPage только показывает контейнер, но не дёргает loadAnalytics.
    if (page === 'analytics' && !analyticsState.data && typeof loadAnalytics === 'function') loadAnalytics();
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

  // Дефолт «Краткий вид» везде (десктоп + мобайл) — приоритет «5 секунд».
  // Выбор пользователя персистится в localStorage и переопределяет дефолт.
  const stored = localStorage.getItem(MOBILE_KEY);
  const initial = stored === null ? true : stored === '1';
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
  // Гонка: если маркетинг-таб успел загрузиться ДО metadata (с фоллбэк-периодом),
  // а реальный период оказался другим — перезагружаем блоки маркетинга.
  if (state.period && typeof _mktLoadedPeriod !== 'undefined' && _mktLoadedPeriod && _mktLoadedPeriod !== state.period
      && typeof mktLoadYoY === 'function') mktLoadYoY();

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

// ════════════════════════════════════════════════════════════════════════
// ПЕР-БЛОЧНЫЙ ВЫБОР МЕСЯЦА (таб «Дашборд»)
// Каждый из этих блоков можно независимо переключить на другой месяц.
// Блок без override следует общему state.period. YoY-сравнение с прошлым
// годом рисуется внутри самих рендеров (тренд-линия, KPI-бейджи, бары).
// ════════════════════════════════════════════════════════════════════════

const DASH_BLOCKS = {
  kpi:        { render: (s) => renderKpis(s) },
  forecast:   { render: (s) => renderForecast(s) },
  comparison: { render: (s) => renderDashComparison(s) },
  trend:      { render: (s) => renderTrendChart(s) },
  stores:     { render: (s) => renderStores(s) }
};

const RU_MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function bpMonthLabel(period) {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return period || '—';
  const [y, m] = period.split('-').map(Number);
  return `${RU_MONTHS_SHORT[m - 1]} ${y}`;
}

// Эффективный период блока: его override либо общий период.
function bpEffective(key) {
  return state.blockPeriods[key] || state.period;
}

// Кэширующая загрузка summary за период (переиспользует существующий endpoint).
async function getSummaryForPeriod(period, { force = false } = {}) {
  if (!period) return null;
  if (!force && state.summaryCache.has(period)) return state.summaryCache.get(period);
  const summary = await fetchJson(`/api/dashboard/summary?period=${encodeURIComponent(period)}&trend_window=24`);
  state.summaryCache.set(period, summary);
  return summary;
}

// Рендер одного блока из summary за его эффективный период.
async function applyDashBlock(key) {
  const cfg = DASH_BLOCKS[key];
  if (!cfg) return;
  const period = bpEffective(key);
  try {
    const summary = (period === state.period && state.summary)
      ? state.summary
      : await getSummaryForPeriod(period);
    if (summary) cfg.render(summary);
  } catch (err) {
    console.error('applyDashBlock failed', key, err);
  }
  updateBlockControlUI(key);
}

// После полной загрузки общего summary — переналожить блоки с override.
async function reapplyBlockOverrides() {
  const keys = Object.keys(state.blockPeriods).filter(k => state.blockPeriods[k]);
  await Promise.all(keys.map(applyDashBlock));
}

function blockControlHtml(key) {
  const periods = window.__metaPeriods__ || [];
  const cur = bpEffective(key);
  const overridden = !!state.blockPeriods[key];
  const opts = periods.map(p => `<option value="${p}"${p === cur ? ' selected' : ''}>${bpMonthLabel(p)}</option>`).join('');
  return `<span class="bp-ctrl${overridden ? ' bp-active' : ''}">
    <svg class="bp-cal" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
    <select class="bp-select" data-bp-select="${key}" title="Месяц для этого блока">${opts}</select>
    <button class="bp-reset" data-bp-reset="${key}" title="Вернуть к общему периоду"${overridden ? '' : ' hidden'}>↺</button>
  </span>`;
}

function updateBlockControlUI(key) {
  const mount = document.querySelector(`.bp-mount[data-bp="${key}"]`);
  if (!mount) return;
  mount.innerHTML = blockControlHtml(key);
}

// Первичная отрисовка всех контролов (после того как известны периоды).
function injectBlockControls() {
  Object.keys(DASH_BLOCKS).forEach(updateBlockControlUI);
}

// Смена месяца для блока (или сброс period=null → следовать общему).
async function setBlockPeriod(key, period) {
  if (!period || period === state.period) {
    delete state.blockPeriods[key];
  } else {
    state.blockPeriods[key] = period;
  }
  await applyDashBlock(key);
}

// Делегированные обработчики контролов.
document.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-bp-select]');
  if (sel) setBlockPeriod(sel.dataset.bpSelect, sel.value);
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bp-reset]');
  if (btn) setBlockPeriod(btn.dataset.bpReset, null);
});

async function loadSummary() {
  if (!state.period) return;
  const summary = await fetchJson(`/api/dashboard/summary?period=${encodeURIComponent(state.period)}&trend_window=24`);
  state.summary = summary;
  state.summaryCache.set(state.period, summary);
  // Раньше автоматически выбирался первый магазин из списка — это разворачивало
  // огромный блок «По товарам» (8000+ пикселей) на главной для случайного
  // магазина. Теперь не выбираем — пользователь сам кликает на строку.

  applyMarginVisibility(summary);
  renderPlanHealth(summary);
  renderSummaryHero(summary);
  renderStickyMetrics(summary);
  renderKpis(summary);
  loadRealMarginBadge(state.period);
  renderForecast(summary);
  renderTrendChart(summary);
  renderWeekdayHeatmap(summary);
  renderDashComparison(summary);
  renderSpotlight(summary);
  renderStores(summary);
  renderProducts(summary);
  await loadStoreDetails();
  await loadComments();

  // Пер-блочные контролы месяца + переналожение блоков с override
  // (общий рендер выше затёр их DOM данными общего периода).
  injectBlockControls();
  await reapplyBlockOverrides();

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
// Мобильное меню-drawer: гамбургер открывает сайдбар, backdrop/Esc/выбор раздела — закрывают.
function initMobileNav(){
  var burger=document.getElementById('navHamburger');
  var sb=document.getElementById('sidebar');
  var bd=document.getElementById('navBackdrop');
  if(!burger||!sb||!bd) return;
  function close(){ sb.classList.remove('sidebar--open'); bd.classList.remove('show'); document.body.classList.remove('nav-open'); burger.setAttribute('aria-expanded','false'); }
  function open(){ sb.classList.add('sidebar--open'); bd.classList.add('show'); document.body.classList.add('nav-open'); burger.setAttribute('aria-expanded','true'); }
  burger.addEventListener('click', function(){ sb.classList.contains('sidebar--open') ? close() : open(); });
  bd.addEventListener('click', close);
  sb.querySelectorAll('.nav-btn,[data-page]').forEach(function(b){ b.addEventListener('click', close); });
  window.addEventListener('resize', function(){ if(window.innerWidth>640) close(); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') close(); });
}

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
  initChartZoom();
  initDashFx();
  initChartCrosshair();
  pageNavInit('dashNav','page-dashboard');
  initMobileNav();
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
    exportCsv(d.map(x => ({ 'Карта': x.name, 'Вид': x.kind || '', 'Выручка_месяц': x.monthly || 0, 'Чеков_месяц': x.monthlyFreq || 0, 'Выручка_6мес': x.monetary, 'Чеков_6мес': x.frequency, 'R': x.R, 'F': x.F, 'M': x.M })), `rfm-vip-${state.period}.csv`);
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

    // ВАЖНО: обработчик смены месяца вешаем СРАЗУ после заполнения дропдауна
    // (в loadMetadata), ДО тяжёлого await loadSummary(). Иначе при медленном
    // первом рендере (несколько секунд) выбор месяца в этом окне терялся —
    // обработчика ещё нет; дропдаун показывал новый месяц, а данные оставались
    // на текущем, и повторный выбор того же месяца уже не давал событие change.
    $('periodSelect').addEventListener('change', async e => {
      state.period = e.target.value;
      state.selectedStoreId = '';
      $('storeDetailTitle').textContent = 'Детализация точки';
      urlStateWrite();
      analyticsState.data = null;
      // Сначала обновляем ВИДИМУЮ страницу, чтобы реакция была мгновенной.
      // Скрытые страницы перегружаем в фоне (без await) — иначе на «Аналитике»
      // приходилось ждать ~20с полного ререндера скрытого Дашборда, и казалось,
      // что аналитика не реагирует на смену месяца.
      const page = analyticsState.currentPage;
      if (page === 'analytics') {
        await loadAnalytics();
        loadSummary(); loadInsights();
      } else if (page === 'marketing') {
        if (typeof mktLoadYoY === 'function') mktLoadYoY();
        loadSummary(); loadInsights();
      } else {
        await loadSummary();
        loadInsights();
      }
    });

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

    $('trendWindowBtns')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-tw]');
      if (!btn) return;
      state.trendWindow = Number(btn.dataset.tw);
      $('trendWindowBtns').querySelectorAll('[data-tw]').forEach(b => b.classList.toggle('btn-xs-active', b === btn));
      applyDashBlock('trend');
    });

    setInterval(loadSummary, 30000);
  } catch (err) {
    document.body.innerHTML = `
      <main style="padding:56px 24px;text-align:center;color:var(--ink,#e5e5e5);font-family:system-ui">
        <div style="font-size:40px;margin-bottom:12px">⚠️</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:6px">Не удалось загрузить данные</div>
        <div style="color:#dc2626;margin-bottom:22px">${err.message}</div>
        <button onclick="location.reload()" style="background:#c14456;color:#fff;border:none;padding:11px 24px;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer">Повторить</button>
      </main>`;
  }
}

// ════════════════════════════════════════════════════════════════════════
// АНАЛИТИКА ПРОДАЖ — переключатель страниц + отчёты
// ════════════════════════════════════════════════════════════════════════

const analyticsState = {
  currentPage: 'dashboard',
  currentTab: localStorage.getItem('maria_atab') || 'network',
  marketingGroup: localStorage.getItem('maria_mgroup') || 'overview',
  data: null,
  abcFilter: 'all',
  abcLimit: 50,
  range: { from: null, to: null }
};

// Под-табы маркетинга: группируют 17 секций в 5 групп (по data-mgroup).
// Зеркалит механику switchAnalyticsTab — секции не из активной группы прячем.
function initMarketingTabs() {
  document.querySelectorAll('#mktTabs .atab').forEach(btn => {
    btn.addEventListener('click', () => switchMarketingGroup(btn.dataset.mgroup));
  });
}
function switchMarketingGroup(group) {
  const groups = ['overview', 'channels', 'loyalty', 'products', 'competitors'];
  if (!groups.includes(group)) group = 'overview';
  analyticsState.marketingGroup = group;
  localStorage.setItem('maria_mgroup', group);
  document.querySelectorAll('#mktTabs .atab').forEach(b =>
    b.classList.toggle('atab-active', b.dataset.mgroup === group));
  document.querySelectorAll('#page-marketing section[data-mgroup]').forEach(s =>
    s.classList.toggle('hidden', s.dataset.mgroup !== group));
  // Закладки/пиннинг в видимых секциях (как в аналитике)
  document.querySelectorAll('#page-marketing section[data-mgroup]:not(.hidden)').forEach(s => {
    if (typeof enhancePinningInSection === 'function') enhancePinningInSection(s);
  });
}

function initPageNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const page = btn.dataset.page;
      if (!page) return; // ссылки-пункты (напр. «Производство» → /production.html) — штатная навигация
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
  const moves = Number(b.totalMovements) || 0;
  const movesStr = b.capped ? fmtNum(moves) + '+' : fmtNum(moves);
  const capHint = b.capped
    ? '<div style="font-size:11px;color:var(--muted)">выборка 1С ограничена 10 000 — число занижено</div>'
    : '';
  $('customersKpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Активных карт</div><div class="kpi-value">${fmtNum(Number(b.totalCards) || 0)}</div></div>
    <div class="kpi-card"><div class="kpi-label">Транзакций</div><div class="kpi-value">${movesStr}</div>${capHint}</div>
    <div class="kpi-card"><div class="kpi-label">Бонусов начислено</div><div class="kpi-value">${fmtNum(Number(b.totalSum) || 0)} ₽</div></div>
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
    const vipRows = (data.topVIP || []).map(v => `<tr><td>${escapeHtml(v.name)}${v.kind ? `<div style="font-size:10px;color:var(--muted)">${escapeHtml(v.kind)}</div>` : ''}</td><td class="num" title="за месяц ${formatMoney(v.monthly||0)} · за 6 мес ${formatMoney(v.monetary)}">${formatMoney(v.monthly||0)}</td><td class="num">${v.monthlyFreq||0}</td></tr>`).join('');
    const sleepingRows = (data.topSleeping || []).map(v => `<tr><td>${escapeHtml(v.name)}</td><td class="num">${formatMoney(v.monetary)}</td><td class="num">${v.recencyMonths} мес.</td></tr>`).join('');
    const exc = data.excluded || {};
    const excNote = (exc.wholesale || exc.internal)
      ? ` · исключены опт/корпоративные (${exc.wholesale || 0}) и служебные карты магазинов (${exc.internal || 0})`
      : '';
    el.innerHTML = `
      <div style="padding:8px 16px;font-size:13px">
        Розничных клиентов с покупками за 6 мес: <b>${data.total}</b><span class="muted" style="font-size:11px">${excNote}</span>
      </div>
      <div class="mk-segs">${segs}</div>
      <div class="mk-rfm-cols">
        <div class="mk-rfm-col">
          <div class="mk-rfm-col-title good">👑 Топ-20 клиентов за месяц <small class="muted">— по выручке за выбранный месяц (карты лояльности, без опта); кому предложить премиум/сервис</small></div>
          ${vipRows ? `<table class="num-table"><thead><tr><th>Карта клиента</th><th class="num">Выручка, мес</th><th class="num" title="Чеков ККМ за выбранный месяц">Чеков</th></tr></thead><tbody>${vipRows}</tbody></table>` : '<div class="muted" style="font-size:12px">пока нет</div>'}
        </div>
        <div class="mk-rfm-col">
          <div class="mk-rfm-col-title bad">💤 Топ-20 спящих <small class="muted">— реактивировать SMS/push с купоном</small></div>
          ${sleepingRows ? `<table class="num-table"><thead><tr><th>Карта клиента</th><th class="num">Сумма</th><th class="num">Recency</th></tr></thead><tbody>${sleepingRows}</tbody></table>` : '<div class="muted" style="font-size:12px">пока нет</div>'}
        </div>
      </div>
      <div class="mk-action-hint">💡 <b>Что делать:</b> VIP — персональные предложения и поздравления; Спящим — точечный push «вернёмся за подарком» с купоном на 1 неделю; Новых — onboarding (карта/бонусы).</div>
      <div style="font-size:11px;color:var(--muted);padding:0 16px 8px">Карточки-сегменты выше — RFM за 6 мес; таблица <b>«Топ клиентов» — по выручке за выбранный месяц</b> (по убыванию; наведи на сумму — покажет и 6-мес). Опт/корпоративные виды карт и служебные карты магазинов исключены${data.capped ? '; берётся топ-3000 карт' : ''}.</div>`;
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
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px">${escapeHtml(data.note || data.error || 'Нет данных')}</td></tr>`;
      return;
    }
    kpis.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Применений</div><div class="kpi-value">${fmtNum(data.totalApplications || 0)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Заказов / чеков</div><div class="kpi-value">${fmtNum(data.uniqueDocuments || 0)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Сумма скидок</div><div class="kpi-value">${fmtNum(data.totalDiscountSum || 0)} ₽</div></div>`;
    if (bslNote) bslNote.classList.add('hidden');
    tbody.innerHTML = (data.actions || []).map(r => `
      <tr>
        <td>${escapeHtml(r.action)}</td>
        <td class="num">${fmtNum(r.applications)}</td>
        <td class="num">${fmtNum(r.cheques)}</td>
        <td class="num">${fmtNum(r.discountSum)} ₽</td>
      </tr>`).join('') || `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px">За период скидок по акциям не найдено</td></tr>`;
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
  const d = analyticsState.data || {};
  const rows = d.byChannel || [];
  const retail = rows.filter(r => !r.nonRetail);
  const nonRetail = rows.filter(r => r.nonRetail);
  // Розничные строки — как было (с планом/маржой). Не-розничные (опт/сайт/агрегаторы)
  // отделяем подзаголовком: у них нет плана, а «Точек» — это число документов реализации.
  const rowHtml = (r, nr) => `
    <tr${nr ? ' style="color:var(--muted)"' : ''}>
      <td>${nr ? '↳ ' : '<b>'}${escapeHtml(CHANNEL_NAMES[r.source] || r.source)}${nr ? '' : '</b>'}</td>
      <td class="num">${nr ? '<span title="Документов реализации">' + fmtNum(r.storesCount) + ' док.</span>' : r.storesCount}</td>
      <td class="num">${nr ? '—' : fmtNum(r.plan)}</td>
      <td class="num"><b>${fmtNum(r.fact)}</b></td>
      <td class="num">${(!nr && r.completion) ? r.completion.toFixed(1) + '%' : '—'}</td>
      <td class="num">${nr ? '—' : fmtNum(r.cost)}</td>
      <td class="num">${(nr || r.margin === null) ? '—' : fmtNum(r.margin)}</td>
      <td class="num">${nr ? '—' : fmtPct(r.marginPct)}</td>
      <td class="num">${fmtNum(r.quantity)}</td>
    </tr>`;
  let html = retail.map(r => rowHtml(r, false)).join('');
  if (nonRetail.length) {
    const retailFact = retail.reduce((s, r) => s + (r.fact || 0), 0);
    const nrFact = (d.nonRetailTotal != null) ? d.nonRetailTotal : nonRetail.reduce((s, r) => s + (r.fact || 0), 0);
    html += `<tr><td colspan="9" style="background:var(--surface-2,rgba(0,0,0,.04));font-size:11px;color:var(--muted);padding:6px 8px">Сверх розницы — опт / сайт / агрегаторы (реализации 1С, своего плана нет)</td></tr>`;
    html += nonRetail.map(r => rowHtml(r, true)).join('');
    html += `<tr style="border-top:2px solid var(--line)"><td><b>Итого (розница + опт/сайт)</b></td><td></td><td></td><td class="num"><b>${fmtNum(retailFact + nrFact)}</b></td><td colspan="5"></td></tr>`;
  }
  tbody.innerHTML = html;
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
  sweet:[0,1,26,80,160],
  sweetCards:[0,1,2,35,56],
  sweetPts:[0,3,0,147,276]
};
function mNum(n){ return Math.round(n).toLocaleString('ru-RU'); }
function mNum1(n){ return (Math.round(n*10)/10).toLocaleString('ru-RU'); }
function mKpi(v,l){ return '<div class="mkt-kpi"><div class="mkt-v">'+v+'</div><div class="mkt-l">'+l+'</div></div>'; }
function mTbl(cols, rows, total){
  var th = cols.map(function(c,i){ return '<th'+(i?' class="num"':'')+'>'+c+'</th>'; }).join('');
  // Свежие месяцы — сверху (строки приходят по возрастанию; разворачиваем). Итог остаётся снизу.
  var body = rows.slice().reverse().map(function(r){ return '<tr>'+r.map(function(v,i){ return '<td'+(i?' class="num"':'')+'>'+v+'</td>'; }).join('')+'</tr>'; }).join('');
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
function mGroup(elId, labels, a, b, ca, cb, unit, nameA, nameB){
  var el=document.getElementById(elId); if(!el) return;
  // unit/nameA/nameB — для тултипов. Раньше тут были захардкожены «SMS: X ₽» /
  // «Контекст: X ₽» (наследие первого графика затрат) — и «Карта лояльности, %»
  // при наведении показывала проценты как рубли SMS.
  unit=unit||''; nameA=nameA||'факт'; nameB=nameB||'год назад';
  var w=Math.max(720, labels.length*60),h=230,padL=58,padR=14,padT=14,padB=32, iw=w-padL-padR, ih=h-padT-padB;
  var max=Math.max.apply(null, a.concat(b).concat([1])), step=iw/labels.length, bw=step*0.30;
  var grid=[0,.25,.5,.75,1].map(function(t){ var y=padT+ih*(1-t); return '<line x1="'+padL+'" y1="'+y+'" x2="'+(w-padR)+'" y2="'+y+'" stroke="currentColor" stroke-opacity="0.08"/><text x="'+(padL-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.5">'+mAxisFmt(max*t)+'</text>'; }).join('');
  var bars=labels.map(function(lb,i){ var x0=padL+step*i+(step-bw*2-4)/2, ha=a[i]/max*ih, hb=b[i]/max*ih; return '<g><rect x="'+x0.toFixed(1)+'" y="'+(padT+ih-ha).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(ha,0).toFixed(1)+'" rx="2" fill="'+ca+'" opacity="0.85"><title>'+lb+' '+nameA+': '+mNum(a[i])+unit+'</title></rect><rect x="'+(x0+bw+4).toFixed(1)+'" y="'+(padT+ih-hb).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(hb,0).toFixed(1)+'" rx="2" fill="'+cb+'" opacity="0.85"><title>'+lb+' '+nameB+': '+mNum(b[i])+unit+'</title></rect><text x="'+(x0+bw+2).toFixed(1)+'" y="'+(h-padB+14)+'" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.6">'+lb+'</text></g>'; }).join('');
  el.innerHTML='<svg viewBox="0 0 '+w+' '+h+'" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:230px">'+grid+bars+'</svg>';
}
function mktRender(){
  var fromEl=document.getElementById('mktFrom'), toEl=document.getElementById('mktTo');
  if(!fromEl||!toEl) return;
  var a=+fromEl.value, b=+toEl.value, lo=Math.min(a,b), hi=Math.max(a,b), idx=[];
  for(var i=lo;i<=hi;i++) idx.push(i);
  function sum(arr){ return idx.reduce(function(s,i){return s+arr[i];},0); }
  var rev=sum(MKT.revenue), smsC=sum(MKT.smsCost), ctxC=sum(MKT.ctxCost), smsS=sum(MKT.smsSent), pur=sum(MKT.ctxPurch), chq=sum(MKT.cheques);
  // SEO-бюджет: фикс 46 000 ₽/мес (агентство+контент+техничка), реальная цифра от Маши.
  var SEO_MONTHLY = 46000;
  var seoC = SEO_MONTHLY * idx.length;
  // Верхние KPI «Маркетинг по каналам» теперь живые (см. mktLoadYoY) и слушаются
  // глобального периода слева. Здесь больше не рисуем (статика янв–май убрана).
  // Статические таблицы янв–май (mktSms/mktCtx/mktGis/mktSweet/mktSales) убраны — заменены
  // на live: продажи помесячно рендерятся из d.monthlySeries (см. renderSalesMonthly в
  // mktLoadYoY); Директ/2ГИС/SMS/Сладкий чек — live-снимки в своих блоках (#mktDirectLive,
  // #mktGisLive, #mktSmsAttr, #mktSweetLive). Помесячной истории по этим каналам в 1С нет.
}
// Продажи и лояльность помесячно — live из monthlySeries (1С), без хардкода.
function renderSalesMonthly(d){
  var el=document.getElementById('mktSales'); if(!el) return;
  var ms=(d&&d.monthlySeries&&d.monthlySeries.cur)||[];
  ms=ms.filter(function(m){return !m._pending && m.revenue;});
  if(!ms.length){ el.innerHTML='<div style="font-size:12px;color:var(--muted)">Данные 1С прогреваются…</div>'; return; }
  var MM=['','Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  var rev=0,chq=0,bon=0,cardW=0;
  var selYM=mktSelectedPeriod();
  var hlRow=function(ym){ return ym===selYM?' style="background:rgba(124,92,255,.10);box-shadow:inset 3px 0 0 #7c5cff"':''; };
  var rows=ms.map(function(m){ rev+=m.revenue||0; chq+=m.cheques||0; bon+=m.bonus||0; cardW+=(m.cardPct||0)*(m.cheques||0);
    var p=m.ym.split('-'); var lbl=p[0].slice(2)+'-'+MM[Number(p[1])];
    return '<tr'+hlRow(m.ym)+'><td>'+lbl+'</td><td class="num">'+mNum(m.revenue)+'</td><td class="num">'+mNum(m.cheques)+'</td><td class="num">'+mNum(m.avgCheck||(m.cheques?m.revenue/m.cheques:0))+'</td><td class="num">'+mNum1(m.cardPct||0)+' %</td><td class="num">'+mNum(m.bonus||0)+'</td></tr>';
  }).reverse().join('');
  el.innerHTML='<table><thead><tr><th>Месяц</th><th class="num">Выручка, ₽</th><th class="num">Чеков</th><th class="num">Ср. чек, ₽</th><th class="num">Чеков с картой</th><th class="num">Бонусами, ₽</th></tr></thead><tbody>'+rows+
    '<tr class="mkt-total"><td>Итого '+ms.length+' мес</td><td class="num">'+mNum(rev)+'</td><td class="num">'+mNum(chq)+'</td><td class="num">'+mNum(chq?rev/chq:0)+'</td><td class="num">'+mNum1(chq?cardW/chq:0)+' %</td><td class="num">'+mNum(bon)+'</td></tr></tbody></table>'+
    '<div style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.5">'+
    '<b>Выручка</b> — фактически оплачено (СуммаДокумента 1С: за вычетом возвратов, оплаты бонусами и подарочными сертификатами). Совпадает с планом/фактом на главном дашборде.<br>'+
    '<b>Чеков с картой</b> — доля чеков, где просканирована бонусная карта. Это НЕ «Сладкий чек»: тот блок выше — отдельная геймификация (баллы за задания), и «активных карт» там — только участники заданий за месяц, а не все держатели карт.'+
    '</div>';
}
// Я.Директ помесячно — live-история из кабинета porg-mcw4s7ni (scrape-direct-history.js).
function renderDirectMonthly(d){
  var el=document.getElementById('mktCtxMonthly'); if(!el) return;
  var dh=d&&d.external&&d.external.directHistory;
  var ms=(dh&&dh.months||[]).filter(function(m){return m && m.spend;});
  if(!ms.length){ el.innerHTML='<div style="font-size:12px;color:var(--muted)">Помесячная история Директа собирается скрейпером кабинета.</div>'; return; }
  var MM=['','Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  var sp=0,im=0,cl=0,cv=0;
  var selYM=mktSelectedPeriod();
  var hlRow=function(ym){ return ym===selYM?' style="background:rgba(124,92,255,.10);box-shadow:inset 3px 0 0 #7c5cff"':''; };
  var rows=ms.map(function(m){ sp+=m.spend||0; im+=m.impressions||0; cl+=m.clicks||0; cv+=m.conversions||0;
    var p=m.ym.split('-'); var lbl=p[0].slice(2)+'-'+MM[Number(p[1])]+(m.daysCovered&&m.daysCovered<28?' (1–'+m.daysCovered+')':'');
    var cpaC=m.cpa==null?'color:var(--muted)':(m.cpa<=300?'color:#10a05a':(m.cpa<=800?'color:#b8860b':'color:#e0466a'));
    return '<tr'+hlRow(m.ym)+'><td>'+lbl+'</td><td class="num">'+mNum(m.spend)+'</td><td class="num">'+mNum(m.impressions)+'</td><td class="num">'+mNum(m.clicks)+'</td><td class="num">'+mNum1(m.ctrPct||0)+' %</td><td class="num">'+mNum(m.conversions)+'</td><td class="num">'+mNum1(m.crPct||0)+' %</td><td class="num">'+mNum1(m.cpc||0)+'</td><td class="num" style="'+cpaC+'">'+(m.cpa==null?'—':mNum(m.cpa))+'</td></tr>';
  }).reverse().join('');
  var tcpc=cl?Math.round(sp/cl*100)/100:0, tctr=im?Math.round(cl/im*1000)/10:0, tcpa=cv?Math.round(sp/cv):0, tcr=cl?Math.round(cv/cl*1000)/10:0;
  var st=dh.scrapedAt?new Date(dh.scrapedAt).toLocaleString('ru-RU'):'—';
  el.innerHTML='<div class="mkt-chart-t">Я.Директ помесячно <span class="mkt-scope dyn">live · кабинет</span></div>'+
    '<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Месяц</th><th class="num">Расход ₽</th><th class="num">Показы</th><th class="num">Клики</th><th class="num">CTR</th><th class="num">Конв.</th><th class="num">CR</th><th class="num">CPC ₽</th><th class="num">CPA ₽</th></tr></thead><tbody>'+rows+
    '<tr class="mkt-total"><td>Итого</td><td class="num">'+mNum(sp)+'</td><td class="num">'+mNum(im)+'</td><td class="num">'+mNum(cl)+'</td><td class="num">'+mNum1(tctr)+' %</td><td class="num">'+mNum(cv)+'</td><td class="num">'+mNum1(tcr)+' %</td><td class="num">'+mNum1(tcpc)+'</td><td class="num">'+mNum(tcpa)+'</td></tr>'+
    '</tbody></table></div>'+
    '<div style="font-size:11px;color:var(--muted);margin-top:6px">Источник — отчёт «Перформанс-кампании» в кабинете Директа, помесячно. Конверсии — цели Я.Метрики в кабинете. Обновлено: '+st+(dh.sessionExpired?' · ⚠️ сессия протухла':'')+'.</div>';
}
// 2ГИС «Присутствие в выдаче» помесячно — live из кабинета (scrape-2gis-monthly.js).
function renderGisMonthly(d){
  var el=document.getElementById('mktGis'); if(!el) return;
  var gh=d&&d.external&&d.external.gisHistory;
  var ms=(gh&&gh.series||[]).filter(function(m){return m && m.impressions;});
  if(!ms.length){ el.innerHTML='<div style="font-size:12px;color:var(--muted)">Помесячная история 2ГИС собирается скрейпером кабинета.</div>'; return; }
  var MM=['','Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  var imp=0,pv=0,sc=0,rt=0,cl=0,so=0,me=0,pr=0;
  var selYM=mktSelectedPeriod();
  var hlRow=function(ym){ return ym===selYM?' style="background:rgba(124,92,255,.10);box-shadow:inset 3px 0 0 #7c5cff"':''; };
  var nv=function(v){ return v==null?'—':mNum(v); };
  var rows=ms.map(function(m){ imp+=m.impressions||0; pv+=m.pageVisits||0; sc+=m.siteClicks||0; rt+=m.routes||0; cl+=m.calls||0; so+=m.socialClicks||0; me+=m.messengerClicks||0; pr+=m.priceViews||0;
    var p=m.ym.split('-'); var lbl=p[0].slice(2)+'-'+MM[Number(p[1])]+(m.partial?' <span style="font-size:10px;color:var(--muted)">(идёт)</span>':'');
    return '<tr'+hlRow(m.ym)+'><td>'+lbl+'</td><td class="num">'+mNum(m.impressions)+'</td><td class="num">'+(m.positionAvg==null?'—':mNum1(m.positionAvg))+'</td><td class="num">'+nv(m.pageVisits)+'</td><td class="num">'+nv(m.siteClicks)+'</td><td class="num">'+nv(m.routes)+'</td><td class="num">'+nv(m.calls)+'</td><td class="num">'+nv(m.socialClicks)+'</td><td class="num">'+nv(m.messengerClicks)+'</td><td class="num">'+nv(m.priceViews)+'</td></tr>';
  }).reverse().join('');
  var st=gh.scrapedAt?new Date(gh.scrapedAt).toLocaleString('ru-RU'):'—';
  el.innerHTML='<div class="mkt-chart-t">2ГИС помесячно — показы, позиция, переходы <span class="mkt-scope dyn">live · кабинет · 13 мес</span></div>'+
    '<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Месяц</th><th class="num" title="Показы карточки в поиске 2ГИС за календарный месяц">Показы</th><th class="num" title="Средняя позиция в выдаче за месяц">Позиция ср.</th><th class="num" title="Переходы на страницу компании в 2ГИС">Переходы на стр.</th><th class="num" title="Клики «перейти на сайт» с карточки">На сайт</th><th class="num" title="Построения маршрута до точки — намерение прийти">Маршруты</th><th class="num" title="Звонки и просмотры телефона">Звонки</th><th class="num" title="Клики по ссылкам соцсетей на карточке">Соцсети</th><th class="num" title="Клики по ссылкам мессенджеров">Мессендж.</th><th class="num" title="Просмотры блока цен на карточке">Цены</th></tr></thead><tbody>'+rows+
    '<tr class="mkt-total"><td>Итого</td><td class="num">'+mNum(imp)+'</td><td class="num"></td><td class="num">'+mNum(pv)+'</td><td class="num">'+mNum(sc)+'</td><td class="num">'+mNum(rt)+'</td><td class="num">'+mNum(cl)+'</td></tr>'+
    '</tbody></table></div>'+
    '<div style="font-size:11px;color:var(--muted);margin-top:6px">Календарные месяцы из кабинета 2ГИС («Присутствие в выдаче» + «Страница компании», пресет «Год», обновляется ежедневно). <b>Продаж 2ГИС не передаёт</b> (это справочник, не касса) — ближайшие к продаже сигналы: «Маршруты» (намерение прийти) и «На сайт». Обновлено: '+st+'.</div>';
}
// 2ГИС «Воронка действий» — показы → переходы на карточку → целевые действия (сайт+маршруты+звонки)
// за выбранный месяц (или последний завершённый). Данные: gisHistory.series.
function renderGisFunnel(d){
  var el=document.getElementById('mktGisFunnel'); if(!el) return;
  var gh=d&&d.external&&d.external.gisHistory;
  var ms=(gh&&gh.series||[]).filter(function(m){return m && m.impressions;});
  if(!ms.length){ el.innerHTML=''; return; }
  var MM=['','январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  var selYM=mktSelectedPeriod();
  var m=ms.filter(function(x){return x.ym===selYM;})[0]
      || ms.filter(function(x){return !x.partial;}).slice(-1)[0]
      || ms[ms.length-1];
  var imp=m.impressions||0, pv=m.pageVisits||0, site=m.siteClicks||0, rt=m.routes||0, calls=m.calls||0;
  var target=site+rt+calls;
  var pct=function(n,base){ return base?Math.round(n/base*1000)/10:null; };
  var mp=m.ym.split('-'); var mlbl=MM[Number(mp[1])]+' '+mp[0];
  var steps=[
    {l:'Показы в поиске 2ГИС', sub:'сколько раз карточку показали', n:imp, conv:null, color:'#7c5cff'},
    {l:'Переходы на карточку', sub:'открыли страницу компании', n:pv, conv:pct(pv,imp), color:'#5b8def'},
    {l:'Целевые действия', sub:'на сайт + маршруты + звонки', n:target, conv:pct(target,pv||imp), color:'#10a05a'}
  ];
  var rows=steps.map(function(s){
    var w=imp?Math.max(3,Math.round(s.n/imp*100)):0;
    return '<div style="margin:6px 0">'+
      '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span><b>'+s.l+'</b> <span style="color:var(--muted)">— '+s.sub+'</span></span>'+
        '<span><b>'+mNum(s.n)+'</b>'+(s.conv!=null?' <span style="color:var(--muted)">('+mNum1(s.conv)+'% от пред.)</span>':'')+'</span></div>'+
      '<div style="background:var(--surface-2,rgba(0,0,0,.06));border-radius:6px;height:18px;overflow:hidden"><div style="width:'+w+'%;height:100%;background:'+s.color+';border-radius:6px"></div></div>'+
    '</div>';
  }).join('');
  el.innerHTML='<div class="mkt-chart-t">Воронка действий 2ГИС · '+mlbl+(m.partial?' (идёт)':'')+'</div>'+rows+
    '<div style="font-size:11px;color:var(--muted);margin-top:6px">Из показов в выдаче в целевые действия (переход на сайт, построение маршрута, звонок) — '+(pct(target,imp)!=null?mNum1(pct(target,imp))+'%':'н/д')+'. Разбивка целевых: на сайт '+mNum(site)+' · маршруты '+mNum(rt)+' · звонки '+mNum(calls)+'. «Маршруты» — самый близкий к визиту сигнал.</div>';
}
// 2ГИС динамика по месяцам — графики показов и переходов (gisHistory.series).
function renderGisCharts(d){
  var el=document.getElementById('mktGisCharts'); if(!el) return;
  var gh=d&&d.external&&d.external.gisHistory;
  var ms=(gh&&gh.series||[]).filter(function(m){return m && m.impressions;});
  if(ms.length<2){ el.innerHTML=''; return; }
  var MM=['','Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  var labels=ms.map(function(m){var p=m.ym.split('-');return p[0].slice(2)+'-'+MM[Number(p[1])];});
  var imp=ms.map(function(m){return m.impressions||0;});
  var site=ms.map(function(m){return m.siteClicks||0;});
  var rt=ms.map(function(m){return m.routes||0;});
  el.innerHTML='<div class="mkt-chart-t">Показы в 2ГИС по месяцам</div><div id="mktGisChImp"></div>'+
    '<div class="mkt-chart-t" style="margin-top:14px">Переходы на сайт и маршруты по месяцам</div><div id="mktGisChTr"></div>';
  try{ mBars('mktGisChImp', labels, imp, '#7c5cff', ''); }catch(_){}
  try{ mGroup('mktGisChTr', labels, site, rt, '#10a05a', '#5b8def', '', 'На сайт', 'Маршруты'); }catch(_){}
}
// Платные каналы — затраты и отдача (бюджет маркетинга) из /api/marketing/paid-costs.
function renderPaidCosts(pc){
  var el=document.getElementById('mktPaidLive'); if(!el) return;
  if(!pc || pc.error){ el.innerHTML='<div style="font-size:12px;color:var(--muted)">Нет данных по затратам: '+((pc&&pc.error)||'ошибка')+'</div>'; return; }
  var ch=pc.channels||[];
  var kpi=function(v,l){ return '<div class="mkt-kpi"><div class="mkt-v">'+v+'</div><div class="mkt-l">'+l+'</div></div>'; };
  var share=function(c){ return pc.totalMonthly?Math.round(c/pc.totalMonthly*100):0; };
  // Самый дорогой канал — считаем, а не хардкодим: «контекст» был зашит, хотя
  // реально крупнейший — SMS (тот же класс косяка, что тултип «SMS: X ₽» в mGroup).
  var topCh=ch.slice().sort(function(a,b){ return (b.cost||0)-(a.cost||0); })[0]||{};
  var html='<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:10px">'+
    kpi('<b>'+mNum(pc.totalMonthly)+' ₽</b>','Платный маркетинг / мес (итого)')+
    kpi(mNum(ch.length),'Каналов')+
    kpi(mNum(topCh.cost||0)+' ₽','Самый дорогой: '+(topCh.name||'—'))+
    '</div>'+
    '<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Канал</th><th class="num">Затраты/мес ₽</th><th class="num">Доля</th><th>Что даёт</th><th>Стоимость результата</th></tr></thead><tbody>'+
    ch.map(function(c){
      var liveBadge = c.live ? '' : ' <span style="font-size:10px;color:var(--muted)">фикс</span>';
      var res = c.live ? c.result : '<span style="color:var(--muted)">'+c.result+'</span>';
      return '<tr><td><b>'+c.name+'</b>'+liveBadge+'<div style="font-size:10px;color:var(--muted)">'+(c.costNote||'')+'</div></td>'+
        '<td class="num">'+mNum(c.cost)+'</td>'+
        '<td class="num">'+share(c.cost)+' %</td>'+
        '<td style="font-size:11px">'+res+'</td>'+
        '<td style="font-size:11px">'+(c.cpr||'<span style="color:var(--muted)">—</span>')+'</td></tr>';
    }).join('')+
    '<tr class="mkt-total"><td><b>Итого / мес</b></td><td class="num"><b>'+mNum(pc.totalMonthly)+'</b></td><td class="num">100 %</td><td colspan="2"></td></tr>'+
    '</tbody></table></div>';
  if(pc.note) html+='<div style="font-size:11px;color:var(--muted);margin-top:8px">'+pc.note+'</div>';
  el.innerHTML=html;
}
// SMS-атрибуция: по каждой маркетинговой рассылке, привязка к офферу (продукт+срок).
function renderSmsAttribution(sa){
  var el=document.getElementById('mktSmsAttr'); if(!el) return;
  if(!sa || sa.error){ el.innerHTML='<div style="font-size:12px;color:var(--muted)">Нет данных атрибуции: '+((sa&&sa.error)||'ошибка')+'</div>'; return; }
  var convColor=function(p){ return p>=10?'#10a05a':(p>=3?'#b8860b':'#e0466a'); };
  var esc=function(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
  var typeBadge={
    'A':'<span style="font-size:10px;background:#eafaf0;color:#0a6b3a;padding:1px 6px;border-radius:3px">продукт+срок</span>',
    'A*':'<span style="font-size:10px;background:#fff8e6;color:#8b6a14;padding:1px 6px;border-radius:3px">всё+срок</span>',
    'B':'<span style="font-size:10px;background:#eef1ff;color:#3a4ba0;padding:1px 6px;border-radius:3px">ссылка</span>',
    'C':'<span style="font-size:10px;background:#f0f0f0;color:#777;padding:1px 6px;border-radius:3px">оценка</span>'
  };
  var camps=sa.campaigns||[];
  var html='';
  if(sa.caveat) html+='<div class="mkt-comp-ins" style="margin-bottom:10px;font-size:12px;background:#fff8e6;border:1px solid #f0d27a;color:#8b6a14;padding:8px 10px;border-radius:6px">'+sa.caveat+'</div>';
  if(camps.length){
    var t=sa.totals||{};
    html+='<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Рассылка (дата · текст)</th><th>Оффер</th><th class="num">Получателей</th><th class="num">Купили / перешли</th><th class="num">Конверсия</th><th class="num">Выручка ₽</th><th class="num">Затраты ₽</th></tr></thead><tbody>'+
      camps.map(function(c){
        var head='<div><b style="white-space:nowrap">'+(c.firstDate||'')+'</b>'+(c.endDate?' <span style="color:var(--muted);font-size:10px">→ до '+c.endDate+'</span>':'')+'</div>'+
          '<div style="font-size:11px;max-width:340px">'+(c.text?esc(c.text):'')+'</div>';
        var offer=(typeBadge[c.type]||c.type||'')+'<div style="font-size:10px;color:var(--muted);margin-top:2px">'+(c.product||'')+'</div>';
        var sweet = (c.sweetReg!=null) ? '<div style="font-size:10px;color:#0a6b3a">🍰 +'+mNum(c.sweetReg)+' рег. в «Сладком чеке»</div>' : '';
        var sentCell='<td class="num">'+mNum(c.recipients)+'</td>';
        var costCell='<td class="num">'+mNum(c.cost)+'</td>';
        if(c.error) return '<tr><td>'+head+'</td><td>'+offer+'</td>'+sentCell+'<td class="num" colspan="3" style="color:var(--muted);text-align:left">ошибка: '+esc(c.error.slice(0,40))+'</td>'+costCell+'</tr>';
        if(c.linkPending) return '<tr><td>'+head+'</td><td>'+offer+'</td>'+sentCell+'<td colspan="3" style="font-size:11px;color:var(--muted)">переходы — пока нет данных Метрики'+(sweet?' · '+sweet:'')+'</td>'+costCell+'</tr>';
        var cc=convColor(c.conversionPct);
        var liftLine = (c.liftPct!=null) ? '<div style="font-size:10px;color:'+(c.liftPct>0?'#10a05a':'#e0466a')+'">прирост '+(c.liftPct>0?'+':'')+mNum1(c.liftPct)+' п.п.'+(c.incremental?' · ≈'+mNum(c.incremental)+' доп.':'')+'</div>' : '';
        return '<tr><td>'+head+'</td><td>'+offer+'</td>'+sentCell+
          '<td class="num">'+mNum(c.buyers)+'<div style="font-size:10px;color:var(--muted)">'+(c.metric||'')+'</div>'+sweet+'</td>'+
          '<td class="num" style="color:'+cc+'">'+mNum1(c.conversionPct)+' %'+liftLine+'</td>'+
          '<td class="num">'+(c.revenue==null?'<span style="color:var(--muted)">—</span>':mNum(c.revenue))+'</td>'+costCell+'</tr>';
      }).join('')+
      '<tr class="mkt-total"><td><b>Итого</b></td><td></td>'+
        '<td class="num"><b>'+mNum(t.recipients||0)+'</b></td>'+
        '<td class="num"><b>'+mNum(t.buyers||0)+'</b>'+(t.sweetReg?'<div style="font-size:10px;color:#0a6b3a">🍰 +'+mNum(t.sweetReg)+' рег.</div>':'')+'</td>'+
        '<td class="num">'+mNum1(t.conversionPct||0)+' %'+(t.incremental?'<div style="font-size:10px;color:#10a05a">≈'+mNum(t.incremental)+' доп.</div>':'')+'</td>'+
        '<td class="num"><b>'+mNum(t.revenue||0)+'</b></td>'+
        '<td class="num"><b>'+mNum(t.cost||0)+'</b></td></tr>'+
      '</tbody></table></div>';
  } else {
    html+='<div style="font-size:12px;color:var(--muted)">Маркетинговых рассылок («Реклама»/«Акция») за период не найдено.</div>';
  }
  if(sa.methodNote) html+='<div style="font-size:11px;color:var(--muted);margin-top:8px">'+sa.methodNote+'</div>';
  el.innerHTML=html;
}
// SMS помесячно — итоги по месяцам (из тех же getSmsAttribution.totals, консистентно).
function renderSmsMonthly(sm){
  var el=document.getElementById('mktSmsMonthly'); if(!el) return;
  if(!sm || !sm.months){ el.innerHTML=''; return; }
  var MM=['','Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  var ready=sm.months.filter(function(m){return !m._pending;});
  if(!ready.length){ el.innerHTML='<div style="font-size:12px;color:var(--muted)">Помесячные итоги SMS прогреваются из 1С (~10 сек/мес). Обнови страницу через минуту.</div>'; return; }
  var rec=0,cost=0,buy=0,rev=0;
  var selYM=mktSelectedPeriod();
  var hlRow=function(ym){ return ym===selYM?' style="background:rgba(124,92,255,.10);box-shadow:inset 3px 0 0 #7c5cff"':''; };
  var rows=sm.months.map(function(m){
    var p=m.ym.split('-'); var lbl=p[0].slice(2)+'-'+MM[Number(p[1])];
    if(m._pending) return '<tr><td>'+lbl+'</td><td class="num" colspan="6" style="color:var(--muted);text-align:left">прогрев…</td></tr>';
    rec+=m.recipients||0; cost+=m.cost||0; buy+=m.buyers||0; rev+=m.revenue||0;
    var cc=m.conversionPct>=10?'#10a05a':(m.conversionPct>=3?'#b8860b':'#e0466a');
    return '<tr'+hlRow(m.ym)+'><td>'+lbl+'</td><td class="num">'+mNum(m.campaigns)+'</td><td class="num">'+mNum(m.recipients)+'</td><td class="num">'+mNum(m.cost)+'</td><td class="num">'+mNum(m.buyers)+'</td><td class="num">'+(m.revenue?mNum(m.revenue):'—')+'</td><td class="num" style="color:'+cc+'">'+mNum1(m.conversionPct||0)+' %</td></tr>';
  }).reverse().join('');
  var tconv=rec?Math.round(buy/rec*1000)/10:0;
  el.innerHTML='<table style="font-size:12px"><thead><tr><th>Месяц</th><th class="num">Рассылок</th><th class="num">Получателей</th><th class="num">Затраты ₽</th><th class="num">Купили/перешли</th><th class="num">Выручка ₽</th><th class="num">Конверсия</th></tr></thead><tbody>'+rows+
    '<tr class="mkt-total"><td>Итого</td><td class="num">—</td><td class="num">'+mNum(rec)+'</td><td class="num">'+mNum(cost)+'</td><td class="num">'+mNum(buy)+'</td><td class="num">'+mNum(rev)+'</td><td class="num">'+mNum1(tconv)+' %</td></tr>'+
    '</tbody></table>'+
    (sm.monthsPending?'<div style="font-size:11px;color:var(--muted);margin-top:4px">'+sm.monthsPending+' мес. ещё прогреваются (тяжёлый расчёт атрибуции). Обнови позже.</div>':'');
}
// Валовая прибыль из 1С — реальная себестоимость (материалы в производство).
function renderGpTrend(trend){
  var c=document.getElementById('mktGrossProfitChart'); if(!c) return;
  var pts=(trend||[]).filter(function(x){ return x.costed && x.marginPct!=null; });
  if(!pts.length){ c.innerHTML='<div style="font-size:12px;color:var(--muted);padding:6px">Нет закрытых месяцев с рассчитанной себестоимостью.</div>'; return; }
  mBars('mktGrossProfitChart',
    pts.map(function(x){ var p=x.ym.split('-'); return p[0].slice(2)+'-'+p[1]; }),
    pts.map(function(x){ return x.marginPct; }), 'var(--accent)', ' %');
}
function renderGrossProfit(d){
  var el=document.getElementById('mktGrossProfit'); if(!el) return;
  if(d && d.unavailable){ el.innerHTML='<div class="mkt-yoy-load">'+(d.reason||'1С временно недоступна')+' — попробуйте позже.</div>'; return; }
  if(!d || d.error){ el.innerHTML='<div style="font-size:12px;color:var(--muted)">Недоступно: '+((d&&d.error)||'ошибка')+'</div>'; return; }
  var rub=function(n){ return mNum(n)+' ₽'; };
  // Тренд маржи по месяцам (закрытые) — рисуем всегда, даже если текущий месяц не рассчитан.
  try{ renderGpTrend(d.trend); }catch(_){}
  // Текущий/незакрытый месяц: себестоимость в 1С ещё не рассчитана → показываем оценку.
  if(d.costed===false){
    var estM=(state.summary && state.summary.totals && isNum(state.summary.totals.marginPct)) ? mNum1(state.summary.totals.marginPct)+' %' : '—';
    el.innerHTML='<div style="font-size:13px;color:var(--muted,#64748b);padding:6px;line-height:1.5">'+
      '📅 Себестоимость за этот месяц ещё не рассчитана в 1С (производство не закрыто) — реальная валовая прибыль появится после <b>закрытия месяца</b>.<br>'+
      'Пока — оценка по наценке: <b>'+estM+'</b> (выручка '+rub(d.revenue)+'). Реальные цифры — по закрытым месяцам ниже и при выборе прошлого месяца.</div>';
    return;
  }
  var kpi=function(v,l,sub){ return '<div class="mkt-kpi"><div class="mkt-v">'+v+'</div><div class="mkt-l">'+l+'</div>'+(sub?'<div class="mkt-yoy-p" style="margin-top:2px">'+sub+'</div>':'')+'</div>'; };
  var est=(state.summary && state.summary.totals && isNum(state.summary.totals.marginPct)) ? state.summary.totals.marginPct : null;
  var estLine=est!=null ? 'оценка по наценке: '+mNum1(est)+' %' : '';
  el.innerHTML='<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">'+
    kpi(rub(d.revenue),'Выручка')+
    kpi(rub(d.cogs),'Себестоимость','материалы в произв.')+
    kpi(rub(d.grossProfit),'Валовая прибыль')+
    kpi((d.marginPct!=null?mNum1(d.marginPct)+' %':'—'),'Маржа',estLine)+
    '</div>'+
    '<div style="font-size:11px;color:var(--muted,#64748b);margin-top:8px">Источник: '+(d.source||'1С')+'. Обновлено: '+(d.refreshedAt?new Date(d.refreshedAt).toLocaleString('ru-RU'):'—')+'.</div>';
}
// Выпуск продукции в кг — KPI + график 12 мес + топ продукции.
function renderProductionKg(pk){
  var el=document.getElementById('mktProdKgKpi'); if(!el) return;
  if(!pk || pk.error){ el.innerHTML='<div style="font-size:12px;color:var(--muted)">Нет данных выпуска: '+((pk&&pk.error)||'ошибка')+'</div>'; return; }
  var kpi=function(v,l){ return '<div class="mkt-kpi"><div class="mkt-v">'+v+'</div><div class="mkt-l">'+l+'</div></div>'; };
  var c=pk.current||{kg:0,units:0,momPct:null};
  var momStr = c.momPct==null ? '—' : '<span style="color:'+(c.momPct>=0?'#10a05a':'#e0466a')+'">'+(c.momPct>0?'+':'')+mNum1(c.momPct)+' %</span>';
  el.innerHTML='<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">'+
    kpi(mNum(c.kg)+' кг','Выпуск за месяц')+
    kpi(mNum(c.units)+' шт','Штук произведено')+
    kpi(momStr,'К прошлому месяцу')+
    '</div>';
  // График по месяцам
  var months=pk.months||[];
  if(months.length){
    mBars('mktProdKgChart', months.map(function(m){return m.label;}), months.map(function(m){return m.kg;}), 'var(--accent)', ' кг');
  }
  // Топ продукции по кг
  var top=pk.topProducts||[];
  var tEl=document.getElementById('mktProdKgTop');
  if(tEl){
    if(top.length){
      tEl.innerHTML='<table><thead><tr><th>Продукция</th><th class="num">Кг</th><th class="num">Шт</th></tr></thead><tbody>'+
        top.slice(0,20).map(function(r,i){ return '<tr><td>'+(i+1)+'. '+r.name+'</td><td class="num">'+mNum(r.kg)+'</td><td class="num">'+mNum(r.units)+'</td></tr>'; }).join('')+'</tbody></table>';
    } else { tEl.innerHTML='<div style="font-size:12px;color:var(--muted)">Нет данных за месяц.</div>'; }
  }
}
function mktCsvN(n, dec){ return dec ? (Math.round(n*100)/100).toFixed(2).replace('.',',') : String(Math.round(n)); }
function mktExport(){
  // Экспорт ТОЛЬКО из live-данных (захардкоженный MKT.* убран — он давал выдуманные/
  // устаревшие SMS/контекст/2ГИС). Источники: monthlySeries (1С), directHistory (кабинет
  // Директа), gisHistory (кабинет 2ГИС), sms-attribution, paid-costs, gisDemand.
  var d=_mktLive;
  if(!d){ alert('Данные ещё загружаются — открой вкладку Маркетинг и подожди пару секунд.'); return; }
  var MM=['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  var ymLbl=function(ym){ var p=String(ym).split('-'); return MM[Number(p[1])]+' '+p[0]; };
  var L=[], push=function(arr){ L.push(arr.map(function(v){return String(v==null?'':v).replace(/;/g,',');}).join(';')); };
  push(['Маркетинг «Мария» — live-выгрузка ('+new Date().toLocaleDateString('ru-RU')+')']);
  push(['Все цифры из источников: 1С, кабинеты Я.Директа и 2ГИС, Метрика. Без оценок.']); L.push('');

  // Платные каналы / бюджет (paid-costs за выбранный месяц)
  if(_mktPaid && _mktPaid.channels){
    push(['Платные каналы (за месяц), руб']); push(['Канал','Затраты/мес руб','Что даёт']);
    _mktPaid.channels.forEach(function(c){ push([c.name, mktCsvN(c.cost), (c.live?'':'(фикс) ')+(c.result||'').replace(/<[^>]+>/g,'')]); });
    push(['Итого/мес', mktCsvN(_mktPaid.totalMonthly), '']); L.push('');
  }

  // Продажи и лояльность помесячно (1С)
  var ms=(d.monthlySeries&&d.monthlySeries.cur||[]).filter(function(m){return !m._pending && m.revenue;});
  if(ms.length){ push(['Продажи и лояльность помесячно (1С)']); push(['Месяц','Выручка руб','Чеков','Ср.чек руб','Карта лоял. %','Бонусами руб']);
    var rv=0,cq=0,bn=0; ms.forEach(function(m){ rv+=m.revenue||0;cq+=m.cheques||0;bn+=m.bonus||0;
      push([ymLbl(m.ym), mktCsvN(m.revenue), m.cheques, mktCsvN(m.avgCheck||(m.cheques?m.revenue/m.cheques:0)), mktCsvN(m.cardPct||0,1), mktCsvN(m.bonus||0)]); });
    push(['Итого', mktCsvN(rv), cq, mktCsvN(cq?rv/cq:0), '', mktCsvN(bn)]); L.push('');
  }

  // Я.Директ помесячно (кабинет)
  var dh=(d.external&&d.external.directHistory&&d.external.directHistory.months||[]).filter(function(m){return m.spend;});
  if(dh.length){ push(['Я.Директ помесячно (кабинет porg-mcw4s7ni)']); push(['Месяц','Расход руб','Показы','Клики','CTR %','Конверсии','CR %','CPC руб','CPA руб']);
    dh.forEach(function(m){ push([ymLbl(m.ym), mktCsvN(m.spend), m.impressions, m.clicks, mktCsvN(m.ctrPct||0,1), m.conversions, mktCsvN(m.crPct||0,1), mktCsvN(m.cpc||0,1), m.cpa==null?'':mktCsvN(m.cpa)]); });
    L.push('');
  }

  // 2ГИС присутствие в выдаче помесячно (кабинет)
  var gh=(d.external&&d.external.gisHistory&&d.external.gisHistory.series||[]).filter(function(m){return m.impressions;});
  if(gh.length){ push(['2ГИС — присутствие в выдаче помесячно (кабинет)']); push(['Месяц','Показы в выдаче','Дней','Позиция ср.','Позиция мин','Позиция макс']);
    gh.forEach(function(m){ push([ymLbl(m.ym), m.impressions, m.days||'', m.positionAvg==null?'':mktCsvN(m.positionAvg,1), m.positionMin||'', m.positionMax||'']); });
    L.push('');
  }

  // SMS-атрибуция (чистые данные)
  if(_mktSms && _mktSms.totals){ var t=_mktSms.totals;
    push(['SMS-рассылки — атрибуция (за месяц, чистые данные)']); push(['Показатель','Значение']);
    push(['Получателей (уник. карт)', mktCsvN(t.recipients||0)]);
    push(['Затраты руб (получатели × '+(_mktSms.price||8.5)+')', mktCsvN(t.cost||0)]);
    push(['Купивших/перешедших', mktCsvN(t.buyers||0)]);
    push(['Выручка атрибут. руб', mktCsvN(t.revenue||0)]);
    if(t.sweetReg!=null) push(['Регистраций в «Сладком чеке»', mktCsvN(t.sweetReg)]);
    L.push('');
  }

  // Сладкий чек — текущий месяц (1С)
  if(d.sweet && d.sweet.cur){ var sc=d.sweet.cur;
    push(['«Сладкий чек» — '+(d.monthName||'месяц')+' (1С)']); push(['Показатель','Значение']);
    push(['Активных карт', mktCsvN(sc.cards||0)]); push(['Выполнений заданий', mktCsvN(sc.events||0)]); push(['Баллов начислено', mktCsvN(sc.points||0)]); L.push('');
  }

  // Поисковые запросы 2ГИС (Спрос)
  var gd=d.external&&d.external.gisDemand;
  if(gd && gd.queries && gd.queries.length){ push(['Поисковые запросы 2ГИС'+(gd.period?' ('+gd.period+')':'')]); push(['Запрос','Доля %']);
    gd.queries.forEach(function(q){ push([q.q, mktCsvN(q.pct,1)]); }); L.push('');
  }

  var csv='﻿'+L.join('\n');
  var el=document.createElement('a');
  el.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  el.download='maria-marketing-live-'+(new Date().toISOString().slice(0,10))+'.csv';
  el.click();
}
var COMPETITORS = [
  { name:'Мария', us:true, site:'maria-irk.ru', points:'~17–22 (Иркутск) + Ангарск',
    social:'IG @fabrika_maria ~32 тыс.; VK, Telegram, ОК', followers:'~32 тыс. (IG)', rating:'2ГИС ~4,4 (разброс 4,1–4,7)',
    loyalty:'«Любимый покупатель»: кэшбэк 5/7/10 %, оплата до 30 % бонусами, 600 приветств.; клуб «Мария для своих» (100к+); геймификация «Сладкий чек»',
    online:'да + ЛК', products:'торты (флагман «Зебра»), бенто от 690 ₽, пирожные, пироги, выпечка, кофе, конфеты ручной работы',
    promos:'торт месяца −20 %, комбо кофе+круассан 349 ₽, розыгрыш «Сладкий чек» (iPhone 17/MacBook), 1000 бонусов за отзыв',
    strong:'лучшая на рынке программа лояльности (кэшбэк + клуб 100к+), окупаемый SEO-контент (~70 % трафика сайта, 46 тыс ₽/мес), TG Mini App',
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
// ОЦЕНКИ выручки и рекл.активности — НЕ публичные данные. Модель: точки × бенчмарк
// выручки на точку (откалиброван на факте «Марии»: ~145 млн за янв–май ≈ 29 млн/мес ≈
// 1,5 млн/точка/мес), скорректировано на сегмент. Точность ±30–40%.
var COMP_ESTIMATES = [
  { name:'Мария', us:true, points:'~17–22', rev:'~330–360 млн (факт-база: 145 млн за янв–май)', ad:'Измеримо', sig:'Директ РСЯ (~143к за период) + SMS (431к) + лояльность/кэшбэк' },
  { name:'Стефания', points:'~31–39', rev:'~550–800 млн', ad:'Высокая', sig:'Лотерея ДОБРОКАР (приз — авто Jaecoo J7 ~2,5 млн), 45 тыс. IG, максимум точек/городов' },
  { name:'Cake Home', points:'~20–24', rev:'~300–430 млн', ad:'Средняя', sig:'Конструктор торта, широкая сеть, слабые соцсети' },
  { name:'ЯХОНТ', points:'~16–18', rev:'~190–260 млн (эконом-сегмент)', ad:'Низкая–средняя', sig:'Региональная сеть, масс-производство, без лояльности' },
  { name:'Этика', points:'~7', rev:'~110–150 млн (премиум)', ad:'Средняя', sig:'Премиум-эстетика, премия «Лучшая кондитерская 2023», кофейня-формат' }
];
var REVIEWS = {
  'Мария': { rating:'2ГИС 4,4 (748) · Otzovik 2,0', pros:'вкус, оформление тортов, кофе, ранний режим (7:30)', cons:'БРАК (посторонние предметы в продукции!), нет реакции на жалобы, срывы заказов, цена/качество' },
  'Стефания': { rating:'2ГИС 4,8 (950) — топ рынка', pros:'свежесть, демократичные цены, персонал, выбор', cons:'волосы/грязь в кофемашине, менее пропитано, нехватка в час пик, сбои бонусов' },
  'Этика': { rating:'2ГИС 4,6 (1286)', pros:'вкус, интерьер с видом на Ангару, официанты', cons:'«цены космос», маленькие порции, медленный сервис, нет в наличии' },
  'Cake Home': { rating:'2ГИС 4,5 (335)', pros:'вкус, «лучший кофе в Иркутске», персонал, атмосфера', cons:'дорого/цены растут, суховато, неудобный вход и парковка, накладки с бронями' },
  'ЯХОНТ': { rating:'2ГИС 4,5 (141)', pros:'низкие цены, свежесть, ассортимент классики, скидки на ДР', cons:'СРЫВЫ ЗАКАЗОВ к дате (главное), кофе и сервис' }
};
function renderCompetitors(d){
  var el=document.getElementById('mktComp'); if(!el) return;
  // live-рейтинги из 2ГИС-кабинета (раздел «Сравнение»), оверлей на совпадающие имена
  var liveRat={}, gcAt=null;
  var gc=d&&d.external&&d.external.gisCompetitors;
  if(gc&&gc.companies){
    gcAt=gc.scrapedAt;
    var nameMap=[['стефан','Стефания'],['etika','Этика'],['этик','Этика'],['cake home','Cake Home'],['toti','Toti'],['la tarte','La tarte'],['яхонт','ЯХОНТ'],['мария','Мария']];
    gc.companies.forEach(function(co){ var low=(co.name||'').toLowerCase();
      var hit=nameMap.find(function(m){return low.indexOf(m[0])>=0;});
      if(hit&&co.rating) liveRat[hit[1]]={rating:co.rating,reviews:co.reviews};
    });
  }
  function ratOf(c){
    var lr=liveRat[c.name];
    if(lr) return '2ГИС <b>'+mNum1(lr.rating)+'</b>'+(lr.reviews?' ('+mNum(lr.reviews)+')':'')+' <span style="font-size:10px;color:#10a05a">live</span>';
    return ((REVIEWS[c.name]||{}).rating)||c.rating;
  }
  var cols=['Компания','Точки','Соцсети / подписчики','Рейтинг','Программа лояльности','Онлайн-заказ'];
  var th=cols.map(function(c){ return '<th>'+c+'</th>'; }).join('');
  var trs=COMPETITORS.map(function(c){
    return '<tr'+(c.us?' class="mkt-total"':'')+'><td>'+c.name+'</td><td>'+c.points+'</td><td>'+(c.followers&&c.followers!=='н/д'?c.followers:c.social)+'</td><td>'+ratOf(c)+'</td><td>'+c.loyalty+'</td><td>'+c.online+'</td></tr>';
  }).join('');
  function r(k,v){ return v?'<dt>'+k+'</dt><dd>'+v+'</dd>':''; }
  var cards=COMPETITORS.map(function(c){
    return '<div class="mkt-comp-card'+(c.us?' mkt-comp-us':'')+'">'+
      '<div class="mkt-comp-h">'+c.name+(c.us?' <span class="mkt-badge">это мы</span>':'')+'</div>'+
      (c.site?'<div class="mkt-comp-site"><a href="https://'+c.site+'" target="_blank" rel="noopener">'+c.site+'</a></div>':'')+
      '<dl class="mkt-comp-dl">'+ r('Точки',c.points)+r('Продукция',c.products)+r('Акции/предложения',c.promos)+r('Соцсети',c.social)+r('Рейтинг',ratOf(c))+r('Хвалят (отзывы)',(REVIEWS[c.name]||{}).pros)+r('Ругают (отзывы)',(REVIEWS[c.name]||{}).cons)+
      (c.strong?'<dt class="ok">Сильные стороны</dt><dd>'+c.strong+'</dd>':'')+
      (c.weak?'<dt class="bad">Слабые стороны</dt><dd>'+c.weak+'</dd>':'')+ '</dl></div>';
  }).join('');
  var ins='<div class="mkt-comp-ins"><div class="mkt-chart-t">Ключевые выводы</div><ul>'+COMP_INSIGHTS.map(function(x){return '<li>'+x+'</li>';}).join('')+'</ul></div>';
  // блок оценок выручки/рекламной активности
  var estRows=COMP_ESTIMATES.map(function(e){
    return '<tr'+(e.us?' class="mkt-total"':'')+'><td>'+e.name+'</td><td>'+e.points+'</td><td>'+e.rev+'</td><td>'+e.ad+'</td><td style="font-size:12px;color:var(--muted)">'+e.sig+'</td></tr>';
  }).join('');
  var est='<div class="section-label" style="margin-top:24px">Оценка масштаба и рекламной активности</div>'+
    '<div class="section-hint">⚠️ Выручка и бюджеты конкурентов <b>публично не раскрываются</b>. Это <b>оценка ±30–40%</b> по модели: число точек × бенчмарк выручки на точку (калибровка на факте «Марии» ~1,5 млн ₽/точка/мес), с поправкой на сегмент. Рекламная активность — по наблюдаемым сигналам (лотереи, Директ, соцсети), не по реальным тратам.</div>'+
    '<div class="table-wrap"><table><thead><tr><th>Компания</th><th>Точек</th><th>Оценка выручки, ₽/год</th><th>Реклама</th><th>Сигналы</th></tr></thead><tbody>'+estRows+'</tbody></table></div>';
  el.innerHTML='<div class="table-wrap"><table><thead><tr>'+th+'</tr></thead><tbody>'+trs+'</tbody></table></div><div class="mkt-comp-cards">'+cards+'</div>'+est+ins;
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
  // Помечаем колонки-оценки явно — числа без live-источника
  var cols=['Компания','Telegram, подп.','TG охват (оценка)','Instagram (оценка)','IG Reels (оценка)','VK'];
  var th=cols.map(function(c,i){ return '<th'+(i?' class="num"':'')+'>'+c+'</th>'; }).join('');
  var trs=SOCIAL.map(function(s){ return '<tr'+(s.us?' class="mkt-total"':'')+'><td>'+s.name+'</td><td class="num">'+s.tg+'</td><td class="num" style="color:var(--muted)">'+s.tgReach+'</td><td class="num" style="color:var(--muted)">'+s.ig+'</td><td class="num" style="color:var(--muted)">'+(s.igReels||'н/д')+'</td><td class="num">'+s.vk+'</td></tr>'; }).join('');
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
  ['Торт на заказ','1350–2320 ₽/шт','1800 ₽/кг','от 2090 ₽/кг','1790–2990 ₽/кг','640–1700 ₽/шт'],
  // «Просто торты» = готовые целые в наличии на витрине (не заказные, не кусочки).
  // Мария — реальные цены продаж из 1С за 30 дней (05.05–04.06.2026): 46 позиций,
  // от 952 ₽, ходовые (топ-10 по штукам) 1 390–2 320 ₽, средняя 1 511 ₽.
  // Конкуренты — веб-ресёрч 05.06.2026: Стефания «Торты на каждый день» (сайт, 20+
  // позиций), Этика «Стандартные торты» (сайт, 8 позиций 1–1,6 кг), Cake Home
  // /catalog/cakes/ (сайт), ЯХОНТ — официальная карточка 2ГИС (21 позиция).
  // Единицы разные (₽/кг vs ₽/шт) — в каждой ячейке, источник в title.
  ['Просто торты (готовые, в наличии)*','<span title="1С, чеки 05.05–04.06.2026: 46 позиций, от 952 ₽, средняя 1 511 ₽, ходовые 1 390–2 320 ₽">от 952 ₽/шт · ср. 1 511 ₽</span>','<span title="stefanycake.ru «Торты на каждый день», 20+ позиций, 05.06.2026; большинство 765–1 195 ₽/кг">525–1 350 ₽/кг</span>','<span title="etikacakes.ru «Стандартные торты», 8 позиций по 1–1,6 кг, 05.06.2026 (≈1 900–2 280 ₽/кг)">2 280–3 280 ₽/шт</span>','<span title="cakehome.ru/catalog/cakes, 05.06.2026; целиком 848–4 485 ₽/шт">1 690–2 990 ₽/кг</span>','<span title="Официальная карточка 2ГИС (Обручева 14), 21 позиция, 05.06.2026; большинство 900–1 305 ₽">640–1 700 ₽/шт</span>'],
  ['Бенто-торт','от 690 ₽','1000 ₽','от 1590 ₽','350–520 ₽','от 495 ₽'],
  ['Кусочек / пирожное','88–308 ₽','89–199 ₽','210–460 ₽','н/д','н/д'],
  ['Макаронс, ₽/шт','н/д','109 ₽','135 ₽','120 ₽','131 ₽'],
  ['Капучино','210–360 ₽','н/д','н/д','н/д','н/д']
];
// ВАЖНО: mktRenderProducts, а НЕ renderProducts — на дашборде есть свой
// function renderProducts(summary) (пишет в #productsList). Одноимённое
// объявление здесь хойстингом затирало бы дашбордовое (та же ловушка, что
// была с renderComparison). Маркетинговый рендер товаров изолирован.
function mktRenderProducts(){
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
    '<div class="mkt-comp-ins" style="margin-top:12px"><b>Вывод по ценам:</b> «Мария» — в середине. Бенто от 690 ₽ — самый дешёвый старт на рынке (трафик-драйвер). Целые торты дороже эконом-сетей (Стефания от 525 ₽/кг, ЯХОНТ от 640 ₽/шт), но дешевле премиума (Этика от 2090 ₽/кг, Cake Home до 2990 ₽/кг). Кофе-меню — единственное публичное на рынке.</div>'+
    '<div style="font-size:11px;color:var(--muted);margin-top:6px">* «Просто торты» (готовые целые в наличии): Мария — реальные цены продаж из 1С (чеки 05.05–04.06.2026, 46 позиций); конкуренты — веб-ресёрч 05.06.2026 (сайты Стефании/Этики/Cake Home, ЯХОНТ — карточка 2ГИС). Наведи на ячейку — источник и детали. Сопоставление: Мария ср. 1 511 ₽/шт — между эконом (Стефания 765–1 195 ₽/кг, ЯХОНТ 640–1 700 ₽/шт) и премиумом (Этика 2 280–3 280 ₽/шт, Cake Home 1 690–2 990 ₽/кг).</div>';
}
// Воронка: классическая визит→корзина→оплата невозможна (нет ecommerce-целей в Метрике).
// Строим РЕАЛЬНУЮ mini-воронку «путь к регистрации в лояльности» из живых источников:
// визиты сайта (Метрика) → переходы на страницу регистрации /for_clients/ (Метрика) →
// новые карты «Сладкого чека» (1С). Охваты/периоды у шагов разные — помечаем явно,
// конверсию считаем ТОЛЬКО там, где охват совпадает (визит→страница, оба из Метрики).
function renderFunnel(d){
  var el=document.getElementById('mktFunnel'); if(!el) return;
  var met=d&&d.external&&d.external.metrika;
  var sc=d&&d.external&&d.external.smsClicks;
  var sweet=d&&d.sweet&&d.sweet.cur;
  var visits=met&&met.totalVisits;
  // переходы на /for_clients/ (страница регистрации Сладкого чека)
  var fcVisits=null, fcUsers=null;
  if(sc&&sc.codeToUrl){
    Object.keys(sc.codeToUrl).forEach(function(code){
      if(/\/for_clients\//.test(sc.codeToUrl[code])){
        fcVisits=(fcVisits||0)+((sc.byCodeVisits&&sc.byCodeVisits[code])||0);
        fcUsers=(fcUsers||0)+((sc.byCode&&sc.byCode[code])||0);
      }
    });
  }
  var regs=sweet&&sweet.cards;
  if(!visits && fcVisits==null && regs==null){
    el.innerHTML='<div class="section-hint">Классическая воронка визит→корзина→оплата требует ecommerce-целей в Метрике (их в счётчике 43949414 нет). Ниже — реальная mini-воронка лояльности из Метрики+1С, как только подгрузятся источники.</div>';
    return;
  }
  var metP=(met&&met.period&&met.period.label)||'период Метрики';
  var scP=(sc&&sc.period)||'период';
  var steps=[];
  if(visits) steps.push({l:'Визиты сайта', n:visits, src:'Метрика · '+metP+' · все источники'});
  if(fcVisits!=null) steps.push({l:'Переходы на страницу регистрации /for_clients/', n:fcVisits, src:'Метрика · '+scP+' · в осн. из SMS-рассылки', conv:visits?fcVisits/visits*100:null});
  if(regs!=null) steps.push({l:'Новые карты «Сладкого чека»', n:regs, src:'1С · '+((d&&d.monthName)||'месяц')+' · все источники'});
  var max=steps.length?Math.max.apply(null,steps.map(function(s){return s.n;})):1;
  el.innerHTML='<div class="mkt-funnel">'+steps.map(function(s){
    var w=Math.max(s.n/max*100,10);
    return '<div class="mkt-fstep"><div class="mkt-fbar" style="width:'+w.toFixed(1)+'%"><span>'+s.l+'</span><b>'+mNum(s.n)+'</b></div>'+
      '<div class="mkt-fconv" style="font-size:10px">'+(s.conv!=null?'→ '+mNum1(s.conv)+' % от визитов · ':'')+s.src+'</div></div>';
  }).join('')+'</div>'+
  '<div class="mkt-comp-ins" style="margin-top:10px;font-size:11px"><b>Это не классическая воронка покупок</b> (для неё нужны ecommerce-цели в Метрике — корзина/оплата, сейчас не настроены). Здесь — реальные числа из Метрики и 1С по пути к регистрации в лояльности. Шаги имеют <b>разные охваты и периоды</b> (визиты — все источники за 28 дн; переходы на /for_clients/ измеряются в основном по SMS-ссылке; новые карты — из 1С за выбранный месяц), поэтому сквозную конверсию между ними считать некорректно.</div>';
}
// Алерты живые: считаются из данных /api/marketing/channels за ВЫБРАННЫЙ период (d).
// Без аргументов — плейсхолдер (вызывается из mktInit до загрузки). Только реальные данные.
// Для незавершённого (текущего) месяца абсолютный YoY по выручке/чекам недостоверен —
// показываем лишь относительные сигналы (доли: средний чек, карта) + пометку.
// ── Аудитории для рассылок: живые сегменты из 1С + тексты + CSV ──────────────
// Не зависит от выбранного периода — грузится один раз при входе на вкладку.
function loadCampaignAudiences(){
  var el=document.getElementById('mktAudiences'); if(!el) return;
  fetchJson('/api/marketing/campaign-audiences').then(function(d){ renderCampaignAudiences(d); })
    .catch(function(e){ el.innerHTML='<div style="font-size:12px;color:var(--muted)">Сегменты недоступны: '+escapeHtml(e.message)+'</div>'; });
}
function renderCampaignAudiences(d){
  var el=document.getElementById('mktAudiences'); if(!el||!d||!d.segments) return;
  var segs=d.segments.slice().sort(function(a,b){ return (a.priority||9)-(b.priority||9); });
  var totalSms=0, totalCost=0;
  segs.forEach(function(s){ totalSms+=s.size||0; totalCost+=s.smsCostRub||0; });
  var html='<div class="aud-summary">Всего в сегментах: <b>'+fmtNum(totalSms)+'</b> получателей · отправка всех волн ≈ <b>'+fmtNum(totalCost)+' ₽</b> ('+d.smsPrice+' ₽/SMS) · окно оттока: '+escapeHtml((d.windows&&d.windows.churn)||'')+(d.fromCache?' · из кэша':'')+'</div>';
  html+='<div class="aud-grid">';
  segs.forEach(function(s,i){
    var metr=[];
    if(s.bonusSum) metr.push('бонусов на сегменте: <b>'+fmtNum(s.bonusSum)+' ₽</b>');
    if(s.withBonus) metr.push('с бонусами ≥50: <b>'+fmtNum(s.withBonus)+'</b>');
    if(s.avgSpent) metr.push('ср. покупки: <b>'+fmtNum(s.avgSpent)+' ₽</b>');
    html+='<div class="aud-card">'
      +'<div class="aud-head"><span class="aud-prio">'+(i+1)+'</span><span class="aud-title">'+escapeHtml(s.title)+'</span><span class="aud-size">'+fmtNum(s.size)+' чел.</span></div>'
      +'<div class="aud-desc">'+escapeHtml(s.desc||'')+'</div>'
      +(metr.length?'<div class="aud-metr">'+metr.join(' · ')+'</div>':'')
      +'<div class="aud-text" title="Рекомендованный текст, '+s.textLen+' зн. = 1 SMS-сегмент. {Имя}/{N} подставляются в CSV автоматически."><code>'+escapeHtml(s.text)+'</code>'
      +'<button class="aud-copy" data-text="'+escapeHtml(s.text)+'">копировать</button></div>'
      +(s.needsApproval?'<div class="aud-warn">⚠ '+escapeHtml(s.needsApproval)+'</div>':'')
      +'<div class="aud-foot"><span class="aud-cost">~'+fmtNum(s.smsCostRub)+' ₽</span>'
      +'<a class="aud-btn" href="'+escapeHtml(s.csvUrl)+'" download>⬇ CSV для рассыльщика</a></div>'
      +'</div>';
  });
  html+='</div>';
  html+='<div class="aud-note">'+escapeHtml(d.note||'')+' Порядок: сверху вниз по приоритету; после каждой волны — замер в блоке «SMS-атрибуция» ниже (окно 14 дней). Перед повторной выгрузкой сегмент пересчитается сам — вернувшиеся выпадут из списков.</div>';
  el.innerHTML=html;
  el.querySelectorAll('.aud-copy').forEach(function(b){
    b.addEventListener('click', function(){
      navigator.clipboard.writeText(b.dataset.text).then(function(){ b.textContent='скопировано'; setTimeout(function(){ b.textContent='копировать'; },1500); });
    });
  });
}
function renderAlerts(d, period){
  var el=document.getElementById('mktAlerts'); if(!el) return;
  if(!d){ el.innerHTML='<div class="mkt-yoy-load">Загрузка сигналов…</div>'; return; }
  var a=[], mn=d.monthName||'';
  var now=new Date(), curYM=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  var partial = period===curYM; // текущий месяц ещё идёт

  // Карта лояльности (доля — достоверна и для неполного месяца)
  if(d.cardPct && d.cardPct.deltaPp!=null){
    var dpp=d.cardPct.deltaPp;
    if(dpp<=-1) a.push(['red','Лояльность падает','Карта лояльности в чеках '+mNum1(d.cardPct.cur)+' % (год назад '+mNum1(d.cardPct.prev)+' %, '+mNum1(dpp)+' п.п.). Теряется база для CRM и SMS.']);
    else if(dpp>=1) a.push(['green','Лояльность растёт','Карта лояльности '+mNum1(d.cardPct.cur)+' % (+'+mNum1(dpp)+' п.п. YoY) — база для CRM крепнет.']);
  }
  // Средний чек (доля)
  if(d.avgCheck && d.avgCheck.deltaPct!=null){
    var ac=d.avgCheck.deltaPct;
    if(ac<=-3) a.push(['amber','Средний чек ниже прошлого года','Средний чек '+mNum(d.avgCheck.cur)+' ₽ ('+mNum1(ac)+' % YoY). Проверить промо/скидки и структуру чека.']);
    else if(ac>=3) a.push(['green','Средний чек растёт','Средний чек '+mNum(d.avgCheck.cur)+' ₽ (+'+mNum1(ac)+' % YoY).']);
  }
  // Выручка YoY — только для завершённого месяца (для текущего абсолют недостоверен)
  if(!partial && d.revenue && d.revenue.deltaPct!=null){
    var rv=d.revenue.deltaPct;
    if(rv<=-5) a.push(['red','Выручка ниже прошлого года',mn+': '+mNum(d.revenue.cur)+' ₽ ('+mNum1(rv)+' % к тому же месяцу год назад).']);
    else if(rv>=5) a.push(['green','Выручка растёт YoY',mn+': '+mNum(d.revenue.cur)+' ₽ (+'+mNum1(rv)+' % YoY).']);
  }
  // Точки: худшая и лучшая по YoY (завершённый месяц)
  if(!partial && d.byStore && d.byStore.length){
    // Только реально работавшие ОБА года розничные точки: иначе −100% (закрытые) и
    // +500 % (новые, база ~0) дают ложные сигналы. Склады/опт/цех — не розница.
    var ys=d.byStore.filter(function(s){
      return s.revenue && s.revenue.deltaPct!=null && s.revenue.cur>0 && s.revenue.prev>=1000000
        && !/склад|опт|цех|производ/i.test(s.name||'');
    }).slice().sort(function(x,y){return x.revenue.deltaPct-y.revenue.deltaPct;});
    if(ys.length){
      var worst=ys[0], best=ys[ys.length-1];
      if(worst.revenue.deltaPct<=-10) a.push(['amber','Точка проседает YoY',worst.name+': выручка '+mNum(worst.revenue.cur)+' ₽ ('+mNum1(worst.revenue.deltaPct)+' % к тому же месяцу год назад). Разобраться с точкой.']);
      if(best.revenue.deltaPct>=15) a.push(['green','Точка-лидер роста',best.name+': +'+mNum1(best.revenue.deltaPct)+' % выручки YoY ('+mNum(best.revenue.cur)+' ₽).']);
    }
  }
  // Категории: топ-растущая / падающая (завершённый месяц). Только заметная доля и
  // ненулевая база год назад — иначе мелкая/новая категория даёт «+780 %» из шума.
  if(!partial && d.categories && d.categories.length){
    var cg=d.categories.filter(function(c){return c.deltaPct!=null && c.prev>0;}).slice().sort(function(x,y){return y.deltaPct-x.deltaPct;});
    var up=cg.filter(function(c){return c.sharePct>=5;})[0];
    if(up && up.deltaPct>=10) a.push(['green','Категория на подъёме',up.group+': +'+mNum1(up.deltaPct)+' % YoY ('+mNum1(up.sharePct)+' % выручки).']);
    var downs=cg.filter(function(c){return c.sharePct>=3;});
    var drop=downs.length?downs[downs.length-1]:null;
    if(drop && drop.deltaPct<=-10) a.push(['amber','Категория падает',drop.group+': '+mNum1(drop.deltaPct)+' % YoY ('+mNum1(drop.sharePct)+' % выручки).']);
  }
  // Я.Директ: дорогой CPA и заканчивающийся баланс
  var dir=d.external&&d.external.direct;
  if(dir&&dir.totals&&dir.totals.spend){
    var t=dir.totals;
    if(t.cpa!=null && t.cpa>=400) a.push(['amber','CPA контекста дорогой','Я.Директ: CPA по расходу '+mNum(t.cpa)+' ₽/конв. (только рекламный расход '+mNum(t.spend)+' ₽ ÷ '+mNum(t.conversions)+' конв.; без агентской платы — её учитывает «CPA с агентством» в блоке «Платные каналы»). Оптимизировать кампании.']);
    if(dir.balance!=null && t.spend>0 && dir.balance<t.spend) a.push(['red','Баланс Директа кончается','Остаток '+mNum(dir.balance)+' ₽ при расходе ~'+mNum(t.spend)+' ₽/мес (меньше месяца). Пополнить — иначе реклама встанет.']);
  }
  // 2ГИС: позиция в выдаче (актуально всегда)
  var gis=d.external&&d.external.gis;
  if(gis&&gis.appearance&&gis.appearance.positionAvg!=null){
    if(gis.appearance.positionAvg<=5) a.push(['green','Топ в 2ГИС','Средняя позиция в выдаче 2ГИС — '+gis.appearance.positionAvg+' ('+mNum(gis.appearance.impressions||0)+' показов/мес). Сильный органический канал.']);
    else if(gis.appearance.positionAvg>=20) a.push(['amber','Низко в 2ГИС','Средняя позиция в 2ГИС — '+gis.appearance.positionAvg+'. Поработать с рубриками и карточкой.']);
  }
  // Метрика: доля органики
  var mk=d.external&&d.external.metrika;
  if(mk&&mk.sources&&mk.sources.length){
    var seoSrc=mk.sources.find(function(s){return /поиск|seo/i.test(s.name);});
    if(seoSrc && seoSrc.sharePct>=50) a.push(['green','SEO — главный канал сайта','Органика '+mNum1(seoSrc.sharePct)+' % трафика сайта ('+mNum(seoSrc.visits)+' визитов). Расход 46к/мес оправдан.']);
  }
  // SMS без атрибуции (постоянный приоритет, пока нет BSL-патча получателей)
  a.push(['amber','SMS без атрибуции','Отдача SMS-рассылок в покупках пока не измеряется (ждём BSL-патч получателей в 1С). Приоритет — атрибуция «карта-получатель ↔ чек».']);
  // «Сладкий чек» — пассивный штамп
  if(d.sweet&&d.sweet.cur&&d.sweet.cur.tasks){
    var tk=d.sweet.cur.tasks;
    var totalEv=Object.keys(tk).reduce(function(s,k){var v=tk[k];return s+(typeof v==='object'?(v.events||0):v);},0);
    var buy=tk['Покупка']; var buyEv=typeof buy==='object'?(buy&&buy.events||0):(buy||0);
    if(totalEv>0 && buyEv/totalEv>=0.7) a.push(['amber','«Сладкий чек» — пассивный штамп',Math.round(buyEv/totalEv*100)+' % срабатываний — «Покупка» (1 балл за любой чек). Программа пока не двигает поведение; поднять пороги/награждать повторные визиты.']);
  }

  if(partial) a.unshift(['amber','Месяц ещё не закончился',mn+' в процессе — сравнение выручки и чеков с прошлым годом по абсолюту недостоверно. Показаны относительные сигналы (средний чек, карта лояльности, позиции в выдаче). Итоги — после закрытия месяца.']);
  if(!a.length) a.push(['green','Существенных отклонений нет','За '+mn+' ключевые метрики в норме относительно прошлого года.']);
  el.innerHTML=a.map(function(x){ return '<div class="mkt-alert mkt-alert-'+x[0]+'"><div class="mkt-alert-t">'+x[1]+'</div><div>'+x[2]+'</div></div>'; }).join('');
}
var AI_SUMMARY = [
  ['Измерить отдачу SMS','SMS — заметная доля платного бюджета (точные цифры — в блоке «Платные каналы» и «SMS-атрибуция»). Атрибуция «карта-получатель ↔ чек» уже включена; следующий шаг — отключать неокупаемые сегменты по факту конверсии.'],
  ['Остановить отток лояльности','Доля чеков с картой лояльности снижается (динамика — в «Продажи и лояльность»). Вернуть привычку прикладывать карту — иначе деградируют и SMS-база, и кэшбэк-программа (наш главный ров против конкурентов).'],
  ['Считать ROI SEO и масштабировать','SEO стоит 46 тыс ₽/мес — один из самых дешёвых каналов по ₽/визит (доля органики — в блоке источников трафика). Подключить атрибуцию «органика → чек» (через UTM на купоны/каталоги) и при положительном ROI наращивать контент: одна статья-рецепт окупается за месяцы трафика.'],
  ['Качество и работа с жалобами','Главная боль по отзывам — брак (посторонние предметы) и отсутствие реакции на претензии. Регламент рекламаций (извинение + компенсация) поднимет рейтинг дешевле рекламы.'],
  ['Усилить Telegram','TG-охват в ~15–20× ниже Стефании — самый недоиспользованный канал. Брать вовлечённостью (по образцу Этики с высоким ER).'],
  ['Развивать кофе и кафе-формат','Капучино — №1 по штукам, кофе-меню — уникальное преимущество (эконом-сети Стефания/ЯХОНТ тут слабы).'],
  ['Занять конструктор торта','Онлайн-конструктор есть только у Cake Home — свободная ниша для дифференциации.'],
  ['Держать CPA контекста','CPA вырос со 158 ₽ (март) до 480 ₽ (май). Оптимизировать кампании, ориентир — мартовская эффективность.']
];
function renderAI(){ var el=document.getElementById('mktAI'); if(!el) return;
  el.innerHTML='<ol class="mkt-ai-list">'+AI_SUMMARY.map(function(x){return '<li><b>'+x[0]+'.</b> '+x[1]+'</li>';}).join('')+'</ol>';
}
var DEMAND_2GIS = [['мария',43.5],['мария, кафе-кондитерская',7.4],['торты',5.3],['кондитерские магазины',3.8],['кофейни',3.5],['кофе',3.1],['кондитерская',1.9],['мария кондитерская',1.8],['завтрак',1.2],['кофейня',1.1],['кондитерские',1.1],['торт',1.0],['выпечка',0.8],['кондитерские изделия',0.8],['бенто-торты',0.5],['прочее',20.3]];
function renderDemand(d){
  var el=document.getElementById('mktDemand'); if(!el) return;
  // live: поисковые запросы 2ГИС из секции demand (scrape-mkt.js, cron daily)
  var live=d&&d.external&&d.external.gisDemand;
  var rows, period=null, isLive=false, st=null;
  if(live&&live.queries&&live.queries.length){
    rows=live.queries.map(function(x){return [x.q,x.pct];});
    period=live.period; isLive=true; st=live.scrapedAt;
  } else {
    rows=DEMAND_2GIS;
  }
  // доля брендовых («мария»…) для вывода
  var brand=rows.reduce(function(s,r){ return s + (/мари/i.test(r[0])?r[1]:0); },0);
  var max=rows[0][1];
  var scope=isLive ? ('live · 2ГИС'+(period?' · '+period:'')) : 'снимок · апрель 2026';
  el.innerHTML='<div style="font-size:11px;color:var(--muted);margin-bottom:6px">'+scope+(isLive&&st?' · обновлено '+new Date(st).toLocaleDateString('ru-RU'):'')+' · не зависит от выбранного месяца</div>'+
    '<div class="table-wrap"><table><thead><tr><th>Запрос</th><th class="num">Доля</th><th>&nbsp;</th></tr></thead><tbody>'+
    rows.map(function(r){ var w=Math.max(r[1]/max*100,2); return '<tr><td>'+r[0]+'</td><td class="num">'+mNum1(r[1])+' %</td><td style="width:40%"><div class="mkt-dbar" style="width:'+w.toFixed(0)+'%"></div></td></tr>'; }).join('')+'</tbody></table></div>'+
    '<div class="mkt-comp-ins" style="margin-top:12px"><b>Вывод:</b> ~'+mNum1(brand)+' % запросов брендовые («мария» + варианты) — высокая узнаваемость. Родовой спрос (торты, кондитерские, кофейни, кофе, завтрак) — точки роста через SEO и карточку; заметная доля «кофе/кофейни/завтрак» подтверждает кафе-нишу.</div>';
}
// «Прочие каналы» — действующие акции (d.promos) + база карт лояльности (d.loyaltyCards),
// всё live из 1С. Метрик Я.Карт/онлайн-сайта/звонков в 1С нет — честно не показываем.
function renderOtherChannels(d){
  var el=document.getElementById('mktOther'); if(!el) return;
  var promos=(d&&d.promos)||[];
  var lc=(d&&d.loyaltyCards)||{};
  var pu=(d&&d.promoUsage)||{};
  var usage=pu.byPromo||[];
  // Использование по имени акции: чеки по виртуальным картам акции + прямые чеки + кофе-бонус.
  var byName={};
  usage.forEach(function(u){ byName[u.name]=u; });
  var fd=function(s){ if(!s) return '—'; var p=String(s).split('-'); return p.length===3?(p[2]+'.'+p[1]+'.'+p[0]):s; };
  var kpi=function(v,l){ return '<div class="mkt-kpi"><div class="mkt-v">'+v+'</div><div class="mkt-l">'+l+'</div></div>'; };
  var html='<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px">'+
    kpi('<b>'+(lc.total!=null?mNum(lc.total):'н/д')+'</b>','Карт лояльности в базе')+
    kpi(lc.newThisMonth!=null?('+'+mNum(lc.newThisMonth)):'н/д','Новых карт за месяц')+
    kpi(mNum(promos.length),'Действующих акций')+
    '</div>';
  var usageCells=function(u){
    if(!u||(!u.cheques&&!u.orders&&!u.cardsTotal)) return '<td class="num" style="color:var(--muted)">0</td><td class="num" style="color:var(--muted)">0</td><td class="num" style="color:var(--muted)">0</td><td class="num" style="color:var(--muted)">0</td><td class="num" style="color:var(--muted)">—</td>';
    return '<td class="num">'+mNum(u.cardsTotal||0)+'</td><td class="num">'+mNum(u.cheques||0)+'</td><td class="num">'+mNum(u.orders||0)+'</td><td class="num">'+mNum(u.buyers||0)+'</td><td class="num">'+(u.revenue?mNum(u.revenue)+' ₽':'—')+'</td>';
  };
  var usageHead='<th class="num" title="Виртуальных карт создано по акции (за всё время)">Карт</th><th class="num" title="Чеков ККМ по картам/ссылкам акции за выбранный месяц">Чеков</th><th class="num" title="Заказов покупателя с этим промокодом за выбранный месяц (телефон/сайт/доставка)">Заказов</th><th class="num" title="Уникальных карт-покупателей за месяц">Покупателей</th><th class="num" title="Выручка чеков и заказов акции за месяц">Выручка</th>';
  // Для ДЕЙСТВУЮЩИХ промокодов колонка «Карт» всегда 0 (промокоды заказов карт не создают) —
  // показываем только реальную активность за месяц, чтобы нули не путали (по просьбе Маши 08.06).
  var actHead='<th class="num" title="Чеков ККМ, где применялась эта акция, за месяц">Чеков</th><th class="num" title="Заказов покупателя с этим промокодом за месяц (телефон/сайт/доставка)">Заказов</th><th class="num" title="Уникальных карт-покупателей за месяц">Покупателей</th><th class="num" title="Выручка чеков и заказов с этой акцией за месяц">Выручка</th>';
  var actCells=function(u){
    if(!u || (!u.cheques && !u.orders)) return '<td colspan="4" style="font-size:11px;color:var(--muted)">— за месяц не применялась</td>';
    return '<td class="num">'+mNum(u.cheques||0)+'</td><td class="num">'+mNum(u.orders||0)+'</td><td class="num">'+mNum(u.buyers||0)+'</td><td class="num">'+(u.revenue?mNum(u.revenue)+' ₽':'—')+'</td>';
  };
  if(promos.length){
    // Активные наверх — сортируем по фактическому использованию (чеки+заказы) за месяц.
    var promosSorted=promos.slice().sort(function(a,b){ var ua=byName[a.name]||{},ub=byName[b.name]||{}; return ((ub.cheques||0)+(ub.orders||0))-((ua.cheques||0)+(ua.orders||0)); });
    html+='<div class="mkt-chart-t">Действующие промокоды и акции (1С) — использование за выбранный месяц</div>'+
      '<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Акция</th><th class="num">Начало</th><th class="num">Окончание</th>'+actHead+'</tr></thead><tbody>'+
      promosSorted.map(function(p){ return '<tr><td>'+p.name+'</td><td class="num">'+fd(p.start)+'</td><td class="num">'+fd(p.end)+'</td>'+actCells(byName[p.name])+'</tr>'; }).join('')+
      '</tbody></table></div>'+
      '<div style="font-size:11px;color:var(--muted);margin-top:4px"><b>«Чеков»</b> — применений на кассе (чек ККМ), <b>«Заказов»</b> — в заказах покупателя (телефон/сайт/доставка). Эти промокоды <b>не создают карт лояльности</b> — реальная база карт и чеки по ним показаны ниже («какими акциями реально пользуются» и «виды дисконтных карт»).</div>';
  } else {
    html+='<div style="font-size:12px;color:var(--muted)">Действующих акций в справочнике «Акции» на сегодня нет.</div>';
  }
  // Топ акций по реальному использованию (включая завершённые и регистрационные —
  // показывает, какие механики реально работают на кассе)
  var activeNames={};
  promos.forEach(function(p){ activeNames[p.name]=1; });
  var others=usage.filter(function(u){ return !activeNames[u.name] && (u.cheques>0 || u.orders>0); }).slice(0,12);
  if(others.length){
    html+='<div class="mkt-chart-t" style="margin-top:12px">Какими акциями реально пользуются'+(pu.period?' ('+pu.period+')':'')+'</div>'+
      '<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Акция</th>'+usageHead+'</tr></thead><tbody>'+
      others.map(function(u){ return '<tr><td>'+u.name+'</td>'+usageCells(u)+'</tr>'; }).join('')+
      '</tbody></table></div>'+
      '<div style="font-size:11px;color:var(--muted);margin-top:4px">«РЕГИСТРАЦИЯ …» — выдача виртуальных карт при регистрации на точке. Выручка = сумма чеков и заказов, где применялась акция.</div>';
  }
  // Виды дисконтных карт — отдельная механика лояльности (скидка по виду карты, без акции).
  var kinds=pu.byCardKind||[];
  if(kinds.length){
    html+='<div class="mkt-chart-t" style="margin-top:12px">Виды дисконтных карт — применение'+(pu.period?' ('+pu.period+')':'')+'</div>'+
      '<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Вид карты</th><th class="num" title="Карт этого вида в базе (за всё время)">Карт в базе</th><th class="num" title="Уникальных карт, по которым были чеки за выбранный месяц">Покупали</th><th class="num" title="Чеков по картам этого вида за месяц">Чеков</th><th class="num" title="Выручка этих чеков">Выручка</th><th class="num" title="Скидок выдано по условию «По виду дисконтных карт» за месяц">Скидок выдано</th></tr></thead><tbody>'+
      kinds.map(function(u){
        return '<tr><td>'+u.kind+'</td><td class="num">'+mNum(u.cardsTotal||0)+'</td><td class="num">'+mNum(u.cardsActive||0)+'</td><td class="num">'+mNum(u.cheques||0)+'</td><td class="num">'+(u.revenue?mNum(u.revenue)+' ₽':'—')+'</td><td class="num">'+(u.discount?mNum(u.discount)+' ₽':'—')+'</td></tr>';
      }).join('')+
      '</tbody></table></div>'+
      '<div style="font-size:11px;color:var(--muted);margin-top:4px">Это механика «скидка по виду карты», БЕЗ акции — поэтому, например, акция «Промокод ОФИС» выше пуста, а реальная офисная программа живёт здесь (вид «Офис»). У «Карты Любимого покупателя» скидки идут по другим условиям (порог суммы, ДР) — в колонке только скидки именно «по виду карты».</div>';
  }
  html+='<div style="font-size:11px;color:var(--muted);margin-top:8px">Не хранится в 1С (поэтому не показываем): визиты/звонки/маршруты Яндекс.Карт, онлайн-заказы сайта, клики по телефону, переходы к партнёрам — нужны кабинет Я.Бизнес и цели в Метрике.</div>';
  el.innerHTML=html;
}
// «Сладкий чек» — детализация из 1С (/api/marketing/sweet-detail): всего участников,
// пришло за месяц, текущие задания, покупки участников за период действия.
var _MM_SWEET=['','января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
function smMonth(ym){ if(!ym) return ''; var p=ym.split('-'); return _MM_SWEET[Number(p[1])]+' '+p[0]; }
function renderSweetDetail(sd){
  var el=document.getElementById('mktSweetLive'); if(!el) return;
  if(!sd || sd.available===false){ return; } // оставляем быстрый рендер из d.sweet, если детализация недоступна
  var tasks=(sd.tasks||[]).slice();
  var totalEv=tasks.reduce(function(s,t){return s+t.events;},0)||1;
  var pur=sd.purchases||{};
  var kpi=function(v,l){ return '<div class="mkt-kpi"><div class="mkt-v">'+v+'</div><div class="mkt-l">'+l+'</div></div>'; };
  el.innerHTML='<div class="mkt-chart-t">«Сладкий чек» — live из 1С (РегистрНакопления.СладкийЧек)</div>'+
    '<div style="font-size:11px;color:var(--muted);margin:2px 0 8px">Геймификация: баллы за задания по картам лояльности. Программа действует с '+smMonth(sd.programStartMonth)+'.</div>'+
    '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:8px 0">'+
      kpi('<b>'+mNum(sd.totalParticipants||0)+'</b>','Всего участников')+
      kpi('+'+mNum(sd.newThisMonth||0),'Пришло за '+(sd.monthName||smMonth(sd.period)))+
      kpi(mNum(sd.monthCards||0),'Карт в заданиях (мес)')+
      kpi(mNum(sd.monthEvents||0),'Выполнений (мес)')+
      kpi(mNum(sd.monthPoints||0),'Баллов (мес)')+
    '</div>'+
    '<div class="mkt-comp-ins" style="margin:8px 0;background:#eafaf0;border:1px solid #b6e3c8;color:#0a6b3a;padding:8px 10px;border-radius:6px">'+
      '<b>Участники купили продукции на '+mNum(pur.net||0)+' ₽</b> за период действия (с '+smMonth(pur.since)+'): '+mNum(pur.cheques||0)+' чеков, '+mNum(pur.cards||0)+' карт'+
      (pur.returns?' · возвраты −'+mNum(pur.returns)+' ₽':'')+'.</div>'+
    '<div class="mkt-chart-t" style="margin-top:10px">Текущие задания за '+(sd.monthName||smMonth(sd.period))+'</div>'+
    (tasks.length?'<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Задание</th><th class="num">Выполнений</th><th class="num">Карт</th><th class="num">Баллов</th><th class="num">Доля</th></tr></thead><tbody>'+
      tasks.map(function(t){ var pct=t.events/totalEv*100; return '<tr><td>'+t.name+'</td><td class="num">'+mNum(t.events)+'</td><td class="num">'+mNum(t.cards)+'</td><td class="num">'+mNum(t.points)+'</td><td class="num">'+mNum1(pct)+' %</td></tr>'; }).join('')+
      '</tbody></table></div>':'<div style="font-size:12px;color:var(--muted)">Заданий в этом месяце не было.</div>');
}
var _mktInited=false;
// Какой период реально загружен в маркетинг-блоки (для ресинка после metadata).
var _mktLoadedPeriod=null;
// Последние live-данные для CSV-экспорта (channels / sms-attribution / paid-costs).
var _mktLive=null, _mktSms=null, _mktPaid=null;
function mktInit(){
  var fromEl=document.getElementById('mktFrom'), toEl=document.getElementById('mktTo');
  if(!fromEl||!toEl) return;
  if(!_mktInited){
    var opts = MKT.months.map(function(m,i){ return '<option value="'+i+'">'+m.replace('*','')+'</option>'; }).join('');
    fromEl.innerHTML=opts; toEl.innerHTML=opts; fromEl.value='0'; toEl.value=String(MKT.months.length-1);
    fromEl.addEventListener('change', function(){ mktRender(); mktLoadYoY(); });
    toEl.addEventListener('change', function(){ mktRender(); mktLoadYoY(); });
    var eb=document.getElementById('mktExportBtn'); if(eb) eb.addEventListener('click', mktExport);
    renderCompetitors();
    renderSocial();
    mktRenderProducts();
    renderPrices();
    renderAlerts();
    loadCampaignAudiences();
    renderFunnel();
    renderDemand();
    renderAI();
    initMarketingTabs();
    switchMarketingGroup(analyticsState.marketingGroup);
    var seo=document.getElementById('mktSeo');
    if(seo) seo.innerHTML = '<div style="font-size:12px;color:var(--muted)">Источники трафика рендерятся ниже live из Метрики (counter 43949414).</div>';
    _mktInited=true;
  }
  mktRender();
  mktLoadYoY();
}
// Живой YoY-блок: тянет /api/marketing/channels за выбранный месяц (1С + год назад).
// Период берём ГЛОБАЛЬНЫЙ — селектор «ПЕРИОД» слева в сайдбаре (state.period),
// тот же, что рулит Дашбордом и Аналитикой. Свой диапазон-селектор маркетинга убран.
function mktSelectedPeriod(){
  // Фоллбэк — ТЕКУЩИЙ календарный месяц, не хардкод MKT.months (давал вечный
  // 2026-05 при гонке «маркетинг-таб открыт раньше, чем пришла metadata»).
  if(state.period) return state.period;
  var now=new Date();
  return now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
}
function mktDeltaBadge(v, unit){
  if(v===null||v===undefined) return '<span class="mkt-yoy-d mkt-yoy-na">нет базы</span>';
  var cls = v>0 ? 'mkt-yoy-up' : (v<0 ? 'mkt-yoy-down' : 'mkt-yoy-flat');
  var sign = v>0?'+':'';
  return '<span class="mkt-yoy-d '+cls+'">'+sign+mNum1(v)+(unit||' %')+' YoY</span>';
}
function mktYoYCard(label, curStr, prevStr, delta, unit){
  return '<div class="mkt-yoy-card"><div class="mkt-yoy-l">'+label+'</div>'+
    '<div class="mkt-yoy-v">'+curStr+'</div>'+
    '<div class="mkt-yoy-p">год назад: '+prevStr+'</div>'+
    mktDeltaBadge(delta, unit)+'</div>';
}
function mktLoadYoY(){
  var el=document.getElementById('mktYoY'); if(!el) return;
  var period=mktSelectedPeriod();
  _mktLoadedPeriod=period;
  var echo=document.getElementById('mktPeriodEcho'); if(echo) echo.textContent=period;
  el.innerHTML='<div class="mkt-yoy-load">Загрузка из 1С…</div>';
  fetchJson('/api/marketing/channels?period='+period).then(function(d){
    if(!d || d.error){
      var msg='<div class="mkt-yoy-load">Нет данных за период: '+((d&&d.error)||'ошибка')+'</div>';
      el.innerHTML=msg; return;
    }
    var rub=function(n){return mNum(n)+' ₽';};
    // Верхние KPI-карточки удалены — блок YoY ниже даёт те же метрики + сравнение с прошлым годом.
    var cards=[
      mktYoYCard('Выручка', rub(d.revenue.cur), rub(d.revenue.prev), d.revenue.deltaPct),
      mktYoYCard('Чеков', mNum(d.cheques.cur), mNum(d.cheques.prev), d.cheques.deltaPct),
      mktYoYCard('Средний чек', rub(d.avgCheck.cur), rub(d.avgCheck.prev), d.avgCheck.deltaPct),
      mktYoYCard('Карта лояльности', mNum1(d.cardPct.cur)+' %', mNum1(d.cardPct.prev)+' %', d.cardPct.deltaPp, ' п.п.'),
      mktYoYCard('Оплачено бонусами', rub(d.bonus.cur), rub(d.bonus.prev), d.bonus.deltaPct),
      mktYoYCard('Сладкий чек', d.sweet.cur.cards+' карт · '+d.sweet.cur.points+' б.', (d.sweet.isNew?'программы не было':d.sweet.prev.cards+' карт'), d.sweet.isNew?null:0)
    ].join('');
    el.innerHTML='<div class="mkt-yoy-grid">'+cards+'</div>';
    // Алерты «на что обратить внимание» — живые из этих же данных за выбранный период.
    try { renderAlerts(d, period); } catch(_){}
    _mktLive=d; // для CSV-экспорта (live)
    // Продажи и лояльность помесячно — live (заменили статику янв–май).
    try { renderSalesMonthly(d); } catch(_){}
    // Я.Директ помесячно — live из кабинета (заменили статику).
    try { renderDirectMonthly(d); } catch(_){}
    // 2ГИС присутствие в выдаче помесячно — live из кабинета (заменили статику).
    try { renderGisMonthly(d); } catch(_){}
    // 2ГИС воронка действий + динамика-графики (показы/переходы по месяцам).
    try { renderGisFunnel(d); } catch(_){}
    try { renderGisCharts(d); } catch(_){}
    // Спрос (поисковые запросы 2ГИС) — live из секции demand (заменили снимок апреля).
    try { renderDemand(d); } catch(_){}
    // Воронка лояльности — реальная mini-воронка из Метрики+1С (заменили выдуманную).
    try { renderFunnel(d); } catch(_){}
    // Конкуренты — оверлей live-рейтингов 2ГИС (кабинет «Сравнение») на ресёрч-снимок.
    try { renderCompetitors(d); } catch(_){}
    // Прочие каналы — действующие акции + база лояльности, live из 1С.
    try { renderOtherChannels(d); } catch(_){}
    // Платные каналы — затраты + отдача (бюджет маркетинга), отдельный эндпоинт.
    var paidEl=document.getElementById('mktPaidLive');
    if(paidEl){
      paidEl.innerHTML='<div class="mkt-yoy-load">Считаю бюджет платных каналов…</div>';
      fetchJson('/api/marketing/paid-costs?period='+period).then(function(pc){ _mktPaid=pc; renderPaidCosts(pc); })
        .catch(function(e){ paidEl.innerHTML='<div style="font-size:12px;color:var(--muted)">Бюджет недоступен: '+e.message+'</div>'; });
    }
    // SMS-атрибуция за выбранный месяц — отдельный (тяжёлый ~9с, кэш 6ч) эндпоинт.
    var smsAttrEl=document.getElementById('mktSmsAttr');
    if(smsAttrEl){
      smsAttrEl.innerHTML='<div class="mkt-yoy-load">Считаю атрибуцию рассылок из 1С (~10 сек)…</div>';
      fetchJson('/api/marketing/sms-attribution?period='+period).then(function(sa){ _mktSms=sa; renderSmsAttribution(sa); })
        .catch(function(e){ smsAttrEl.innerHTML='<div style="font-size:12px;color:var(--muted)">Атрибуция недоступна: '+e.message+'</div>'; });
    }
    // SMS помесячно — обзор по месяцам (лёгкий: итоги из кэша sms-attribution + фон-прогрев).
    var smsMEl=document.getElementById('mktSmsMonthly');
    if(smsMEl){ smsMEl.innerHTML='<div class="mkt-yoy-load">Собираю помесячные итоги SMS…</div>';
      fetchJson('/api/marketing/sms-monthly?period='+period).then(function(sm){ renderSmsMonthly(sm); }).catch(function(){ smsMEl.innerHTML=''; });
    }
    // «Сладкий чек» — детализация (участники/пришло/задания/покупки) из 1С, отдельный эндпоинт (~5с).
    fetchJson('/api/marketing/sweet-detail?period='+period).then(function(sd){ try{ renderSweetDetail(sd); }catch(_){} }).catch(function(){});
    // Выпуск продукции в кг — отдельный эндпоинт (1С /query).
    var prodKgEl=document.getElementById('mktProdKgKpi');
    if(prodKgEl){
      prodKgEl.innerHTML='<div class="mkt-yoy-load">Загрузка выпуска из 1С…</div>';
      fetchJson('/api/analytics/production-kg?period='+period).then(function(pk){ renderProductionKg(pk); })
        .catch(function(e){ prodKgEl.innerHTML='<div style="font-size:12px;color:var(--muted)">Выпуск недоступен: '+e.message+'</div>'; });
    }
    // Валовая прибыль из 1С — реальная себестоимость (УчётЗатрат), отдельный эндпоинт (1С /query, кэш 6ч).
    var gpEl=document.getElementById('mktGrossProfit');
    if(gpEl){
      gpEl.innerHTML='<div class="mkt-yoy-load">Считаю валовую прибыль из 1С…</div>';
      fetchJson('/api/marketing/gross-profit?period='+period).then(function(gp){ try{ renderGrossProfit(gp); }catch(_){} })
        .catch(function(e){ gpEl.innerHTML='<div style="font-size:12px;color:var(--muted)">Недоступно: '+e.message+'</div>'; });
    }
    var hint=document.getElementById('mktYoYHint');
    if(hint){ var t=d.refreshedAt?new Date(d.refreshedAt).toLocaleString('ru-RU'):'—';
      // Для текущего месяца выручка/чеки/ср.чек берутся живыми из БД (curLive) — совпадают
      // с дашбордом, ежеминутно; «из кэша» относится только к YoY-сравнению и прошлым месяцам.
      var freshNote = d.curLive ? ' Выручка/чеки за текущий месяц — живые (ежеминутно, как на дашборде); сравнение с прошлым годом — из кэша.' : (d.fromCache?' (из кэша)':'');
      hint.innerHTML='Данные тянутся напрямую из 1С и обновляются на сервере сами (без ПК). '+d.monthName+' '+period.slice(0,4)+' vs '+d.periodYoY+'. Обновлено: '+t+(d.curLive?'.':'')+freshNote+(d.curLive?'':'.'); }
    // живые товары и категории за выбранный месяц (перекрывают статику)
    var tp=document.getElementById('mktTopProd');
    if(tp && d.topProducts && d.topProducts.length){ tp.innerHTML='<table><thead><tr><th>Товар</th><th class="num">Выручка ₽</th><th class="num">Шт</th></tr></thead><tbody>'+
      d.topProducts.map(function(r,i){ return '<tr><td>'+(i+1)+'. '+r.name+'</td><td class="num">'+mNum(r.revenue)+'</td><td class="num">'+mNum(r.qty)+'</td></tr>'; }).join('')+'</tbody></table>'; }
    var ct=document.getElementById('mktCats');
    if(ct && d.categories && d.categories.length){ ct.innerHTML='<table><thead><tr><th>Категория</th><th class="num">Выручка ₽</th><th class="num">Доля</th><th class="num">YoY</th></tr></thead><tbody>'+
      d.categories.map(function(r){ var dl=r.deltaPct; var ds=(dl==null?'—':(dl>0?'+':'')+mNum1(dl)+'%'); var dc=(dl==null?'':(dl>0?'color:#10a05a':(dl<0?'color:#e0466a':''))); return '<tr><td>'+r.group+'</td><td class="num">'+mNum(r.cur)+'</td><td class="num">'+mNum1(r.sharePct)+'%</td><td class="num" style="'+dc+'">'+ds+'</td></tr>'; }).join('')+'</tbody></table>'; }
    // Помесячные ряды + YoY на графиках динамики (1С данные).
    // 17 точек: с янв прошлого года до выбранного месяца. ps — те же точки минус год (для YoY).
    // Точки с _pending — 1С греется в фоне (~100с/мес). Их пока не рисуем, при следующем
    // обновлении страницы они появятся.
    if(d.monthlySeries && d.monthlySeries.cur && d.monthlySeries.cur.length){
      var rawCs=d.monthlySeries.cur, rawPs=d.monthlySeries.prev||[];
      var cs=[], ps=[];
      for(var ii=0;ii<rawCs.length;ii++){
        if(rawCs[ii]._pending) continue;
        cs.push(rawCs[ii]);
        ps.push(rawPs[ii]&&!rawPs[ii]._pending ? rawPs[ii] : { revenue:0, cheques:0, avgCheck:0, cardPct:0 });
      }
      // Если все pending — рисуем плейсхолдер вместо пустоты
      if(!cs.length){
        ['mktChartRev','mktChartCheq','mktChartAvg','mktChartCard'].forEach(function(id){
          var el=document.getElementById(id); if(el) el.innerHTML='<div style="padding:30px;text-align:center;color:var(--muted);font-size:12px">Данные янв 2025–май 2026 прогреваются из 1С (~5 мин на месяц). Обнови страницу через несколько минут.</div>';
        });
        return;
      }
      var pendingCount=rawCs.filter(function(m){return m._pending;}).length;
      if(pendingCount){
        var hint=document.getElementById('mktYoYHint');
        if(hint) hint.innerHTML+=' <span style="color:#b8860b">· '+pendingCount+' мес. ещё прогреваются из 1С</span>';
      }
      var MM=['','Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
      // Метка: «25-Янв» (год'-месяц) — для расширенного окна 17 месяцев
      var lbls=cs.map(function(m){ var p=m.ym.split('-'); return p[0].slice(2)+'-'+MM[Number(p[1])]; });
      function sumK(arr,k){ return arr.reduce(function(a,c){return a+(c[k]||0);},0); }
      function setT(id, label, cV, pV, isPp){
        var el=document.getElementById(id); if(!el) return;
        var dl=null, ds='';
        if(isPp){ dl=Math.round((cV-pV)*10)/10; ds=' · YoY '+(dl>=0?'+':'')+mNum1(dl)+' п.п.'; }
        else { dl=pV?Math.round((cV-pV)/pV*1000)/10:null; ds=dl==null?'':' · YoY '+(dl>0?'+':'')+mNum1(dl)+'%'; }
        var dc=dl==null?'':(dl>0?'color:#10a05a':(dl<0?'color:#e0466a':''));
        el.innerHTML=label+' <span style="font-size:11px;font-weight:600;'+dc+'">'+ds+'</span>';
      }
      var cRev=sumK(cs,'revenue'), pRev=sumK(ps,'revenue');
      var cChq=sumK(cs,'cheques'), pChq=sumK(ps,'cheques');
      var cAvg=cChq?cRev/cChq:0, pAvg=pChq?pRev/pChq:0;
      var cCardW=cChq?cs.reduce(function(a,c){return a+c.cardPct*c.cheques;},0)/cChq:0;
      var pCardW=pChq?ps.reduce(function(a,c){return a+c.cardPct*c.cheques;},0)/pChq:0;
      setT('mktChartRevT','Выручка, ₽', cRev, pRev);
      setT('mktChartCheqT','Чеков, шт', cChq, pChq);
      setT('mktChartAvgT','Средний чек, ₽', cAvg, pAvg);
      setT('mktChartCardT','Карта лояльности, %', cCardW, pCardW, true);
      var leg=document.getElementById('mktChartRevLeg');
      if(leg){ leg.innerHTML='<span class="mkt-lg"><i style="background:var(--accent)"></i>факт месяца</span><span class="mkt-lg"><i style="background:#b8860b"></i>год назад (YoY)</span>'; }
      mGroup('mktChartRev', lbls, cs.map(function(m){return m.revenue;}), ps.map(function(m){return m.revenue;}), 'var(--accent)', '#b8860b', ' ₽');
      mGroup('mktChartCheq', lbls, cs.map(function(m){return m.cheques;}), ps.map(function(m){return m.cheques;}), 'var(--accent)', '#b8860b', ' шт');
      mGroup('mktChartAvg', lbls, cs.map(function(m){return m.avgCheck;}), ps.map(function(m){return m.avgCheck;}), 'var(--accent)', '#b8860b', ' ₽');
      mGroup('mktChartCard', lbls, cs.map(function(m){return m.cardPct;}), ps.map(function(m){return m.cardPct;}), 'var(--accent)', '#b8860b', ' %');
    }
    // Партнёры (Bitrix iblock 88) — список с UTM-метками
    if (d.external && d.external.partners) {
      var pj = d.external.partners;
      var pEl = document.getElementById('mktPartners');
      var pHint = document.getElementById('mktPartnersHint');
      if (pEl && pj.partners) {
        var rows = pj.partners.map(function(pr){
          var url = pr.targetUrl || (pr.props ? Object.values(pr.props).find(function(v){return /^\s*https?:\/\//.test(v);}) : '');
          if (url) url = url.trim().replace(/&amp;/g, '&');
          var clean = url ? url.split('?')[0] : '';
          var utm = url && url.includes('?') ? url.split('?')[1] : '';
          // короткий парс UTM
          var utmObj = {};
          (utm||'').split('&').forEach(function(p){ var kv = p.split('='); if (kv[0]) utmObj[kv[0]] = decodeURIComponent(kv[1]||''); });
          var utmTags = ['utm_source','utm_medium','utm_campaign'].map(function(k){ return utmObj[k] ? '<span style="font-size:10px;background:#eaeaea;padding:2px 6px;border-radius:3px;margin-right:4px">'+k.replace('utm_','')+': '+utmObj[k].slice(0,20)+'</span>' : ''; }).join('');
          var clicks = pr.metrikaClicks != null ? mNum(pr.metrikaClicks) : '<span style="color:var(--muted)">—</span>';
          var ac = pr.active === false ? 'color:#e0466a' : '';
          return '<tr><td><b style="'+ac+'">'+pr.name+'</b></td><td style="font-size:11px"><a href="'+url+'" target="_blank" style="color:#0066cc">'+(clean||'').replace(/^https?:\/\/(www\.)?/,'').slice(0,40)+'</a></td><td style="font-size:11px">'+(utmTags||'<span style="color:var(--muted)">без UTM</span>')+'</td><td class="num">'+clicks+'</td><td style="font-size:11px;color:'+(pr.active===false?'#e0466a':'#10a05a')+'">'+(pr.active===false?'выкл':'актив')+'</td></tr>';
        }).join('');
        pEl.innerHTML = '<table style="font-size:12px"><thead><tr><th>Партнёр</th><th>Ссылка</th><th>UTM</th><th class="num">Переходов</th><th>Статус</th></tr></thead><tbody>'+rows+'</tbody></table>';
      }
      if (pHint) {
        var active = (pj.partners||[]).filter(function(p){return p.active!==false;}).length;
        var withClicks = (pj.partners||[]).filter(function(p){return (p.metrikaClicks||0)>0;}).length;
        var totalClicks = (pj.partners||[]).reduce(function(s,p){return s+(p.metrikaClicks||0);},0);
        var clicksUpd = pj.metrikaClicksUpdatedAt ? new Date(pj.metrikaClicksUpdatedAt).toLocaleString('ru-RU') : null;
        var trackNote = clicksUpd
          ? '<div style="margin-top:10px;font-size:12px;background:#eafaf0;padding:8px 10px;border-radius:6px;border:1px solid #b6e6c9;color:#0a6b3a">✓ <b>Трекинг переходов включён.</b> Цель <code>partner_click</code> в Метрике + JS на сайте; клики копятся и матчатся к партнёру по домену ссылки. Сейчас: <b>'+mNum(totalClicks)+'</b> переходов у <b>'+withClicks+'</b> партнёров за '+(pj.metrikaClicksPeriod||'последние 30 дней')+'. Обновляется ежедневно (скрейп Метрики). Данные '+clicksUpd+'.</div>'
          : '<div style="margin-top:10px;font-size:12px;color:var(--muted)">Переходы появятся после ближайшего скрейпа Метрики.</div>';
        pHint.innerHTML = 'Всего <b>'+pj.total+'</b> партнёров · активных <b>'+active+'</b>. Источник: Bitrix CMS iblock 88 (список от '+(pj.scrapedAt?new Date(pj.scrapedAt).toLocaleDateString('ru-RU'):'?')+')'+(pj.metrikaClicksUpdatedAt?' · переходы из Метрики обновлены '+new Date(pj.metrikaClicksUpdatedAt).toLocaleString('ru-RU')+(pj.metrikaClicksPeriod?' (окно: '+pj.metrikaClicksPeriod+')':''):'')+'.' + trackNote;
      }
    }

    // Блогеры (из Google Sheets через bloggers.json) — KPI считаем КЛИЕНТСКИ из очищенных
    // строк (серверный summary.total включает строку-заголовок из таблицы → +1). var-имена
    // уникальные (bl*) — этот .then одна function-scope, не затенять внешние.
    if (d.external && d.external.bloggers) {
      var bj = d.external.bloggers;
      var bloggersKpiEl = document.getElementById('mktBloggersKpi');
      var blTblEl = document.getElementById('mktBloggers');
      var blHintEl = document.getElementById('mktBloggersHint');
      // Отсев строки-заголовка таблицы Google Sheets («Адрес»/«забрали карту»/«Выложено»/«Статистика»)
      // и пустых строк без хэндла.
      var blIsHeader = function(b){
        if(!b || !b.handle) return true;
        if(/^блоегр|^блогер$/i.test(String(b.handle).trim())) return true;
        if(b.pickupAddress==='Адрес' || b.pickupDate==='забрали карту' || b.posted==='Выложено' || b.stats==='Статистика') return true;
        return false;
      };
      var blRows = (bj.bloggers||[]).filter(function(b){return !blIsHeader(b);});
      var blPosted = function(b){ return /сторис|рилс|reels|пост|выложил/i.test(String(b.posted||'')); };
      var blPicked = function(b){ var p=String(b.pickupDate||''); return p && !/не\s*забрал/i.test(p); };
      // Агрегаты
      var blTotal = blRows.length;
      var blSubs = blRows.reduce(function(s,b){return s+(b.subscribers||0);},0);
      var blDep = blRows.reduce(function(s,b){return s+(b.depositRub||0);},0);
      var blPostedN = blRows.filter(blPosted).length;
      var blPickedN = blRows.filter(blPicked).length;
      // Взяли карту (депозит), но не выложили → потраченные впустую ₽
      var blWasted = blRows.filter(function(b){return blPicked(b) && !blPosted(b) && (b.depositRub||0)>0;});
      var blWastedSum = blWasted.reduce(function(s,b){return s+(b.depositRub||0);},0);
      var blClickers = blRows.filter(function(b){return (b.clicks||0)>0;});
      var blClicks = blClickers.reduce(function(s,b){return s+(b.clicks||0);},0);
      var blClickDep = blClickers.reduce(function(s,b){return s+(b.depositRub||0);},0);
      var blCpc = blClicks ? Math.round(blClickDep/blClicks) : 0;
      var blPostRate = blTotal ? Math.round(blPostedN/blTotal*1000)/10 : 0;
      if (bloggersKpiEl) {
        bloggersKpiEl.innerHTML = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px">'+
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(blTotal)+'</div><div class="mkt-l">Блогеров в работе</div></div>'+
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(blSubs)+'</div><div class="mkt-l">Совокупная аудитория</div></div>'+
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(blDep)+' ₽</div><div class="mkt-l">Депозит выдано</div></div>'+
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(blPostedN)+' · '+mNum1(blPostRate)+' %</div><div class="mkt-l">Выложили (сторис/рилс)</div></div>'+
          '</div>'+
          '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px">'+
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(blPickedN)+' / '+mNum(blTotal)+'</div><div class="mkt-l">Забрали карту</div></div>'+
          '<div class="mkt-kpi"><div class="mkt-v" style="'+(blWasted.length?'color:#e0466a':'')+'">'+mNum(blWasted.length)+' · '+mNum(blWastedSum)+' ₽</div><div class="mkt-l">Взяли, но не выложили (впустую)</div></div>'+
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(blClicks)+'</div><div class="mkt-l">Переходов к нам (из '+mNum(blClickers.length)+' с метрикой)</div></div>'+
          '<div class="mkt-kpi"><div class="mkt-v">'+(blCpc?mNum(blCpc)+' ₽':'—')+'</div><div class="mkt-l">CPC (депозит ÷ переходы, по замеренным)</div></div>'+
          '</div>';
      }
      if (blTblEl) {
        var blSorted = blRows.slice().sort(function(a,b){return (b.subscribers||0)-(a.subscribers||0);});
        blTblEl.innerHTML = '<table style="font-size:12px"><thead><tr><th>Блогер</th><th class="num">Подписчиков</th><th class="num">Депозит ₽</th><th>Точка выдачи</th><th>Забрали</th><th>Выложено</th><th class="num">Переходов</th><th>Комментарий</th></tr></thead><tbody>'+
          blSorted.map(function(b){
            var subs = b.subscribers ? mNum(b.subscribers) : '<span style="color:var(--muted)">?</span>';
            var dep = b.depositRub ? mNum(b.depositRub) : '—';
            var pickup = (b.pickupDate||'').slice(0,30);
            var pickC = /не\s*забрал/i.test(pickup) ? 'color:#e0466a' : '';
            var posted = (b.posted||'').slice(0,30);
            var didPost = blPosted(b);
            var postC = didPost ? 'color:#10a05a' : 'color:var(--muted)';
            // подсветка строки: взял депозит и не выложил
            var rowBg = (blPicked(b) && !didPost && (b.depositRub||0)>0) ? ' style="background:rgba(224,70,106,.07)"' : '';
            var cl = b.clicks!=null ? mNum(b.clicks) : '<span style="color:var(--muted)">—</span>';
            var notes = (b.notes||'').slice(0,50);
            return '<tr'+rowBg+'><td><b>'+b.handle+'</b></td><td class="num">'+subs+'</td><td class="num">'+dep+'</td><td style="font-size:11px">'+(b.pickupAddress||'').slice(0,30)+'</td><td style="font-size:11px;'+pickC+'">'+pickup+'</td><td style="font-size:11px;'+postC+'">'+(posted||(didPost?'':'<span style="color:#e0466a">не выложил</span>'))+'</td><td class="num">'+cl+'</td><td style="font-size:11px;color:var(--muted)">'+notes+'</td></tr>';
          }).join('')+'</tbody></table>';
      }
      if (blHintEl) {
        blHintEl.innerHTML = 'Источник: '+(bj.url?'<a href="'+bj.url+'" target="_blank">Google Sheets</a>':'таблица')+' (ручная таблица). Обновлено: '+(bj.scrapedAt?new Date(bj.scrapedAt).toLocaleString('ru-RU'):'?')+'. Розовым — взяли карту/депозит, но не выложили сторис. «Переходов» — из текста колонки «Статистика» (где есть число); CPC считается только по блогерам с замеренными переходами.';
      }
    }

    // Сладкий чек — live разбивка по заданиям для текущего периода (d.sweet.cur.tasks)
    if (d.sweet && d.sweet.cur) {
      var swEl = document.getElementById('mktSweetLive');
      if (swEl) {
        var sc = d.sweet.cur, sp = d.sweet.prev || {};
        var tasks = sc.tasks || {};
        var tasksArr = Object.entries(tasks).map(function(e){ return { name:e[0], events: typeof e[1]==='object'?(e[1].events||0):e[1], points: typeof e[1]==='object'?(e[1].points||0):0 }; }).sort(function(a,b){return b.events-a.events;});
        var totalEv = tasksArr.reduce(function(s,t){return s+t.events;},0) || 1;
        swEl.innerHTML = '<div class="mkt-chart-t">Live за '+(d.monthName||'')+' — задания (из регистра СладкийЧек)</div>' +
          '<div style="font-size:11px;color:var(--muted);margin:2px 0 8px">«Сладкий чек» — отдельная геймификация (баллы за задания), а не общая программа лояльности. Карты ниже — только участники заданий за месяц, не все держатели бонусных карт (их доля — в таблице «Чеков с картой» ниже).</div>'+
          '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:8px 0">'+
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(sc.cards||0)+'</div><div class="mkt-l">Карт в заданиях</div></div>'+
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(sc.events||0)+'</div><div class="mkt-l">Выполнений заданий</div></div>'+
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(sc.points||0)+'</div><div class="mkt-l">Баллов начислено</div></div>'+
          '<div class="mkt-kpi"><div class="mkt-v">'+(sp.cards?mNum(sp.cards):'—')+'</div><div class="mkt-l">Карт год назад</div></div>'+
          '</div>'+
          (tasksArr.length?'<div class="table-wrap"><table><thead><tr><th>Задание</th><th class="num">Выполнений</th><th class="num">Доля</th></tr></thead><tbody>'+
            tasksArr.map(function(t){ var pct=t.events/totalEv*100; var pc=pct>=50?'color:#e0466a':(pct>=20?'color:#b8860b':''); return '<tr><td>'+t.name+'</td><td class="num">'+mNum(t.events)+'</td><td class="num" style="'+pc+'">'+mNum1(pct)+' %</td></tr>'; }).join('')+
            '</tbody></table></div>':
            '<div style="font-size:12px;color:var(--muted)">Заданий не было.</div>');
      }
    }
    // Последние UDS-применения (recentApplications с датой/чеком/суммой) — отдельный fetch
    fetchJson('/api/analytics/uds-promocodes?to='+period).then(function(uds){
      if(!uds || !uds.recentApplications) return;
      var el=document.getElementById('mktPromoFresh');
      if(!el) return;
      var rate = uds.totalChecksScanned ? (uds.checksWithPromocode/uds.totalChecksScanned*100) : 0;
      var rateC = rate < 2 ? 'color:#e0466a' : (rate < 5 ? 'color:#b8860b' : 'color:#10a05a');
      el.innerHTML = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px">'+
        '<div class="mkt-kpi"><div class="mkt-v">'+mNum(uds.totalChecksScanned)+'</div><div class="mkt-l">Чеков просмотрено</div></div>'+
        '<div class="mkt-kpi"><div class="mkt-v">'+mNum(uds.checksWithPromocode)+'</div><div class="mkt-l">С промокодом</div></div>'+
        '<div class="mkt-kpi"><div class="mkt-v" style="'+rateC+'">'+mNum1(rate)+' %</div><div class="mkt-l">Доля чеков с промо</div></div>'+
        '<div class="mkt-kpi"><div class="mkt-v">'+mNum(uds.uniqueCodes)+'</div><div class="mkt-l">Уникальных кодов</div></div>'+
        '</div>'+
        '<div class="mkt-chart-t">Последние '+(uds.recentApplications||[]).length+' применений (свежее наверху)</div>'+
        '<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Дата</th><th>Промокод</th><th>Чек №</th><th class="num">Сумма ₽</th><th>Точка</th></tr></thead><tbody>'+
        (uds.recentApplications||[]).slice(0,40).map(function(r){
          return '<tr><td style="font-size:11px">'+(r.date||'')+'</td><td><b>'+r.code+'</b></td><td style="font-size:11px;color:var(--muted)">'+(r.docNumber||'—')+'</td><td class="num">'+mNum(r.sum)+'</td><td style="font-size:11px;color:var(--muted)">'+((r.store||'—')+'').slice(0,30)+'</td></tr>';
        }).join('')+'</tbody></table></div>'+
        '<div style="font-size:11px;color:var(--muted);margin-top:6px">За '+(uds.periodYM||period)+' · выручка чеков с промокодом '+mNum(uds.revenue||0)+' ₽ · бонусов списано '+mNum(uds.bonusUsed||0)+' ₽ (ДРР '+mNum1(uds.drr||0)+' %).'+(uds.truncatedNote?' '+uds.truncatedNote:'')+'</div>';
    }).catch(function(){});

    // Промокоды UDS — помесячная матрица.
    fetchJson('/api/analytics/promo-codes-monthly?period='+period).then(function(pc){
      if(!pc||!pc.available) return;
      var el=document.getElementById('mktPromoCodes'); var hint=document.getElementById('mktPromoCodesHint');
      if(!el) return;
      var MM4=['','Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
      var months=pc.months||[];
      var codes=pc.codes||[];
      if(!codes.length){
        el.innerHTML='<div style="padding:30px;text-align:center;color:var(--muted);font-size:12px">Чеки с промокодами прогреваются из 1С (~5 мин/мес × '+(months.length||17)+' мес). Обнови страницу позже.</div>';
        if(hint) hint.textContent='Прогрев фоном · '+(pc.monthsPending||0)+' мес. в очереди';
        return;
      }
      // компактные ярлыки месяцев в шапку
      var monthLbls=months.map(function(ym){ var p=ym.split('-'); return p[0].slice(2)+'-'+MM4[Number(p[1])]; });
      // Заголовок: Код | Применений | Выручка | Ср.чек | Бонусы списано | ДРР% | <месяц1>...
      var thead='<tr><th>Промокод</th><th class="num">Прим.</th><th class="num">Выручка, ₽</th><th class="num">Ср.чек, ₽</th><th class="num">Бонусы списано, ₽</th><th class="num">ДРР %</th>'+
        monthLbls.map(function(l){return '<th class="num" style="font-size:10px;writing-mode:vertical-rl;transform:rotate(180deg);height:60px">'+l+'</th>';}).join('')+'</tr>';
      var tbody=codes.slice(0,30).map(function(c){
        var monthCells=months.map(function(ym){
          var m=c.byMonth[ym];
          if(!m||!m.revenue) return '<td class="num" style="color:var(--muted);font-size:11px">—</td>';
          var ttl=m.uses+' исп. · '+mNum(m.revenue)+' ₽'+(m.bonusUsed?' · бонусы '+mNum(m.bonusUsed):'');
          return '<td class="num" title="'+ttl+'">'+mNum(m.revenue)+'</td>';
        }).join('');
        var drrC=c.drrPct>=20?'color:#e0466a':(c.drrPct>=10?'color:#b8860b':'');
        return '<tr><td><b>'+c.code+'</b></td><td class="num">'+mNum(c.totalUses)+'</td><td class="num">'+mNum(c.totalRevenue)+'</td><td class="num">'+mNum(c.avgTicket)+'</td><td class="num">'+(c.totalBonusUsed?mNum(c.totalBonusUsed):'<span style="color:var(--muted)">—</span>')+'</td><td class="num" style="'+drrC+'">'+(c.totalBonusUsed?mNum1(c.drrPct)+' %':'—')+'</td>'+monthCells+'</tr>';
      }).join('');
      el.innerHTML='<table style="font-size:12px"><thead>'+thead+'</thead><tbody>'+tbody+'</tbody></table>';
      if(hint){
        var pending=pc.monthsPending||0;
        var sumBon=pc.summary.totalBonusUsed||0;
        var sumRev=pc.summary.totalRevenue||0;
        var avgDrr=sumRev?Math.round(sumBon/sumRev*1000)/10:0;
        hint.innerHTML='Топ-30 кодов по выручке. Всего <b>'+pc.totalCodes+'</b> уникальных кодов · применений <b>'+mNum(pc.summary.totalUses)+'</b> · выручка <b>'+mNum(sumRev)+' ₽</b> · бонусов списано <b>'+mNum(sumBon)+' ₽</b> (ДРР ~'+mNum1(avgDrr)+' %).'+(pending?' · '+pending+' мес. ещё прогреваются':'')+'<br><span style="opacity:.7">'+(pc.note||'')+'</span>';
      }
    }).catch(function(){});

    // Торт месяца — авто-определение торта-флагмана каждого месяца.
    fetchJson('/api/analytics/cake-of-month?period='+period).then(function(cm){
      if(!cm||!cm.available||!cm.series) return;
      var el=document.getElementById('mktCake'); var hint=document.getElementById('mktCakeHint');
      if(!el) return;
      var MM3=['','Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
      var ready=cm.series.filter(function(s){return s.name || s.noFlagman || s.error;});
      if(!ready.length){
        el.innerHTML='<div style="padding:30px;text-align:center;color:var(--muted);font-size:12px">Скидки по месяцам считаются из 1С. Обнови страницу через минуту.</div>';
        if(hint) hint.textContent='Загрузка скидок из 1С…';
        return;
      }
      var selYM=mktSelectedPeriod();
      var hlRow=function(ym){ return ym===selYM?' style="background:rgba(124,92,255,.10);box-shadow:inset 3px 0 0 #7c5cff"':''; };
      el.innerHTML='<table><thead><tr><th>Месяц</th><th>Торт месяца (акция)</th><th class="num">Скидка</th><th class="num">Скидок выдано ₽</th><th class="num">Дней акции</th><th class="num">Выручка ₽</th><th class="num" title="Продано в килограммах (целый торт продаётся весовым)">Продано, кг</th><th class="num" title="≈ штук = килограммы ÷ вес одного торта (оценка)">≈ шт</th><th class="num">Доля в тортах</th></tr></thead><tbody>'+
        ready.slice().reverse().map(function(s){
          var p=s.ym.split('-'); var lbl=p[0].slice(2)+'-'+MM3[Number(p[1])];
          if(s.error){
            return '<tr><td>'+lbl+'</td><td colspan="8" style="color:var(--muted);font-size:11px">⚠ '+s.error+'</td></tr>';
          }
          if(s.noFlagman){
            return '<tr><td>'+lbl+'</td><td colspan="8" style="color:var(--muted);font-size:11px">— месячной скидки на торт не было</td></tr>';
          }
          var nm='<b>'+s.name+'</b>'+(s.partialMonth?' <span style="color:var(--muted);font-size:10px">(месяц идёт)</span>':'');
          var pctCell = s.discountPct!=null
            ? '<td class="num" style="color:#e0466a;font-weight:600" title="Эффективная скидка: скидки ÷ полная цена (скидки + выручка). Номинал акции обычно круглый: ~'+Math.round(s.discountPct/5)*5+'%">−'+mNum1(s.discountPct)+' %</td>'
            : '<td class="num" style="color:var(--muted)">—</td>';
          var kgVal = (s.kg!=null?s.kg:s.qty);
          var unitsCell = s.units!=null ? mNum(s.units) : '<span style="color:var(--muted)">—</span>';
          var sales = s.salesPending
            ? '<td colspan="4" style="color:var(--muted);font-size:11px;text-align:center">продажи прогреваются…</td>'
            : '<td class="num">'+mNum(s.revenue)+'</td><td class="num">'+mNum(kgVal)+'</td><td class="num">'+unitsCell+'</td><td class="num">'+(s.sharePct!=null?mNum1(s.sharePct)+' %':'—')+'</td>';
          return '<tr'+hlRow(s.ym)+'><td>'+lbl+'</td><td>'+nm+'</td>'+pctCell+'<td class="num">'+mNum(s.discount)+'</td><td class="num">'+mNum(s.discountDays)+'</td>'+sales+'</tr>';
        }).join('')+'</tbody></table>';
      if(hint){
        var pending=cm.seriesPending||0;
        hint.innerHTML='<b>Торт месяца — реальная акция</b>: на один торт в 1С встаёт скидка на весь месяц. Торт определяется по скидкам (РегистрНакопления.ПредоставленныеСкидки: топ по сумме, акция ≥15 дней; целый торт + кусочек). <b>Скидка</b> — эффективный % (скидки ÷ полная цена; номинал акции — ближайший круглый). «Скидок выдано» — сколько ₽ скидки ушло покупателям. <b>Продано, кг</b> — целый торт продаётся весовым, поэтому продажи в килограммах; <b>≈ шт</b> — оценка штук = кг ÷ вес одного торта (ф_ВесШтукивКг из 1С).'+(pending?' · продажи '+pending+' мес. ещё прогреваются из 1С':'');
      }
    }).catch(function(){});

    // Новые карты лояльности по месяцам — отдельный endpoint (тоже non-blocking).
    // 17 точек: с янв пред.года по выбранный. Бар = сколько НОВЫХ карт активировались впервые в этом месяце.
    fetchJson('/api/analytics/new-customers-monthly?period='+period).then(function(nc){
      if(!nc||!nc.available||!nc.series) return;
      var hint=document.getElementById('mktChartNewCustHint');
      var MM2=['','Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
      var ready=nc.series.filter(function(s){return !s._pending && s.newCards!=null;});
      if(!ready.length){
        var el=document.getElementById('mktChartNewCust');
        if(el) el.innerHTML='<div style="padding:30px;text-align:center;color:var(--muted);font-size:12px">Карты лояльности 2024–2026 прогреваются из 1С (~5 мин на месяц × 29 мес ≈ 2,5 ч). Обнови страницу через несколько минут — точки появятся.</div>';
        if(hint) hint.textContent='Прогревается из 1С (фоновый ~2,5 ч)';
        return;
      }
      var lbls2=ready.map(function(s){ var p=s.ym.split('-'); return p[0].slice(2)+'-'+MM2[Number(p[1])]; });
      mBars('mktChartNewCust', lbls2, ready.map(function(s){return s.newCards;}), 'var(--accent)', ' карт');
      if(hint){
        var pending=nc.seriesPending||0;
        var sum=ready.reduce(function(a,s){return a+s.newCards;},0);
        hint.textContent='Сумма по '+ready.length+' мес.: '+mNum(sum)+' новых карт. Baseline 12 мес до старта (отсекает «не новых»).'+(pending?' · '+pending+' мес. ещё прогреваются':'');
      }
    }).catch(function(){});
    // По точкам — маркетинг
    var bs=document.getElementById('mktByStore');
    if(bs && d.byStore && d.byStore.length){
      bs.innerHTML='<table><thead><tr><th>Точка</th><th class="num">Выручка ₽</th><th class="num">YoY</th><th class="num">Чеки</th><th class="num">Ср. чек</th><th class="num">Карта лоял.</th><th class="num">Δ карты</th></tr></thead><tbody>'+
        d.byStore.map(function(r){
          var dr=r.revenue.deltaPct, dcl=r.cardPct.deltaPp;
          var drs=(dr==null?'нов.':(dr>0?'+':'')+mNum1(dr)+'%'); var drc=(dr==null?'color:var(--muted)':(dr>0?'color:#10a05a':(dr<0?'color:#e0466a':'')));
          var dcls=(dcl==null?'—':(dcl>0?'+':'')+mNum1(dcl)+' п.п.'); var dclc=(dcl>=0?'color:#10a05a':'color:#e0466a');
          return '<tr><td><b>'+r.name+'</b></td><td class="num">'+mNum(r.revenue.cur)+'</td><td class="num" style="'+drc+'">'+drs+'</td><td class="num">'+mNum(r.cheques.cur)+'</td><td class="num">'+mNum(r.avgCheck.cur)+' ₽</td><td class="num">'+mNum1(r.cardPct.cur)+'%</td><td class="num" style="'+dclc+'">'+dcls+'</td></tr>';
        }).join('')+'</tbody></table>';
    }
    // 2ГИС Сторис — Маша платит за продвижение
    if (d.external && d.external.gis && d.external.gis.stories) {
      var st = d.external.gis.stories;
      var stEl = document.getElementById('mktGisStories');
      if (stEl) {
        var topics = (st.topics || []).filter(function(t){return !/Просмотров|Кликов|превью|сторис|кнопк/i.test(t);}).slice(0, 25);
        stEl.innerHTML = '<div class="mkt-chart-t">2ГИС Сторис · '+(st.period||'')+' <span class="mkt-scope dyn">live</span></div>' +
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:8px 0">' +
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(st.previewViews||0)+'</div><div class="mkt-l">Просмотров превью</div></div>' +
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(st.storiesViews||0)+'</div><div class="mkt-l">Просмотров сторис</div></div>' +
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(st.buttonClicks||0)+'</div><div class="mkt-l">Кликов в кнопку</div></div>' +
          '</div>' +
          (topics.length ? '<div style="margin:6px 0;font-size:12px;line-height:1.8"><b>Темы сторис:</b> ' + topics.map(function(t){return '<span style="background:#eaeaea;padding:2px 8px;border-radius:10px;margin-right:4px;display:inline-block;margin-bottom:4px">'+t+'</span>';}).join('') + '</div>' : '');
      }
    }

    // 2ГИС: отзывы + теги (парсятся с /branches/X/reviews)
    if (d.external && d.external.gis && d.external.gis.reviews) {
      var grEl = document.getElementById('mktGisReviews');
      if (grEl) {
        var rv = d.external.gis.reviews;
        var items = rv.items || [];
        var tags = rv.tags || [];
        var gmTotal = rv.googleMapsReviews;
        // Период отзывов: парсим даты вида «16 мая 2026» и берём диапазон.
        var _rum={}; for(var _i=1;_i<_MM_SWEET.length;_i++) _rum[_MM_SWEET[_i]]=_i;
        var rdate=function(s){ var m=String(s||'').match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i); if(!m) return null; var mo=_rum[m[2].toLowerCase()]; if(!mo) return null; return new Date(Date.UTC(+m[3],mo-1,+m[1])); };
        var _parsed=items.map(function(r){ return {d:rdate(r.date),s:r.date}; }).filter(function(x){ return x.d; }).sort(function(a,b){ return a.d-b.d; });
        var perLbl=_parsed.length ? (_parsed[0].s+' — '+_parsed[_parsed.length-1].s) : '';
        grEl.innerHTML = '<div class="mkt-chart-t">Отзывы 2ГИС'+(perLbl?' · '+perLbl:'')+' <span class="mkt-scope dyn">live</span></div>' +
          (perLbl?'<div style="font-size:11px;color:var(--muted);margin:-2px 0 6px">Период — по датам распарсенных отзывов (от старого к свежему). Это последние отзывы с карточки 2ГИС, не за выбранный слева месяц.</div>':'') +
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:8px 0">' +
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(items.length)+'</div><div class="mkt-l" title="Сколько свежих отзывов удалось распарсить с карточки 2ГИС">Отзывов за период</div></div>' +
          (gmTotal ? '<div class="mkt-kpi"><div class="mkt-v">'+mNum(gmTotal)+'</div><div class="mkt-l">Отзывов на Google Maps</div></div>' : '<div></div>') +
          '<div class="mkt-kpi"><div class="mkt-v">'+mNum(tags.length)+'</div><div class="mkt-l">Тегов от клиентов</div></div>' +
          '</div>' +
          (tags.length ? '<div style="margin:8px 0"><b>Темы отзывов:</b> ' + tags.map(function(t){return '<span style="font-size:11px;background:#eaeaea;padding:2px 8px;border-radius:10px;margin-right:4px;display:inline-block;margin-bottom:4px">'+t+'</span>';}).join('') + '</div>' : '') +
          '<div class="table-wrap" style="max-height:400px;overflow-y:auto"><table style="font-size:12px"><thead><tr><th>Дата</th><th>Платформа</th><th>Автор</th><th>Отзыв</th></tr></thead><tbody>' +
          items.slice(0, 25).map(function(r){
            var pc = r.platform === '2GIS' ? 'color:#10a05a' : (r.platform === 'Google maps' ? 'color:#b8860b' : 'color:var(--muted)');
            return '<tr><td style="font-size:11px;white-space:nowrap">'+r.date+'</td><td style="font-size:11px;'+pc+'">'+r.platform+'</td><td style="font-size:11px"><b>'+r.author+'</b></td><td style="font-size:11px">'+r.text.slice(0, 200)+(r.text.length>200?'…':'')+'</td></tr>';
          }).join('') +
          '</tbody></table></div>';
      }
    }

    // живой 2ГИС из cron-скрейпа (d.external.gis)
    var gl=document.getElementById('mktGisLive');
    if(gl){ var g=d.external&&d.external.gis;
      if(g){ var a=g.appearance||{}; var st=g.scrapedAt?new Date(g.scrapedAt).toLocaleString('ru-RU'):'—';
        var acts=(g.actions||[]).slice(0,8).map(function(x){return x.name+' '+mNum1(x.pct)+'%';}).join(' · ');
        var qs=(g.queries||[]).slice(0,8).map(function(x){return x.q+' '+mNum1(x.pct)+'%';}).join(' · ');
        // Таблица позиций по каждой нашей рубрике
        var rubsTable='';
        if(g.appearanceByRubric && g.appearanceByRubric.length){
          rubsTable='<div class="mkt-chart-t" style="margin-top:14px">Позиция и показы по каждой нашей рубрике в 2ГИС</div>'+
            '<div class="table-wrap"><table><thead><tr><th>Рубрика</th><th class="num" title="Скользящее окно 2ГИС — последние ~30 дней, не календарный месяц">Показы (30 дн)</th><th class="num">Позиция (ср.)</th><th class="num">Диапазон</th></tr></thead><tbody>'+
            g.appearanceByRubric.map(function(b){
              if(b.error) return '<tr><td>'+b.rubric+'</td><td class="num" colspan="3" style="color:var(--muted);text-align:left">— '+b.error+'</td></tr>';
              var posColor=b.positionAvg<=5?'color:#10a05a':(b.positionAvg<=15?'':(b.positionAvg<=50?'color:#b8860b':'color:#e0466a'));
              return '<tr><td><b>'+b.rubric+'</b></td><td class="num">'+mNum(b.impressions||0)+'</td><td class="num" style="'+posColor+'"><b>'+(b.positionAvg||'?')+'</b></td><td class="num">'+(b.positionMin||'?')+'–'+(b.positionMax||'?')+'</td></tr>';
            }).join('')+'</tbody></table></div>';
        }
        gl.innerHTML='<div class="mkt-chart-t">Присутствие в выдаче 2ГИС <span class="mkt-scope dyn">live</span></div>'+
          '<ul style="margin:6px 0 0;padding-left:20px;font-size:13px;line-height:1.6">'+
          (a.impressions?'<li><b>Показы в поиске (все рубрики):</b> '+mNum(a.impressions)+' за последние '+a.days+' дн (скользящее окно 2ГИС, не календарный месяц — календарные в таблице выше), средняя позиция '+(a.positionAvg||'?')+' ('+(a.positionMin||'?')+'–'+(a.positionMax||'?')+').</li>':'')+
          (acts?'<li><b>Действия на карточке:</b> '+acts+'.</li>':'')+
          (qs?'<li><b>Топ-запросы:</b> '+qs+'.</li>':'')+
          '</ul>'+rubsTable+
          // Лента событий 2ГИС — снапшот за сегодня (последние ~50 событий)
          (g.feed && g.feed.eventsCount ? (
            '<div class="mkt-chart-t" style="margin-top:18px">Лента событий 2ГИС — снапшот за сегодня · '+g.feed.eventsCount+' событий, '+mNum1(g.feed.newUsersPct)+'% новых пользователей</div>'+
            '<div class="mkt-2col" style="margin-top:8px">'+
            '<div><div class="mkt-chart-t">По филиалам (из событий)</div><div class="table-wrap"><table><thead><tr><th>Филиал</th><th class="num">События</th></tr></thead><tbody>'+
              g.feed.byBranch.slice(0,15).map(function(r){ return '<tr><td>'+r.branch+'</td><td class="num">'+r.events+'</td></tr>'; }).join('')+
              '</tbody></table></div></div>'+
            '<div><div class="mkt-chart-t">По типам действий</div><div class="table-wrap"><table><thead><tr><th>Тип</th><th class="num">События</th></tr></thead><tbody>'+
              (g.feed.byEventType||[]).map(function(r){ return '<tr><td>'+r.type+'</td><td class="num">'+r.events+'</td></tr>'; }).join('')+
              '</tbody></table></div></div>'+
            '</div>'+
            (g.feed.topSearch && g.feed.topSearch.length ? '<div style="font-size:12px;margin-top:8px"><b>Топ поисковых фраз из событий:</b> '+g.feed.topSearch.slice(0,8).map(function(s){return s.q+' ×'+s.events;}).join(' · ')+'</div>' : '')
          ) : '')+
          '<div style="font-size:11px;color:var(--muted);margin-top:8px">Скрейп 2ГИС по расписанию на сервере. Обновлено: '+st+(g.sessionExpired?' · ⚠️ сессия 2ГИС протухла, нужен релогин':'')+'.</div>';
      } else { gl.innerHTML='<div style="font-size:12px;color:var(--muted)">2ГИС-данные ещё не собраны (cron-скрейп запустится по расписанию).</div>'; }
    }
    // живой Я.Директ из cron-скрейпа (d.external.direct).
    // ВАЖНО: снимок direct.json — ВСЕГДА текущий месяц (кабинет month-to-date). Для
    // ПРОШЛОГО выбранного месяца показывать его нельзя — иначе под мартом висит июньская
    // воронка, противоречащая таблице выше. Для прошлых месяцев строим воронку из
    // помесячной истории (directHistory), live-снимок (+кампании, +баланс) — только текущий.
    var dl=document.getElementById('mktDirectLive');
    if(dl){ var dd=d.external&&d.external.direct;
      var _MMd=['','январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
      var _selYM=mktSelectedPeriod();
      var _curYM=(window.__metaPeriods__&&window.__metaPeriods__[0])|| (new Date().getFullYear()+'-'+String(new Date().getMonth()+1).padStart(2,'0'));
      var _isCur=(_selYM===_curYM);
      if(!_isCur){
        // Прошлый месяц — воронка из помесячной истории кабинета (без live-снимка).
        var _dh=d.external&&d.external.directHistory;
        var _hm=(_dh&&_dh.months||[]).find(function(m){return m&&m.ym===_selYM&&m.spend;});
        var _ml=(function(){var p=_selYM.split('-');return _MMd[Number(p[1])]+' '+p[0];})();
        if(_hm){
          var _st2=_dh.scrapedAt?new Date(_dh.scrapedAt).toLocaleString('ru-RU'):'—';
          dl.innerHTML='<div class="mkt-chart-t">Я.Директ — воронка за '+_ml+' <span class="mkt-scope fix" title="Историческая сводка из кабинета за выбранный месяц. Live-воронка с разбивкой по кампаниям и остатком счёта — только для текущего месяца.">из истории</span></div>'+
            '<ul style="margin:6px 0 0;padding-left:20px;font-size:13px;line-height:1.6">'+
            '<li><b>Воронка:</b> показы <b>'+mNum(_hm.impressions)+'</b> → клики <b>'+mNum(_hm.clicks)+'</b> (CTR '+mNum1(_hm.ctrPct||0)+'%) → конверсии <b>'+mNum(_hm.conversions)+'</b> (CR '+mNum1(_hm.crPct||0)+'%).</li>'+
            '<li><b>Расход:</b> '+mNum(_hm.spend)+' ₽ · <b>CPC</b> '+mNum1(_hm.cpc||0)+' ₽ · <b>CPA</b> '+mNum(_hm.cpa||0)+' ₽.</li>'+
            (_hm.daysCovered&&_hm.daysCovered<28?'<li style="color:var(--muted)">Данные за '+_hm.daysCovered+' дн. месяца (неполный охват скрейпа).</li>':'')+
            '</ul>'+
            '<div style="font-size:11px;color:var(--muted);margin-top:8px">Историческая помесячная сводка кабинета Директа. Разбивка по кампаниям и остаток счёта доступны только для текущего месяца (live). Обновлено: '+_st2+'.</div>';
        } else {
          dl.innerHTML='<div style="font-size:12px;color:var(--muted)">За '+_ml+' данных Я.Директа в помесячной истории нет (см. таблицу выше). Live-воронка показывается только для текущего месяца.</div>';
        }
      } else if(dd && dd.totals && dd.totals.spend){ var t=dd.totals; var st=dd.scrapedAt?new Date(dd.scrapedAt).toLocaleString('ru-RU'):'—';
        dl.innerHTML='<div class="mkt-chart-t">Я.Директ — воронка текущего месяца <span class="mkt-scope dyn">live</span></div>'+
          '<ul style="margin:6px 0 0;padding-left:20px;font-size:13px;line-height:1.6">'+
          '<li><b>Воронка:</b> показы <b>'+mNum(t.impressions)+'</b> → клики <b>'+mNum(t.clicks)+'</b> (CTR '+mNum1(t.ctrPct||0)+'%) → конверсии <b>'+mNum(t.conversions)+'</b> (CR '+mNum1(t.crPct||0)+'%).</li>'+
          '<li><b>Расход:</b> '+mNum(t.spend)+' ₽ · <b>CPC</b> '+mNum1(t.cpc||0)+' ₽ · <b>CPA</b> '+mNum(t.cpa||0)+' ₽.</li>'+
          (dd.balance?'<li><b>Остаток на счёте кабинета:</b> '+mNum(dd.balance)+' ₽.</li>':'')+
          '<li><b>Структура:</b> РСЯ с гео-привязкой к районам точек («[ЕПК] РСЯ на Ядринцева» и т.п.). Цель — ecommerce-покупка.</li>'+
          '</ul>'+
          // Таблица по кампаниям с CPA-светофором (если есть)
          ((dd.campaigns && dd.campaigns.length) ? (
            '<div class="mkt-chart-t" style="margin-top:14px">По кампаниям за месяц</div>'+
            '<div class="table-wrap"><table><thead><tr><th>Кампания</th><th>Статус</th><th class="num">Расход ₽</th><th class="num">Клики</th><th class="num">Конв.</th><th class="num">CPA ₽</th><th class="num">CTR</th><th class="num">CR</th></tr></thead><tbody>'+
            dd.campaigns.map(function(c){
              var cpaC = c.cpa==null?'color:var(--muted)':(c.cpa<=300?'color:#10a05a':(c.cpa<=800?'color:#b8860b':'color:#e0466a'));
              return '<tr><td><b>'+c.name+'</b></td><td><span style="font-size:11px;color:var(--muted)">'+c.status+'</span></td><td class="num">'+mNum(c.spend)+'</td><td class="num">'+mNum(c.clicks)+'</td><td class="num">'+mNum(c.conversions)+'</td><td class="num" style="'+cpaC+'"><b>'+(c.cpa==null?'—':mNum(c.cpa))+'</b></td><td class="num">'+(c.ctrPct==null?'—':mNum1(c.ctrPct)+'%')+'</td><td class="num">'+(c.crPct==null?'—':mNum1(c.crPct)+'%')+'</td></tr>';
            }).join('')+'</tbody></table></div>'
          ) : '')+
          '<div style="font-size:11px;color:var(--muted);margin-top:8px">Скрейп Директа по расписанию на сервере. Обновлено: '+st+(dd.sessionExpired?' · ⚠️ сессия Яндекса протухла, нужен релогин':'')+'.</div>';
      } else { dl.innerHTML='<div style="font-size:12px;color:var(--muted)">Данные Я.Директа ещё не собраны (cron-скрейп запустится по расписанию).</div>'; }
    }
    // Соцсети — перекрываем TG+VK колонки в таблице #mktSocial живыми подписчиками
    if (d.external && d.external.social && d.external.social.brands) {
      var soTbl = document.querySelector('#mktSocial table');
      if (soTbl) {
        var brandKeyByName = { 'Мария':'maria', 'Стефания':'stefania', 'Этика':'etika', 'Cake Home':'cakehome', 'ЯХОНТ':'yahont' };
        var trs2 = soTbl.querySelectorAll('tbody tr');
        var anyLive = false;
        trs2.forEach(function(tr){
          var name = (tr.children[0]||{}).textContent.trim();
          var k = brandKeyByName[name]; if (!k) return;
          var br = d.external.social.brands[k];
          if (br && br.telegram && br.telegram.subscribers) {
            tr.children[1].innerHTML = mNum(br.telegram.subscribers) + ' <span style="font-size:10px;color:#10a05a">live</span>';
            anyLive = true;
          } else if (br && br.telegram === null) {
            tr.children[1].innerHTML = 'н/д <span style="font-size:10px;color:var(--muted)">live</span>';
            anyLive = true;
          }
          // VK live (5-я колонка, index 5)
          if (br && br.vk && br.vk.subscribers) {
            tr.children[5].innerHTML = br.vk.handle + ' · ' + mNum(br.vk.subscribers) + ' <span style="font-size:10px;color:#10a05a">live</span>';
            anyLive = true;
          }
        });
        if (anyLive) {
          var st = new Date(d.external.social.scrapedAt).toLocaleString('ru-RU');
          var info2 = document.getElementById('mktSocialLiveInfo');
          if (!info2 && soTbl.parentNode) {
            info2 = document.createElement('div');
            info2.id = 'mktSocialLiveInfo';
            info2.style.cssText = 'font-size:11px;color:var(--muted);margin-top:6px';
            soTbl.parentNode.parentNode.appendChild(info2);
          }
          if (info2) info2.textContent = 'Зелёный «live» в колонке Telegram = подписчики обновлены автоскрейпом t.me-preview (cron среда 04:30). Обновлено: ' + st;
        }
      }
    }
    // Цены конкурентов — перекрываем захардкоженные ячейки таблицы #mktPrices живыми из cron-скрейпа
    if (d.external && d.external.prices && d.external.prices.competitors) {
      var prTbl = document.querySelector('#mktPrices table');
      if (prTbl) {
        var fmtPrice = function(s){ if(!s) return null; var u=s.unit?(' ₽/'+s.unit):' ₽'; return s.min===s.max ? (s.min+u) : (s.min+'–'+s.max+u); };
        // Мапим заголовок строки → ключ категории в JSON
        var rowCatMap = { 'Торт на заказ':'tort_zakaz', 'Просто торты (готовые, в наличии)*':'tort_gotovyj', 'Бенто-торт':'bento', 'Кусочек / пирожное':['kusochki','pirozhnoe','desserts'], 'Макаронс, ₽/шт':'macarons' };
        // Колонки конкурентов: Мария(1) Стефания(2) Этика(3) Cake Home(4) ЯХОНТ(5)
        var compColMap = { 'stefania':2, 'etika':3, 'cakehome':4 };
        var trs = prTbl.querySelectorAll('tbody tr');
        trs.forEach(function(tr){
          var label = (tr.children[0]||{}).textContent || '';
          var catKey = rowCatMap[label.trim()];
          if (!catKey) return;
          for (var cKey in compColMap) {
            var col = compColMap[cKey];
            var comp = d.external.prices.competitors[cKey];
            if (!comp) continue;
            // подбираем категорию: если у нас массив возможных ключей — берём первый существующий с не-null значением
            var keys = Array.isArray(catKey) ? catKey : [catKey];
            var match = null;
            for (var i=0;i<keys.length;i++) { if (comp.categories[keys[i]]) { match = comp.categories[keys[i]]; break; } }
            var newVal = fmtPrice(match);
            if (newVal && tr.children[col]) {
              tr.children[col].innerHTML = newVal + ' <span style="font-size:10px;color:#10a05a">live</span>';
            }
          }
        });
        // подпись «обновлено»
        var hint = document.querySelector('#mkt-s-comp .section-hint, #mktPrices').parentElement.querySelector('.section-hint');
        var st = new Date(d.external.prices.scrapedAt).toLocaleString('ru-RU');
        var info = document.getElementById('mktPricesLiveInfo');
        if (!info && prTbl.parentNode) {
          info = document.createElement('div');
          info.id = 'mktPricesLiveInfo';
          info.style.cssText = 'font-size:11px;color:var(--muted);margin-top:6px';
          prTbl.parentNode.parentNode.appendChild(info);
        }
        if (info) info.textContent = 'Зелёный «live» = ячейка из автоскрейпа сайта конкурента (cron ежедневно 04:30). Последнее обновление: ' + st;
      }
    }
    // SERP — позиции в Яндексе: Мария vs Стефания (живые данные)
    var sl=document.getElementById('mktSerpLive');
    if(sl){ var seo=d.external&&d.external.seo;
      if(seo && seo.queries){
        var s=seo.summary||{};
        var rankBadge=function(r){ if(r==null) return '<span style="color:var(--muted)">—</span>';
          var clr=r<=3?'#10a05a':(r<=10?'#b8860b':'#e0466a');
          return '<span style="color:'+clr+';font-weight:700">'+r+'</span>'; };
        var rows=seo.queries.map(function(q){
          if(q.captcha) return '<tr><td>'+q.q+'</td><td colspan="4" style="font-size:11px;color:var(--muted)">— Яндекс показал капчу, обновится на следующем запуске</td></tr>';
          var r=q.ranks||{};
          return '<tr><td><b>'+q.q+'</b></td><td class="num">'+rankBadge(r.maria)+'</td><td class="num">'+rankBadge(r.stefania)+'</td><td class="num">'+rankBadge(r.cakehome)+'</td><td style="font-size:11px;color:var(--muted)">'+(q.top1||'')+'</td></tr>';
        }).join('');
        var st=seo.scrapedAt?new Date(seo.scrapedAt).toLocaleString('ru-RU'):'—';
        sl.innerHTML='<div class="mkt-chart-t">Позиции в Яндексе (lr=63 Иркутск): Мария vs конкуренты <span class="mkt-scope dyn">live</span></div>'+
          '<div style="font-size:12px;color:var(--muted);margin:4px 0 10px;line-height:1.55">Что показывает: <b>место сайта в обычной (бесплатной) выдаче Яндекса</b> по конкретному поисковому запросу — то, на какой строке Яндекс показывает сайт человеку из Иркутска (<b>lr=63</b> — код региона Иркутска). <b>1</b> = первая строка, <b>чем меньше число — тем выше</b> и тем больше переходов; «<b>—</b>» = сайта нет в топ-50. Это <b>не Я.Метрика и не реклама</b>, а живой замер поисковой выдачи (скрейп раз в неделю). Столбцы «Мария / Стефания / Cake Home» — позиция каждого по этому запросу; «Топ-1» — кто реально стоит на 1-м месте.</div>'+
          '<div style="margin:6px 0 10px;font-size:13px"><b>В топ-10:</b> Мария — <span style="color:'+(s.mariaTop10>=s.stefaniaTop10?'#10a05a':'#e0466a')+';font-weight:700">'+(s.mariaTop10||0)+'</span> запросов · Стефания — <span style="color:#b8860b;font-weight:700">'+(s.stefaniaTop10||0)+'</span> · <b>Средняя позиция</b> (по запросам где обе ранжируются): Мария '+(s.avgRankMaria||'—')+', Стефания '+(s.avgRankStefania||'—')+'.</div>'+
          '<div class="table-wrap"><table><thead><tr><th title="Поисковый запрос, который человек вводит в Яндексе">Запрос</th><th class="num" title="Позиция сайта maria-irk.ru в выдаче Яндекса по этому запросу (1 = первая строка)">Мария</th><th class="num" title="Позиция сайта Стефании по этому запросу">Стефания</th><th class="num" title="Позиция сайта Cake Home по этому запросу">Cake Home</th><th title="Кто фактически занимает 1-е место выдачи по этому запросу">Топ-1</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
          '<div style="font-size:11px;color:var(--muted);margin-top:6px">Цвет позиции: <b style="color:#10a05a">≤3</b> топ — отлично · <b style="color:#b8860b">≤10</b> первая страница · <b style="color:#e0466a">&gt;10</b> вторая+ страница (почти не кликают) · «—» нет в топ-50. Скрейп живой выдачи Яндекса по расписанию (еженедельно). Обновлено: '+st+'.</div>';
      } else {
        sl.innerHTML='<div style="font-size:12px;color:var(--muted)">Позиции в Яндексе ещё не собраны (cron-скрейп запустится по расписанию).</div>';
      }
    }
    // живая Я.Метрика из cron-скрейпа (d.external.metrika)
    var ml=document.getElementById('mktMetrikaLive');
    if(ml){ var mk=d.external&&d.external.metrika;
      if(mk && (mk.totalVisits || mk.totalVisitsHeader || (mk.sources && mk.sources.length))){
        var v=mk.totalVisits||mk.totalVisitsHeader||0; var st=mk.scrapedAt?new Date(mk.scrapedAt).toLocaleString('ru-RU'):'—';
        var per=mk.period?(mk.period.label||(mk.period.start+'…'+mk.period.end)):'—';
        var src=(mk.sources||[]).map(function(s){return s.name+' '+mNum(s.visits)+' ('+mNum1(s.sharePct)+'%)';}).join(' · ');
        ml.innerHTML='<div class="mkt-chart-t">Метрика — трафик сайта <span class="mkt-scope dyn">live</span></div>'+
          '<ul style="margin:6px 0 0;padding-left:20px;font-size:13px;line-height:1.6">'+
          '<li><b>Период:</b> '+per+'.</li>'+
          (v?'<li><b>Визиты:</b> '+mNum(v)+'.</li>':'')+
          (src?'<li><b>Источники:</b> '+src+'.</li>':'')+
          '</ul><div style="font-size:11px;color:var(--muted);margin-top:6px">Скрейп Метрики по расписанию. Обновлено: '+st+(mk.sessionExpired?' · ⚠️ сессия Яндекса протухла, нужен релогин':'')+'.</div>';
      } else if(mk && mk.gridTimeout){
        ml.innerHTML='<div style="font-size:12px;color:var(--muted)">Метрика-SPA рендерится нестабильно через headless-браузер. Рекомендуем оформить OAuth-токен Metrika API (надёжный путь). Cron продолжит пытаться ежедневно.</div>';
      } else {
        ml.innerHTML='<div style="font-size:12px;color:var(--muted)">Метрика — данные ещё не собраны (cron-скрейп 06:30).</div>';
      }
    }
    // Заменяем hardcoded SEO-таблицу на реальную из Метрики (counter 43949414)
    var seoEl=document.getElementById('mktSeo');
    if(seoEl){
      var mk2=d.external&&d.external.metrika;
      if(mk2 && mk2.sources && mk2.sources.length){
        var v2=mk2.totalVisits||0;
        var seoSrc=(mk2.sources||[]).find(function(s){return /поиск/i.test(s.name);});
        var seoNote = seoSrc && seoSrc.sharePct>=40
          ? '✓ SEO даёт '+mNum(seoSrc.visits)+' визитов ('+mNum1(seoSrc.sharePct)+'%) — главный канал. Расход 46к/мес оправдан.'
          : seoSrc ? '⚠️ SEO даёт '+mNum(seoSrc.visits)+' визитов ('+mNum1(seoSrc.sharePct)+'%) — стоит обсудить ROI 46к/мес SEO-расхода.' : '';
        seoEl.innerHTML = mTbl(
          ['Источник трафика','Визиты','Доля'],
          mk2.sources.map(function(s){ return [s.name, mNum(s.visits), mNum1(s.sharePct)+' %']; }),
          ['Всего', mNum(v2), '100 %']
        ) + '<div style="font-size:11px;color:var(--muted);margin-top:6px">Из Метрики (счётчик 43949414), период «'+(mk2.period?mk2.period.label:'last_month')+'». '+seoNote+' Помесячная разбивка с янв 2025 пока не доступна — Метрика SPA игнорирует URL-фильтр date1/date2, нужен Playwright-клик по datepicker.</div>';
      } else {
        seoEl.innerHTML='<div class="section-hint">Live-источники Метрики ещё не загружены.</div>';
      }
    }
  }).catch(function(e){
    var msg='<div class="mkt-yoy-load">Нет данных за период: '+e.message+'</div>';
    el.innerHTML=msg;
  });
}
// Универсальная sticky-навигация по секциям страницы (Маркетинг и Дашборд).
function pageNavInit(navId, pageId){
  var nav=document.getElementById(navId); if(!nav || nav._navInited) return;
  nav._navInited=true;
  var links=[].slice.call(nav.querySelectorAll('a'));
  var ids=links.map(function(a){ return a.getAttribute('href').slice(1); });
  links.forEach(function(a){
    a.addEventListener('click', function(e){
      var t=document.getElementById(a.getAttribute('href').slice(1));
      if(t){ e.preventDefault(); t.scrollIntoView({behavior:'smooth', block:'start'}); }
    });
  });
  function spy(){
    var pg=document.getElementById(pageId);
    if(!pg || pg.classList.contains('hidden') || getComputedStyle(pg).display==='none') return;
    var best=ids[0], bestTop=-1e9;
    for(var i=0;i<ids.length;i++){
      var el=document.getElementById(ids[i]); if(!el) continue;
      var top=el.getBoundingClientRect().top - 80;
      if(top<=0 && top>bestTop){ bestTop=top; best=ids[i]; }
    }
    links.forEach(function(a){ a.classList.toggle('active', a.getAttribute('href').slice(1)===best); });
  }
  window.addEventListener('scroll', spy, {passive:true});
  spy();
}

// === Зум графиков: клик по любому SVG-графику открывает увеличенную копию в попапе. ===
// Глобально для всех графиков проекта (делегирование на document, без правки каждого render).
function isZoomableChart(svg){
  if(!svg || svg.namespaceURI!=='http://www.w3.org/2000/svg') return false;
  if(svg.closest('.chart-zoom-ov')) return false;      // уже внутри попапа
  if(!svg.getAttribute('viewBox')) return false;        // иконки без viewBox пропускаем
  var w=svg.getAttribute('width')||'', st=svg.getAttribute('style')||'';
  if(w==='100%' || /width:\s*100%/.test(st)) return true;
  try{ if(svg.getBoundingClientRect().width>=220) return true; }catch(e){}
  return false;                                         // мелкие инлайн-иконки не зумим
}
function openChartZoom(svg){
  var ov=document.createElement('div'); ov.className='chart-zoom-ov';
  var box=document.createElement('div'); box.className='chart-zoom-box';
  // Заголовок графика — ближайшая подпись рядом со svg.
  var title='', t=svg.parentElement && svg.parentElement.querySelector('.mkt-chart-t,.chart-title,.section-label,h2,h3');
  if(!t){ var sec=svg.closest('section,.card,.kpi-detail,div'); if(sec) t=sec.querySelector('.mkt-chart-t,.chart-title,.section-label,h2,h3'); }
  if(t) title=t.textContent.trim();
  var clone=svg.cloneNode(true);
  clone.removeAttribute('style'); clone.setAttribute('width','100%'); clone.removeAttribute('height');
  clone.style.width='100%'; clone.style.height='auto'; clone.style.maxHeight='82vh';
  var bar=document.createElement('div'); bar.className='chart-zoom-bar';
  bar.innerHTML='<span>'+(title?escapeHtml(title):'График')+'</span>';
  var x=document.createElement('button'); x.className='chart-zoom-x'; x.setAttribute('aria-label','Закрыть'); x.textContent='✕';
  bar.appendChild(x); box.appendChild(bar); box.appendChild(clone); ov.appendChild(box);
  function done(){ ov.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') done(); }
  ov.addEventListener('click', function(e){ if(e.target===ov) done(); });
  x.addEventListener('click', done);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
}
function initChartZoom(){
  if(window.__chartZoomInit) return; window.__chartZoomInit=true;
  document.addEventListener('click', function(e){
    if(!e.target || !e.target.closest) return;
    var svg=e.target.closest('svg');
    if(svg && isZoomableChart(svg)) openChartZoom(svg);
  });
}


// === FX: тонкие анимации интерфейса (count-up KPI, проявление графиков/секций, скелетоны). ===
// Тренд 2026 — сдержанная, осмысленная анимация. Уважает prefers-reduced-motion.
// Самодостаточный модуль (как зум графиков): observe + одноразовые анимации, без риска
// «застрявшего невидимого» (pre-hide только для off-screen, IO всегда раскроет при скролле).
function initDashFx(){
  if(window.__dashFx) return; window.__dashFx=true;
  var reduce=false; try{ reduce=matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){}
  var hasIO = ('IntersectionObserver' in window);
  function isChart(svg){
    if(!svg.getAttribute || !svg.getAttribute('viewBox')) return false;
    var w=svg.getAttribute('width')||'', st=svg.getAttribute('style')||'';
    if(w==='100%' || /width:\s*100%/.test(st)) return true;
    try{ return svg.getBoundingClientRect().width>=220; }catch(_){ return false; }
  }
  // Count-up: анимируем число, в конце ВОССТАНАВЛИВАЕМ оригинальный текст (никогда не портим значение).
  function countUp(el, delay){
    if(el.children.length) return;            // не трогаем элементы с вложенным HTML (<b> и т.п.)
    var orig=el.textContent; var m=orig.match(/-?\d[\d  ]*(?:[.,]\d+)?/); if(!m) return;
    var raw=m[0], target=parseFloat(raw.replace(/[  ]/g,'').replace(',','.')); if(!isFinite(target)||Math.abs(target)<10) return;
    var pre=orig.slice(0,m.index), suf=orig.slice(m.index+raw.length);
    var dm=raw.match(/[.,](\d+)$/); var dec=dm?dm[1].length:0, t0=null;
    // easeOutExpo — быстро стартует, мягко оседает (премиальное ощущение счётчика).
    function fr(t){ if(t0==null)t0=t; var k=Math.min(1,(t-t0)/950), e=(k>=1)?1:1-Math.pow(2,-10*k);
      el.textContent=pre+(target*e).toLocaleString('ru-RU',{minimumFractionDigits:dec,maximumFractionDigits:dec})+suf;
      if(k<1) requestAnimationFrame(fr); else el.textContent=orig; }
    setTimeout(function(){ requestAnimationFrame(fr); }, delay||0);
  }
  function skeletonize(el){
    if(!/загруз|счита|прогрев|собир|подожд|warming|loading/i.test(el.textContent||'')) return false;
    el.classList.add('fx-skel-box');
    el.innerHTML='<span class="fx-skel-bar" style="width:72%"></span><span class="fx-skel-bar" style="width:92%"></span><span class="fx-skel-bar" style="width:54%"></span>';
    return true;
  }
  var io = hasIO ? new IntersectionObserver(function(es){ es.forEach(function(e, i){ if(!e.isIntersecting) return; var el=e.target; io.unobserve(el);
    // ВАЖНО: только одноразовые анимации, БЕЗ постоянного скрытия — если IO почему-то
    // не сработает, контент остаётся видимым (никогда не «застревает невидимым»).
    // Каскад (стаггер) для вошедших одной пачкой: 0,80,160…мс (до 480).
    var delay = Math.min(i, 6) * 80;
    try{ if(el.__fxType==='chart'){ el.style.animationDelay = delay + 'ms'; el.classList.add('fx-chart-in'); } else countUp(el, delay); }catch(_){}
  }); }, {threshold:0.12, rootMargin:'0px 0px -4% 0px'}) : null;
  function watch(el, type){
    if(el.getAttribute('data-fx')!=null) return; el.setAttribute('data-fx',''); el.__fxType=type;
    if(!io){ if(type==='num') countUp(el); return; }            // без IO — count-up сразу, графики без эффекта
    io.observe(el);
  }
  function scan(root){
    if(!root || !root.querySelectorAll) return;
    try{ root.querySelectorAll('.empty-state, .mkt-yoy-load').forEach(function(el){ if(el.getAttribute('data-fx')==null && skeletonize(el)) el.setAttribute('data-fx',''); }); }catch(_){}
    if(reduce) return;
    try{ root.querySelectorAll('.kpi-value, .mkt-v').forEach(function(el){ watch(el,'num'); }); }catch(_){}
    try{ root.querySelectorAll('svg[viewBox]').forEach(function(el){ if(isChart(el)) watch(el,'chart'); }); }catch(_){}
  }
  scan(document);
  // Блоки рендерятся асинхронно (после загрузки из 1С) — ловим вставку новых узлов.
  try{ new MutationObserver(function(ms){ var roots=[]; ms.forEach(function(m){ m.addedNodes && [].forEach.call(m.addedNodes,function(n){ if(n.nodeType===1) roots.push(n); }); });
    if(roots.length){ if(window.__fxRaf) cancelAnimationFrame(window.__fxRaf); window.__fxRaf=requestAnimationFrame(function(){ roots.forEach(scan); }); }
  }).observe(document.body,{childList:true,subtree:true}); }catch(_){}
}

// === Кроссхейр на графиках: вертикальная линия + подсказка по наведению. ===
// Глобально: использует встроенные <title> точек/баров (значения уже там), без правок
// рендеров. Подсказка мгновенная (нативный <title> всплывает с задержкой — оставляем как есть).
function initChartCrosshair(){
  if(window.__xhair) return; window.__xhair=true;
  document.addEventListener('mouseover', function(e){
    var svg = e.target && e.target.closest && e.target.closest('svg');
    if(!svg || svg.__xh || typeof isZoomableChart!=='function' || !isZoomableChart(svg)) return;
    attach(svg);
  });
  function points(svg){
    // элементы-данные = носители <title>; группируем по экранному X (бар/точка одного месяца).
    var groups={};
    svg.querySelectorAll('title').forEach(function(t){
      var el=t.parentElement; if(!el) return; var tag=(el.tagName||'').toLowerCase();
      if(tag!=='rect' && tag!=='circle' && tag!=='path' && tag!=='g') return;
      var txt=(t.textContent||'').trim(); if(!txt) return;
      var b; try{ b=el.getBoundingClientRect(); }catch(_){ return; } if(!b.width && !b.height) return;
      var cx=b.left+b.width/2, key=Math.round(cx/8);
      if(!groups[key]) groups[key]={x:cx, texts:[]};
      if(groups[key].texts.indexOf(txt)<0) groups[key].texts.push(txt);
    });
    return Object.keys(groups).map(function(k){return groups[k];}).sort(function(a,b){return a.x-b.x;});
  }
  function attach(svg){
    svg.__xh=true;
    var line=null, tip=null;
    function ensure(){
      if(!line){ line=document.createElement('div'); line.style.cssText='position:fixed;width:1px;background:var(--accent,#7c5cff);opacity:.45;pointer-events:none;z-index:9998'; document.body.appendChild(line); }
      if(!tip){ tip=document.createElement('div'); tip.style.cssText='position:fixed;pointer-events:none;z-index:9999;background:var(--panel-bg,#1c2030);color:var(--ink,#fff);border:1px solid var(--line,#333);border-radius:8px;padding:6px 9px;font-size:12px;line-height:1.45;box-shadow:0 6px 20px rgba(0,0,0,.3);max-width:240px;white-space:nowrap'; document.body.appendChild(tip); }
    }
    function onMove(ev){
      var pts=points(svg); if(!pts.length){ hide(); return; }
      var mx=ev.clientX, best=pts[0];
      for(var i=1;i<pts.length;i++) if(Math.abs(pts[i].x-mx)<Math.abs(best.x-mx)) best=pts[i];
      var r=svg.getBoundingClientRect(); ensure();
      line.style.top=r.top+'px'; line.style.height=r.height+'px'; line.style.left=best.x+'px';
      tip.innerHTML=best.texts.map(function(s){return s.replace(/[&<>]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c];});}).join('<br>');
      var tw=tip.offsetWidth||160;
      tip.style.left=Math.max(6, Math.min(best.x+12, (window.innerWidth||1200)-tw-6))+'px';
      tip.style.top=(r.top+8)+'px';
    }
    function hide(){ if(line){line.remove();line=null;} if(tip){tip.remove();tip=null;} }
    svg.addEventListener('mousemove', onMove);
    svg.addEventListener('mouseleave', hide);
  }
}
