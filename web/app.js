// ── State ──────────────────────────────────────────────────────────────────
function readUserToken() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('userToken');
  if (fromUrl) {
    localStorage.setItem('maria_user_token', fromUrl);
    url.searchParams.delete('userToken');
    window.history.replaceState({}, '', url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '') + url.hash);
    return fromUrl;
  }
  return localStorage.getItem('maria_user_token') || '';
}

const state = {
  period: '',
  selectedStoreId: '',
  activeTab: 'sales',
  summary: null,
  matrix: null,
  marketing: null,
  productForecast: null,
  ingestRuns: [],
  comments: [],
  storeSort: { key: 'percent', dir: -1 },
  productSort: 'fact',
  sessionToken: sessionStorage.getItem('maria_session') || '',
  userToken: readUserToken(),
  currentUser: null,
  pinRequired: false,
  editStoreId: '',
  editPlanData: []
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Formatters ─────────────────────────────────────────────────────────────
function formatMoney(v) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(v || 0);
}
function formatNum(v) { return new Intl.NumberFormat('ru-RU').format(v || 0); }
function formatDate(v) {
  if (!v) return 'нет';
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toLocaleString('ru-RU');
}
function formatDateShort(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toLocaleDateString('ru-RU');
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
  const res = await fetch(path, opts);
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: 'Ошибка запроса' }));
    throw new Error(b.error || 'Ошибка запроса');
  }
  return res.json();
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

  // Server-side PIN
  if (pinRequired && !state.sessionToken) {
    showPinOverlay();
  }

  // Client-side PIN (local override)
  const storedHash = localStorage.getItem(PIN_STORED_KEY);
  if (storedHash && !sessionStorage.getItem('maria_local_ok')) {
    showPinOverlay(true);
  }

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

function hidePinOverlay() {
  $('pinOverlay').classList.add('hidden');
}

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

  // Server PIN
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
  const saved = localStorage.getItem('maria_theme') || 'light';
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

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(el => {
    el.classList.toggle('hidden', el.id !== `tab${tab[0].toUpperCase()}${tab.slice(1)}`);
  });
  document.querySelectorAll('.sidebar-section').forEach(el => {
    el.classList.toggle('hidden', el.id !== `sidebar${tab[0].toUpperCase()}${tab.slice(1)}`);
  });
  if (tab === 'reports' && state.summary) renderReports(state.summary);
  if (tab === 'marketing') loadMarketing();
}

// ── SVG: trend line chart ──────────────────────────────────────────────────
function renderTrendChart(summary) {
  const el = $('trendChart');
  const pts = (summary.trend?.periods || []).filter(p => p.plan > 0 || p.fact > 0);
  if (pts.length < 2) { el.innerHTML = '<div class="empty-state">Недостаточно данных для графика.</div>'; return; }

  const W = 560, H = 240, pad = { t: 24, r: 20, b: 46, l: 68 };
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

  const dots = pts.map((p, i) => {
    const clr = p.completion >= 100 ? '#16a34a' : p.completion >= 80 ? '#f59e0b' : '#ef4444';
    return `<circle cx="${xp(i).toFixed(1)}" cy="${yp(p.fact).toFixed(1)}" r="5" fill="${clr}" stroke="white" stroke-width="2"/>
    <circle cx="${xp(i).toFixed(1)}" cy="${yp(p.plan).toFixed(1)}" r="3" fill="white" stroke="#9ca3af" stroke-width="1.5"/>
    <text x="${xp(i).toFixed(1)}" y="${(yp(p.fact) - 10).toFixed(1)}" text-anchor="middle" fill="var(--hint)" font-size="10">${p.completion}%</text>`;
  }).join('');

  const xlabels = pts.map((p, i) =>
    `<text x="${xp(i).toFixed(1)}" y="${(pad.t + ph + 18).toFixed(1)}" text-anchor="middle" fill="var(--hint)" font-size="11">${p.period}</text>`
  ).join('');

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

// ── SVG: daily bar chart ───────────────────────────────────────────────────
function renderDailyChart(summary) {
  const el = $('dailyChart');
  const rows = summary.daily || [];
  const elapsed = summary.forecast.elapsedDays || rows.length;
  const vis = rows.slice(0, Math.max(elapsed, 5));
  if (!vis.length) { el.innerHTML = '<div class="empty-state">Нет дневных данных.</div>'; return; }

  const W = 560, H = 220, pad = { t: 16, r: 20, b: 34, l: 68 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b, n = vis.length;
  const maxVal = Math.max(...vis.flatMap(r => [r.plan, r.fact]), 1);
  const slot = pw / n, barW = Math.max(slot * 0.5, 3);
  const yp = v => pad.t + ph - (v / maxVal) * ph;
  const bh = v => Math.max((v / maxVal) * ph, 0);

  const grids = Array.from({ length: 4 }, (_, i) => {
    const v = maxVal / 3 * i, y = yp(v);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + pw}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
    <text x="${pad.l - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--hint)" font-size="11">${fmtAxis(v)}</text>`;
  }).join('');

  const bars = vis.map((row, i) => {
    const cx = pad.l + i * slot + slot / 2;
    const clr = row.percent >= 100 ? '#16a34a' : row.percent >= 80 ? '#f59e0b' : '#ef4444';
    const showLabel = i === 0 || (i + 1) % 5 === 0 || i === n - 1;
    return `<rect x="${(cx - barW / 2 - 1).toFixed(1)}" y="${yp(row.plan).toFixed(1)}" width="${(barW + 2).toFixed(1)}" height="${bh(row.plan).toFixed(1)}" rx="2" fill="var(--line)"/>
    <rect x="${(cx - barW / 2).toFixed(1)}" y="${yp(row.fact).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh(row.fact).toFixed(1)}" rx="2" fill="${clr}" opacity="0.88"/>
    ${showLabel ? `<text x="${cx.toFixed(1)}" y="${(pad.t + ph + 14).toFixed(1)}" text-anchor="middle" fill="var(--hint)" font-size="10">${row.day}</text>` : ''}`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    ${grids}${bars}
    <text x="${pad.l}" y="${H - 2}" fill="var(--hint)" font-size="10">▭ план   ▮ факт</text>
  </svg>`;
}

// ── SVG: weekly bar chart ──────────────────────────────────────────────────
function renderWeeklyChart(summary) {
  const el = $('weeklyChart');
  if (!el) return;
  const daily = summary.daily || [];
  const elapsed = summary.forecast.elapsedDays || 0;
  const visible = daily.slice(0, Math.max(elapsed, 1));

  if (!visible.length) { el.innerHTML = '<div class="empty-state">Нет дневных данных для расчёта недель.</div>'; return; }

  const weeks = [];
  for (let i = 0; i < visible.length; i += 7) {
    const chunk = visible.slice(i, Math.min(i + 7, visible.length));
    const weekNum = Math.floor(i / 7) + 1;
    const days = chunk.length;
    weeks.push({
      label: `Нед. ${weekNum} (${days} дн.)`,
      plan: chunk.reduce((s, d) => s + d.plan, 0),
      fact: chunk.reduce((s, d) => s + d.fact, 0)
    });
  }

  const W = 560, H = 240, pad = { t: 24, r: 20, b: 50, l: 80 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const n = weeks.length;
  const maxVal = Math.max(...weeks.flatMap(w => [w.plan, w.fact]), 1);
  const slot = pw / n;
  const barW = Math.min(slot * 0.35, 40);
  const yp = v => pad.t + ph - (v / maxVal) * ph;
  const bh = v => Math.max((v / maxVal) * ph, 0);

  const grids = Array.from({ length: 5 }, (_, i) => {
    const v = maxVal / 4 * i, y = yp(v);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + pw}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
    <text x="${pad.l - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--hint)" font-size="11">${fmtAxis(v)}</text>`;
  }).join('');

  const bars = weeks.map((w, i) => {
    const cx = pad.l + i * slot + slot / 2;
    const pct = w.plan > 0 ? w.fact / w.plan * 100 : 0;
    const clr = pct >= 100 ? '#16a34a' : pct >= 80 ? '#f59e0b' : '#ef4444';
    const px = cx - barW - 3, fx = cx + 3;
    return `
    <rect x="${px.toFixed(1)}" y="${yp(w.plan).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh(w.plan).toFixed(1)}" rx="3" fill="var(--line)"/>
    <rect x="${fx.toFixed(1)}" y="${yp(w.fact).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh(w.fact).toFixed(1)}" rx="3" fill="${clr}" opacity="0.88"/>
    <text x="${cx.toFixed(1)}" y="${(pad.t + ph + 16).toFixed(1)}" text-anchor="middle" fill="var(--hint)" font-size="10.5">${w.label}</text>
    <text x="${cx.toFixed(1)}" y="${(pad.t + ph + 28).toFixed(1)}" text-anchor="middle" fill="${clr}" font-size="10" font-weight="600">${Math.round(pct)}%</text>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    ${grids}${bars}
    <rect x="${pad.l}" y="${H - 8}" width="10" height="7" rx="1" fill="var(--line)"/>
    <text x="${pad.l + 14}" y="${H - 2}" fill="var(--hint)" font-size="10">план</text>
    <rect x="${pad.l + 52}" y="${H - 8}" width="10" height="7" rx="1" fill="var(--accent)" opacity="0.88"/>
    <text x="${pad.l + 66}" y="${H - 2}" fill="var(--hint)" font-size="10">факт</text>
  </svg>`;
}

// ── SVG: BCG quadrant ──────────────────────────────────────────────────────
function renderBcgChart(summary) {
  const el = $('bcgChart');
  if (!el) return;
  const stores = summary.stores.filter(s => s.fact > 0);
  if (stores.length < 2) { el.innerHTML = '<div class="empty-state">Недостаточно данных для BCG-квадранта.</div>'; return; }

  const W = 620, H = 380, pad = { t: 40, r: 40, b: 60, l: 80 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;

  const maxFact = Math.max(...stores.map(s => s.fact), 1);
  const maxMargin = Math.max(...stores.map(s => Math.abs(s.marginPct)), 30);
  const midX = maxFact / 2;
  const midY = 20; // 20% маржи как порог

  const xp = fact => pad.l + (fact / maxFact) * pw;
  const yp = marginPct => pad.t + ph - ((marginPct + maxMargin) / (maxMargin * 2)) * ph;
  const midXpx = xp(midX);
  const midYpx = yp(midY);

  const quadLabels = [
    { x: pad.l + pw * 0.75, y: pad.t + 14, text: 'Чемпионы', color: '#16a34a' },
    { x: pad.l + pw * 0.25, y: pad.t + 14, text: 'Потенциал', color: '#0f766e' },
    { x: pad.l + pw * 0.25, y: pad.t + ph - 10, text: 'Аутсайдеры', color: '#dc2626' },
    { x: pad.l + pw * 0.75, y: pad.t + ph - 10, text: 'Донор оборота', color: '#b45309' },
  ];

  const quadBgs = [
    { x: midXpx, y: pad.t, w: pad.l + pw - midXpx, h: midYpx - pad.t, fill: 'rgba(22,163,74,0.05)' },
    { x: pad.l, y: pad.t, w: midXpx - pad.l, h: midYpx - pad.t, fill: 'rgba(15,118,110,0.04)' },
    { x: pad.l, y: midYpx, w: midXpx - pad.l, h: pad.t + ph - midYpx, fill: 'rgba(220,38,38,0.05)' },
    { x: midXpx, y: midYpx, w: pad.l + pw - midXpx, h: pad.t + ph - midYpx, fill: 'rgba(180,83,9,0.05)' },
  ];

  const dots = stores.map(s => {
    const cx = xp(s.fact);
    const cy = yp(s.marginPct);
    const r = 7;
    let fill = '#6b7280';
    if (s.fact >= midX && s.marginPct >= midY) fill = '#16a34a';
    else if (s.fact < midX && s.marginPct >= midY) fill = '#0f766e';
    else if (s.fact < midX && s.marginPct < midY) fill = '#dc2626';
    else fill = '#b45309';

    const name = s.storeName.length > 12 ? s.storeName.slice(0, 11) + '…' : s.storeName;
    const titleText = `${s.storeName}: факт ${fmtAxis(s.fact)} / маржа ${s.marginPct}%`;
    const labelX = cx + r + 4;
    const labelAnchor = labelX + 80 > W ? 'end' : 'start';
    const lx = labelAnchor === 'end' ? cx - r - 4 : labelX;
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${fill}" opacity="0.85" stroke="white" stroke-width="1.5">
      <title>${titleText}</title>
    </circle>
    <text x="${lx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="${labelAnchor}" fill="var(--ink)" font-size="10">${name}</text>`;
  }).join('');

  const xAxis = Array.from({ length: 5 }, (_, i) => {
    const v = (maxFact / 4) * i;
    const x = xp(v);
    return `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${pad.t + ph}" stroke="var(--line)" stroke-width="1"/>
    <text x="${x.toFixed(1)}" y="${pad.t + ph + 16}" text-anchor="middle" fill="var(--hint)" font-size="10">${fmtAxis(v)}</text>`;
  }).join('');

  const yAxis = [-20, -10, 0, 10, 20, 30].map(v => {
    if (v > maxMargin || v < -maxMargin) return '';
    const y = yp(v);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + pw}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
    <text x="${pad.l - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--hint)" font-size="10">${v}%</text>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    ${quadBgs.map(q => `<rect x="${q.x.toFixed(1)}" y="${q.y.toFixed(1)}" width="${q.w.toFixed(1)}" height="${q.h.toFixed(1)}" fill="${q.fill}"/>`).join('')}
    ${xAxis}${yAxis}
    <line x1="${midXpx.toFixed(1)}" y1="${pad.t}" x2="${midXpx.toFixed(1)}" y2="${pad.t + ph}" stroke="var(--hint)" stroke-width="1.5" stroke-dasharray="5,3"/>
    <line x1="${pad.l}" y1="${midYpx.toFixed(1)}" x2="${pad.l + pw}" y2="${midYpx.toFixed(1)}" stroke="var(--hint)" stroke-width="1.5" stroke-dasharray="5,3"/>
    ${quadLabels.map(q => `<text x="${q.x.toFixed(1)}" y="${q.y.toFixed(1)}" text-anchor="middle" fill="${q.color}" font-size="11" font-weight="700" opacity="0.7">${q.text}</text>`).join('')}
    ${dots}
    <text x="${pad.l + pw / 2}" y="${H - 6}" text-anchor="middle" fill="var(--hint)" font-size="11">Выручка →</text>
    <text x="14" y="${pad.t + ph / 2}" text-anchor="middle" fill="var(--hint)" font-size="11" transform="rotate(-90, 14, ${pad.t + ph / 2})">Маржа % →</text>
  </svg>`;
}

// ── KPIs ───────────────────────────────────────────────────────────────────
function renderKpis(summary) {
  const f = summary.forecast;
  const c = summary.comparison;
  const deltaArrow = c?.hasData && c.factDelta > 0 ? '↑' : c?.hasData && c.factDelta < 0 ? '↓' : '';
  const deltaTxt = c?.hasData ? ` ${deltaArrow}${c.factDeltaPercent > 0 ? '+' : ''}${c.factDeltaPercent}%` : '';
  const cards = [
    { label: 'План сети',  value: formatMoney(summary.totals.plan),   sub: '', tone: 'neutral' },
    { label: 'Факт сети',  value: formatMoney(summary.totals.fact),   sub: deltaTxt, tone: c?.factDelta >= 0 ? 'neutral' : 'neutral' },
    { label: 'Выполнение', value: `${summary.totals.completion}%`,    sub: '', tone: pctTone(summary.totals.completion) },
    { label: 'Маржа',      value: formatMoney(summary.totals.margin), sub: `${summary.totals.marginPct}% от выр.`, tone: summary.totals.margin >= 0 ? 'good' : 'bad' },
    { label: 'Прогноз',    value: formatMoney(f.projectedFact),       sub: `${f.projectedCompletion}% к плану`, tone: f.tone },
    { label: 'Нужно/день', value: formatMoney(f.requiredPerDayToPlan), sub: `осталось ${f.remainingDays} дн.`, tone: f.remainingDays > 0 ? (f.paceVsPlan >= 100 ? 'good' : f.paceVsPlan >= 90 ? 'warn' : 'bad') : 'neutral' }
  ];
  $('kpis').innerHTML = cards.map(c => `
    <article class="kpi ${c.tone}">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
      ${c.sub ? `<div class="kpi-sub">${c.sub}</div>` : ''}
    </article>`).join('');
}

// ── Forecast ───────────────────────────────────────────────────────────────
function renderForecast(summary) {
  const f = summary.forecast;
  const paceTone = f.paceVsPlan >= 100 ? 'good' : f.paceVsPlan >= 90 ? 'warn' : 'bad';
  $('forecastPanel').innerHTML = `
    <article class="fc-card ${f.tone}">
      <div class="fc-kicker">Прогноз</div>
      <div class="fc-title">${f.status}</div>
      <div class="fc-rows">
        <div class="fc-row"><span>К концу месяца</span><strong>${formatMoney(f.projectedFact)}</strong></div>
        <div class="fc-row"><span>Ожидаемое %</span><strong>${f.projectedCompletion}%</strong></div>
        <div class="fc-row"><span>Разрыв прогноза</span><strong class="${f.runwayGap >= 0 ? 'positive' : 'negative'}">${formatMoney(f.runwayGap)}</strong></div>
      </div>
    </article>
    <article class="fc-card neutral">
      <div class="fc-kicker">Ритм</div>
      <div class="fc-title">Ежедневный темп</div>
      <div class="fc-rows">
        <div class="fc-row"><span>Средний факт/день</span><strong>${formatMoney(f.averagePerDay)}</strong></div>
        <div class="fc-row"><span>Нужно/день к плану</span><strong>${formatMoney(f.requiredPerDayToPlan)}</strong></div>
        <div class="fc-row"><span>План/день</span><strong>${formatMoney(f.planPerDay)}</strong></div>
      </div>
    </article>
    <article class="fc-card ${paceTone}">
      <div class="fc-kicker">Период</div>
      <div class="fc-title">Где мы сейчас</div>
      <div class="fc-rows">
        <div class="fc-row"><span>Прошло дней</span><strong>${f.elapsedDays} / ${f.totalDays}</strong></div>
        <div class="fc-row"><span>Осталось</span><strong>${f.remainingDays} дн.</strong></div>
        <div class="fc-row"><span>Темп к плану</span><strong>${f.paceVsPlan}%</strong></div>
      </div>
    </article>`;
}

// ── Comparison ─────────────────────────────────────────────────────────────
function renderComparison(summary) {
  const c = summary.comparison;
  if (!c?.hasData) {
    $('comparisonPanel').innerHTML = '<div class="empty-state">Нет данных за предыдущий период.</div>';
    return;
  }
  const tone = c.factDelta >= 0 ? 'good' : 'bad';
  $('comparisonPanel').innerHTML = `
    <div class="cmp-card ${tone}">
      <div class="cmp-period">vs. ${c.previousPeriod}</div>
      <div class="cmp-rows">
        <div class="cmp-row"><span>Факт</span><strong class="${c.factDelta >= 0 ? 'positive' : 'negative'}">${signed(c.factDelta, formatMoney)}</strong></div>
        <div class="cmp-row"><span>Изм. %</span><strong class="${c.factDelta >= 0 ? 'positive' : 'negative'}">${signed(c.factDeltaPercent, v => v.toFixed(1) + '%')}</strong></div>
        <div class="cmp-row"><span>Выполнение</span><strong class="${c.completionDelta >= 0 ? 'positive' : 'negative'}">${signed(c.completionDelta, v => v.toFixed(1) + ' п.п.')}</strong></div>
        <div class="cmp-row"><span>Маржа</span><strong class="${c.marginDelta >= 0 ? 'positive' : 'negative'}">${signed(c.marginDelta, formatMoney)}</strong></div>
        <div class="cmp-row"><span>Количество</span><strong class="${c.quantityDelta >= 0 ? 'positive' : 'negative'}">${signed(c.quantityDelta, formatNum)}</strong></div>
      </div>
    </div>`;
}

// ── Spotlight ──────────────────────────────────────────────────────────────
function renderSpotlight(summary) {
  const l = summary.leader, lg = summary.lagger;
  $('spotlight').innerHTML = `
    <div class="spot-card leader">
      <div class="spot-label">Лидер</div>
      <div class="spot-name">${l ? l.storeName : '—'}</div>
      <div class="spot-value">${l ? l.percent : 0}%</div>
      <div class="spot-meta">${l ? formatMoney(l.fact) : ''}</div>
    </div>
    <div class="spot-card lagger">
      <div class="spot-label">Риск</div>
      <div class="spot-name">${lg ? lg.storeName : '—'}</div>
      <div class="spot-value">${lg ? lg.percent : 0}%</div>
      <div class="spot-meta">${lg ? formatMoney(lg.gap) : ''}</div>
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

  $('storesTable').innerHTML = sorted.map((s, idx) => {
    const avgCheck = s.quantity > 0 ? s.fact / s.quantity : 0;
    const tone = pctTone(s.percent);
    return `
    <tr data-store-id="${s.storeId}" class="${state.selectedStoreId === s.storeId ? 'active' : ''}">
      <td class="col-num">${idx + 1}</td>
      <td>${s.storeName}<br><small class="muted">${s.region || ''}</small></td>
      <td class="num">${formatMoney(s.fact)}</td>
      <td class="num">${formatMoney(s.plan)}</td>
      <td class="num">
        <div class="pct-cell">
          <div class="pct-val ${tone}">${s.percent}%</div>
          <div class="pct-track"><div class="pct-bar ${tone}" style="width:${Math.min(s.percent, 140)}%"></div></div>
        </div>
      </td>
      <td class="num ${s.margin >= 0 ? 'positive' : 'negative'}">${formatMoney(s.margin)}</td>
      <td class="num ${s.marginPct >= 20 ? 'good' : s.marginPct >= 10 ? 'warn' : 'bad'}">${s.marginPct}%</td>
      <td class="num">${avgCheck > 0 ? formatMoney(avgCheck) : '—'}</td>
      <td class="num">${formatNum(s.quantity)}</td>
      <td class="num"><span class="spark"><span class="spark-fill ${tone}" style="width:${Math.min(s.percent, 100)}%"></span></span></td>
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
    const items = d.items || [];
    state.editPlanData = items.map(item => ({ ...item, newPlan: item.plan }));
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

// ── Products list ──────────────────────────────────────────────────────────
function renderProducts(summary) {
  const sorted = [...summary.products].sort((a, b) => b[state.productSort] - a[state.productSort]);
  $('productsList').innerHTML = sorted.map(p => {
    const tone = pctTone(p.percent);
    return `
    <div class="prod-item">
      <div class="prod-head">
        <div>
          <div class="prod-name">${p.productName}</div>
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
}

// ── Store details ──────────────────────────────────────────────────────────
async function loadStoreDetails() {
  const el = $('storeDetails');
  if (!state.selectedStoreId) {
    el.innerHTML = '<div class="empty-state">Нажмите на строку таблицы, чтобы увидеть детализацию по товарам</div>';
    return;
  }
  const d = await fetchJson(`/api/dashboard/store?period=${encodeURIComponent(state.period)}&storeId=${encodeURIComponent(state.selectedStoreId)}`);
  if (!d.items?.length) {
    el.innerHTML = '<div class="empty-state">Нет данных за период.</div>';
    return;
  }
  el.innerHTML = `<div class="detail-rows">
    ${d.items.map(item => {
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
          ${item.margin ? `<div class="detail-sub ${item.margin >= 0 ? 'positive' : 'negative'}">маржа: ${formatMoney(item.margin)}</div>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
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

// ── ABC analysis ───────────────────────────────────────────────────────────
function computeAbc(items, valueKey, nameKey) {
  const sorted = [...items].filter(i => i[valueKey] > 0).sort((a, b) => b[valueKey] - a[valueKey]);
  const total = sorted.reduce((s, i) => s + i[valueKey], 0);
  let cum = 0;
  return sorted.map((item, idx) => {
    cum += item[valueKey];
    const cumPct = total > 0 ? cum / total * 100 : 0;
    return {
      rank: idx + 1,
      name: item[nameKey] || item.storeId || item.productId,
      value: item[valueKey],
      share: total > 0 ? item[valueKey] / total * 100 : 0,
      cumPct,
      abc: cumPct <= 80 ? 'A' : cumPct <= 95 ? 'B' : 'C'
    };
  });
}

function renderAbcBar(barElId, items) {
  const el = $(barElId);
  if (!el || !items.length) return;
  const groups = { A: [], B: [], C: [] };
  items.forEach(i => groups[i.abc].push(i));
  const total = items.reduce((s, i) => s + i.value, 0);
  const revPct = g => total > 0 ? (groups[g].reduce((s, i) => s + i.value, 0) / total * 100).toFixed(0) : 0;
  el.innerHTML = ['A', 'B', 'C'].map(g => `
    <div class="abc-stat ${g.toLowerCase()}">
      <div class="abc-stat-group">${g}</div>
      <div class="abc-stat-pct">${revPct(g)}%</div>
      <div class="abc-stat-count">${groups[g].length} поз.</div>
    </div>`).join('');
}

function renderAbcTable(elId, items) {
  renderAbcBar(elId + 'Bar', items);
  const el = $(elId);
  if (!items.length) { el.innerHTML = '<div class="empty-state">Нет данных.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
    <th class="col-num">№</th>
    <th>Наименование</th>
    <th class="num">Выручка</th>
    <th class="num">Доля</th>
    <th class="num">Накоп.</th>
    <th>Гр.</th>
  </tr></thead><tbody>
    ${items.map(i => `<tr>
      <td class="col-num">${i.rank}</td>
      <td>${i.name}</td>
      <td class="num">${formatMoney(i.value)}</td>
      <td class="num">${i.share.toFixed(1)}%</td>
      <td class="num">${i.cumPct.toFixed(1)}%</td>
      <td><span class="abc-badge abc-${i.abc}">${i.abc}</span></td>
    </tr>`).join('')}
  </tbody></table>`;
}

// ── Growth report ──────────────────────────────────────────────────────────
function renderGrowthReport(summary) {
  const el = $('growthReport');
  const active = (summary.trend?.periods || []).filter(p => p.plan > 0 || p.fact > 0);
  if (active.length < 2) { el.innerHTML = '<div class="empty-state">Недостаточно данных для анализа динамики.</div>'; return; }
  const maxFact = Math.max(...active.map(p => p.fact), 1);
  el.innerHTML = `<table><thead><tr>
    <th>Период</th>
    <th class="num">Факт</th>
    <th class="num">Изм. к пред.</th>
    <th class="num">Изм. %</th>
    <th class="num">Вып. %</th>
    <th class="num">Маржа</th>
    <th class="num">График</th>
  </tr></thead><tbody>
    ${active.map((p, i) => {
      const isCur = p.period === summary.period;
      const prev = active[i - 1];
      const delta = prev ? p.fact - prev.fact : null;
      const deltaPct = prev && prev.fact > 0 ? delta / prev.fact * 100 : null;
      const barW = Math.round(p.fact / maxFact * 100);
      const barClr = p.completion >= 100 ? 'var(--good)' : p.completion >= 80 ? '#f59e0b' : 'var(--bad)';
      const arrow = delta === null ? '' : delta > 0
        ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>`
        : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;
      return `<tr class="${isCur ? 'growth-cur' : ''}">
        <td>${isCur ? `<strong>${p.period}</strong>` : p.period}</td>
        <td class="num">${formatMoney(p.fact)}</td>
        <td class="num">${delta !== null
          ? `<span class="growth-arrow ${delta >= 0 ? 'positive' : 'negative'}">${arrow}${formatMoney(Math.abs(delta))}</span>`
          : '<span class="muted">—</span>'}</td>
        <td class="num">${deltaPct !== null
          ? `<span class="${deltaPct >= 0 ? 'positive' : 'negative'}">${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%</span>`
          : '<span class="muted">—</span>'}</td>
        <td class="num"><span class="${pctTone(p.completion)}">${p.completion}%</span></td>
        <td class="num">${formatMoney(p.margin)}</td>
        <td class="num" style="width:80px;min-width:80px">
          <div style="height:6px;background:var(--line);border-radius:999px;overflow:hidden">
            <div style="height:100%;width:${barW}%;background:${barClr};border-radius:inherit"></div>
          </div>
        </td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

// ── Executive summary ──────────────────────────────────────────────────────
function renderExecutive(summary) {
  const e = summary.executive;
  const block = (cls, label, icon, items) => `
    <div class="exec-block ${cls}">
      <div class="exec-label">${icon} ${label}</div>
      <ul class="exec-list">${items.length
        ? items.map(i => `<li>${i}</li>`).join('')
        : '<li class="muted">Нет данных</li>'}</ul>
    </div>`;
  $('executivePanel').innerHTML =
    block('key',   'Ключевые выводы', '●', e.headlines)  +
    block('prior', 'Приоритеты',      '▲', e.priorities) +
    block('risk',  'Риски',           '!', e.alerts)     +
    `<div class="exec-footer">Сформировано: ${formatDate(e.generatedAt)}</div>`;
}

// ── Recommendations panel ──────────────────────────────────────────────────
function renderRecommendations(summary) {
  const el = $('recommendPanel');
  const badge = $('recommendBadge');
  if (!el) return;
  const e = summary.executive;
  const f = summary.forecast;
  const tone = f.projectedCompletion >= 100 ? 'good' : f.projectedCompletion >= 90 ? 'warn' : 'bad';

  if (badge) {
    badge.textContent = f.projectedCompletion >= 100 ? 'В плане' : f.projectedCompletion >= 90 ? 'Риск' : 'Не в плане';
    badge.className = `rec-badge rec-${tone}`;
  }

  const headline = `<div class="rec-headline">
    <div class="rec-kpi ${tone}">
      <span class="rec-kpi-val">${f.projectedCompletion}%</span>
      <span class="rec-kpi-label">прогноз выполнения</span>
    </div>
    <div class="rec-kpi neutral">
      <span class="rec-kpi-val">${formatMoney(f.projectedFact)}</span>
      <span class="rec-kpi-label">ожидается к концу месяца</span>
    </div>
    <div class="rec-kpi ${tone}">
      <span class="rec-kpi-val">${formatMoney(f.requiredPerDayToPlan)}</span>
      <span class="rec-kpi-label">нужно в день для плана</span>
    </div>
  </div>`;

  const priorities = e.priorities.length
    ? `<div class="rec-section">
        <div class="rec-section-label rec-prior">▲ Приоритеты</div>
        <ul class="rec-list">${e.priorities.map(p => `<li>${p}</li>`).join('')}</ul>
      </div>` : '';

  const alerts = e.alerts.length
    ? `<div class="rec-section">
        <div class="rec-section-label rec-risk">! Риски</div>
        <ul class="rec-list rec-alerts">${e.alerts.map(a => `<li>${a}</li>`).join('')}</ul>
      </div>` : '';

  const headlines = e.headlines.length
    ? `<div class="rec-section">
        <div class="rec-section-label">● Ключевые факты</div>
        <ul class="rec-list rec-facts">${e.headlines.map(h => `<li>${h}</li>`).join('')}</ul>
      </div>` : '';

  el.innerHTML = headline + priorities + alerts + headlines;
}

// ── Market news ────────────────────────────────────────────────────────────
const MARKET_NEWS = [
  { tag: 'Тренд', tone: 'accent', date: 'Апрель 2025', title: 'Бенто-торты: рост +25% г/г',
    text: 'Мини-торты в коробках остаются в топе. Покупатели выбирают их как подарок на 1–2 человека. Фокус на упаковке и персонализации.' },
  { tag: 'Рынок', tone: 'good', date: 'Q1 2025', title: 'Кофе с собой обгоняет торты',
    text: 'Кофейный сегмент в кондитерских Сибири +18% год к году. Главный драйвер — офисная аудитория. Рассмотрите расширение линейки.' },
  { tag: 'Сезон', tone: 'warn', date: 'Май–Июнь 2025', title: 'Выпускные: ожидаемый рост +35%',
    text: 'Сезон выпускных запускается в мае. Рост заказных тортов +35% в мае-июне — готовьте производственные мощности заранее.' },
  { tag: 'Новинка', tone: 'accent', date: 'Весна 2025', title: 'Корейский стиль: buttercream flowers',
    text: 'Торты с цветами из крема в корейском стиле — один из топ-запросов в соцсетях. Высокий средний чек и виральность в Instagram.' },
  { tag: 'Рынок', tone: 'good', date: 'Q1 2025', title: 'Средний чек вырос на 12%',
    text: 'В кондитерских Сибири средний чек +12% г/г. Покупатели готовы к премиуму — важно обеспечить соответствующий сервис.' },
  { tag: 'Совет', tone: 'neutral', date: 'Апрель 2025', title: 'Программы лояльности удерживают 30%+',
    text: 'Кондитерские с программой лояльности демонстрируют возврат клиентов на 30% выше. Персонализированные предложения к дням рождения особенно эффективны.' }
];
const TONE_TAG = { accent: '#0f766e', good: '#16a34a', warn: '#b45309', neutral: '#6b7280', bad: '#dc2626' };
const TONE_BG  = { accent: '#d5f2ee', good: '#dcfce7', warn: '#fef3c7', neutral: '#f3f4f6', bad: '#fee2e2' };

function renderMarketNews() {
  const el = $('marketNews');
  if (!el) return;
  el.innerHTML = MARKET_NEWS.map(n => `
    <div class="news-card">
      <div class="news-meta">
        <span class="news-tag" style="background:${TONE_BG[n.tone]};color:${TONE_TAG[n.tone]}">${n.tag}</span>
        <span class="news-date">${n.date}</span>
      </div>
      <div class="news-title">${n.title}</div>
      <div class="news-text">${n.text}</div>
    </div>`).join('');
}

// ── Store forecast report ──────────────────────────────────────────────────
function renderStoreForecastReport(summary) {
  const el = $('storeForecastBody');
  if (!el) return;
  const f = summary.forecast;
  const { elapsedDays, remainingDays, totalDays } = f;
  const stores = [...summary.stores].sort((a, b) => a.percent - b.percent);

  el.innerHTML = stores.map((s, idx) => {
    const avgPerDay = elapsedDays > 0 ? s.fact / elapsedDays : 0;
    const projected = Math.round(avgPerDay * totalDays);
    const projPct = s.plan > 0 ? Math.round(projected / s.plan * 100) : 0;
    const reqPerDay = remainingDays > 0 ? Math.max(s.plan - s.fact, 0) / remainingDays : 0;
    const gap = projected - s.plan;
    const ptone = pctTone(projPct);
    const statusIcon = projPct >= 100 ? '✓' : projPct >= 90 ? '~' : '✗';
    const statusCls  = projPct >= 100 ? 'good' : projPct >= 90 ? 'warn' : 'bad';
    return `<tr>
      <td class="col-num">${idx + 1}</td>
      <td>${s.storeName}<br><small class="muted">${s.region || ''}</small></td>
      <td class="num">${formatMoney(s.fact)}</td>
      <td class="num"><span class="${pctTone(s.percent)}">${s.percent}%</span></td>
      <td class="num">${formatMoney(projected)}</td>
      <td class="num"><span class="${ptone}">${projPct}%</span></td>
      <td class="num">${reqPerDay > 0 ? formatMoney(reqPerDay) : '<span class="good">—</span>'}</td>
      <td class="num"><span class="${gap >= 0 ? 'positive' : 'negative'}">${gap >= 0 ? '+' : ''}${formatMoney(gap)}</span></td>
      <td><span class="forecast-status ${statusCls}">${statusIcon}</span></td>
    </tr>`;
  }).join('');
}

// ── Product forecast report ────────────────────────────────────────────────
function renderProductForecastReport(data) {
  const el = $('productForecastBody');
  if (!el || !data) return;
  const { products } = data;
  if (!products?.length) { el.innerHTML = '<tr><td colspan="10" class="empty-state">Нет данных.</td></tr>'; return; }

  el.innerHTML = products.map((p, idx) => {
    const ptone = pctTone(p.projPct);
    const statusIcon = p.status === 'good' ? '✓' : p.status === 'warn' ? '~' : '✗';
    return `<tr>
      <td class="col-num">${idx + 1}</td>
      <td>${p.productName}<br><small class="muted">${p.category || ''}</small></td>
      <td class="num">${formatMoney(p.fact)}</td>
      <td class="num"><span class="${pctTone(p.percent)}">${p.percent}%</span></td>
      <td class="num">${formatMoney(p.projected)}</td>
      <td class="num"><span class="${ptone}">${p.projPct}%</span></td>
      <td class="num">${p.reqPerDay > 0 ? formatMoney(p.reqPerDay) : '<span class="good">—</span>'}</td>
      <td class="num"><span class="${p.gap >= 0 ? 'positive' : 'negative'}">${p.gap >= 0 ? '+' : ''}${formatMoney(p.gap)}</span></td>
      <td class="num ${p.marginPct >= 20 ? 'good' : p.marginPct >= 10 ? 'warn' : 'bad'}">${p.marginPct}%</td>
      <td><span class="forecast-status ${p.status}">${statusIcon}</span></td>
    </tr>`;
  }).join('');
}

// ── Distribution chart ─────────────────────────────────────────────────────
function renderDistribution(summary) {
  const el = $('distributionChart');
  if (!el) return;
  const brackets = [
    { label: 'Сверх плана (≥110%)', min: 110, max: Infinity, cls: 'good',    icon: '★' },
    { label: 'Выполнение (100–109%)', min: 100, max: 110,    cls: 'good',    icon: '✓' },
    { label: 'Близко (90–99%)',       min: 90,  max: 100,    cls: 'warn',    icon: '~' },
    { label: 'Отставание (80–89%)',   min: 80,  max: 90,     cls: 'warn',    icon: '!' },
    { label: 'В риске (<80%)',        min: 0,   max: 80,     cls: 'bad',     icon: '✗' },
  ];
  const total = summary.stores.length;
  el.innerHTML = brackets.map(b => {
    const stores = summary.stores.filter(s => s.percent >= b.min && s.percent < b.max);
    const pct = total > 0 ? Math.round(stores.length / total * 100) : 0;
    const names = stores.map(s => s.storeName).join(', ') || '—';
    return `<div class="dist-row" title="${names}">
      <div class="dist-label"><span class="${b.cls}">${b.icon}</span>${b.label}</div>
      <div class="dist-track"><div class="dist-bar ${b.cls}" style="width:${pct}%"></div></div>
      <div class="dist-count"><strong>${stores.length}</strong><span class="muted">/${total}</span></div>
    </div>`;
  }).join('');
}

// ── Gap analysis ───────────────────────────────────────────────────────────
function renderGapReport(summary) {
  const el = $('gapTable');
  if (!el) return;
  const { remainingDays } = summary.forecast;
  const lagging = [...summary.stores].filter(s => s.gap < 0).sort((a, b) => a.gap - b.gap);
  if (!lagging.length) { el.innerHTML = '<div class="empty-state">Все точки выполняют план.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
    <th>Точка</th>
    <th class="num">Разрыв</th>
    <th class="num">Нужно/день</th>
    <th class="num">%</th>
  </tr></thead><tbody>
    ${lagging.map(s => {
      const reqPerDay = remainingDays > 0 ? Math.abs(s.gap) / remainingDays : 0;
      const urgency = reqPerDay > summary.forecast.averagePerDay * 0.3 ? 'bad' : 'warn';
      return `<tr>
        <td>${s.storeName}</td>
        <td class="num negative">${formatMoney(s.gap)}</td>
        <td class="num"><span class="${urgency}">${formatMoney(reqPerDay)}</span></td>
        <td class="num"><span class="${pctTone(s.percent)}">${s.percent}%</span></td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

// ── Margin chart ───────────────────────────────────────────────────────────
function renderMarginChart(summary) {
  const el = $('marginChart');
  if (!el) return;
  const stores = [...summary.stores].filter(s => s.fact > 0).sort((a, b) => b.marginPct - a.marginPct);
  const maxFact = Math.max(...stores.map(s => s.fact), 1);
  el.innerHTML = stores.map(s => {
    const barW = (s.fact / maxFact * 100).toFixed(1);
    const mTone = s.marginPct >= 25 ? 'good' : s.marginPct >= 15 ? 'warn' : 'bad';
    return `<div class="rank-row">
      <div class="rank-label" title="${s.storeName}">${s.storeName}</div>
      <div class="rank-track"><div class="rank-fact-bar ${mTone}" style="width:${barW}%"></div></div>
      <div class="rank-vals">
        <span class="${mTone} rank-pct">${s.marginPct}%</span>
        <span class="muted rank-money">${formatMoney(s.margin)}</span>
      </div>
    </div>`;
  }).join('');
}

// ── Avg check chart ────────────────────────────────────────────────────────
function renderAvgCheckChart(summary) {
  const el = $('avgCheckChart');
  if (!el) return;
  const stores = [...summary.stores].filter(s => s.quantity > 0)
    .map(s => ({ ...s, avgCheck: s.fact / s.quantity })).sort((a, b) => b.avgCheck - a.avgCheck);
  const maxCheck = Math.max(...stores.map(s => s.avgCheck), 1);
  el.innerHTML = stores.map(s => {
    const barW = (s.avgCheck / maxCheck * 100).toFixed(1);
    const rank = s.avgCheck > maxCheck * 0.75 ? 'good' : s.avgCheck > maxCheck * 0.4 ? 'warn' : 'neutral';
    return `<div class="rank-row">
      <div class="rank-label" title="${s.storeName}">${s.storeName}</div>
      <div class="rank-track"><div class="rank-fact-bar ${rank}" style="width:${barW}%"></div></div>
      <div class="rank-vals">
        <span class="rank-pct" style="color:var(--ink)">${formatMoney(s.avgCheck)}</span>
        <span class="muted rank-money">${formatNum(s.quantity)} шт</span>
      </div>
    </div>`;
  }).join('');
}

// ── Store rank chart ───────────────────────────────────────────────────────
function renderStoreRankChart(summary) {
  const el = $('storeRankChart');
  const stores = [...summary.stores].sort((a, b) => b.fact - a.fact);
  const maxVal = Math.max(...stores.map(s => Math.max(s.fact, s.plan)), 1);
  el.innerHTML = stores.map(s => {
    const factW = (s.fact / maxVal * 100).toFixed(1);
    const planW = (s.plan / maxVal * 100).toFixed(1);
    const tone = pctTone(s.percent);
    return `<div class="rank-row">
      <div class="rank-label" title="${s.storeName}">${s.storeName}</div>
      <div class="rank-track">
        <div class="rank-fact-bar ${tone}" style="width:${factW}%"></div>
        <div class="rank-plan-line" style="left:${planW}%" title="План: ${formatMoney(s.plan)}"></div>
      </div>
      <div class="rank-vals">
        <span class="${tone} rank-pct">${s.percent}%</span>
        <span class="muted rank-money">${fmtAxis(s.fact)}</span>
      </div>
    </div>`;
  }).join('');
}

// ── Category chart ─────────────────────────────────────────────────────────
function renderCategoryChart(summary) {
  const el = $('categoryChart');
  const catMap = new Map();
  for (const p of summary.products) {
    const cat = p.category || 'Другое';
    if (!catMap.has(cat)) catMap.set(cat, { name: cat, fact: 0, plan: 0, cost: 0, quantity: 0 });
    const c = catMap.get(cat);
    c.fact += p.fact; c.plan += p.plan; c.cost += (p.cost || 0); c.quantity += (p.quantity || 0);
  }
  const cats = [...catMap.values()].sort((a, b) => b.fact - a.fact);
  const maxVal = Math.max(...cats.map(c => Math.max(c.fact, c.plan)), 1);
  const totalFact = cats.reduce((s, c) => s + c.fact, 0);
  if (!cats.length) { el.innerHTML = '<div class="empty-state">Нет данных.</div>'; return; }
  el.innerHTML = cats.map(c => {
    const factW = (c.fact / maxVal * 100).toFixed(1);
    const planW = (c.plan / maxVal * 100).toFixed(1);
    const pctVal = c.plan > 0 ? Math.round(c.fact / c.plan * 100) : 0;
    const tone = c.plan > 0 ? pctTone(pctVal) : 'neutral';
    const share = totalFact > 0 ? (c.fact / totalFact * 100).toFixed(1) : 0;
    return `<div class="rank-row">
      <div class="rank-label">${c.name}</div>
      <div class="rank-track">
        <div class="rank-fact-bar ${tone}" style="width:${factW}%"></div>
        ${c.plan > 0 ? `<div class="rank-plan-line" style="left:${planW}%" title="План: ${formatMoney(c.plan)}"></div>` : ''}
      </div>
      <div class="rank-vals">
        ${c.plan > 0 ? `<span class="${tone} rank-pct">${pctVal}%</span>` : '<span class="muted rank-pct">—</span>'}
        <span class="muted rank-money">${share}% выр.</span>
      </div>
    </div>`;
  }).join('');
}

// ── Matrix ─────────────────────────────────────────────────────────────────
function renderMatrix(matrix) {
  const el = $('storeMatrix');
  if (!matrix || !matrix.stores.length || !matrix.products.length) {
    el.innerHTML = '<div class="empty-state">Нет данных.</div>'; return;
  }
  const { stores, products, cells, storeTotals, productTotals } = matrix;

  const cellHtml = (c) => {
    if (!c || (c.fact === 0 && c.plan === 0)) return `<td class="mx-cell mx-empty">—</td>`;
    const tone = c.percent !== null ? (c.percent >= 100 ? 'mx-good' : c.percent >= 80 ? 'mx-warn' : 'mx-bad') : 'mx-noplan';
    const title = `Факт: ${formatMoney(c.fact)}\nПлан: ${formatMoney(c.plan)}\n${c.percent !== null ? 'Вып.: ' + c.percent + '%' : 'Без плана'}`;
    return `<td class="mx-cell ${tone}" title="${title}">
      <div class="mx-fact">${fmtAxis(c.fact)}</div>
      ${c.percent !== null ? `<div class="mx-pct">${c.percent}%</div>` : ''}
    </td>`;
  };
  const totHtml = (t) => {
    if (!t || (t.fact === 0 && t.plan === 0)) return `<td class="mx-cell mx-empty">—</td>`;
    const tone = t.percent >= 100 ? 'mx-good' : t.percent >= 80 ? 'mx-warn' : 'mx-bad';
    return `<td class="mx-cell mx-total ${tone}"><div class="mx-fact">${fmtAxis(t.fact)}</div><div class="mx-pct">${t.percent}%</div></td>`;
  };

  el.innerHTML = `<table class="matrix-table">
    <thead><tr>
      <th class="mx-th-store">Точка</th>
      ${products.map(p => `<th class="num mx-th">${p.name}</th>`).join('')}
      <th class="num mx-th mx-th-total">Итого</th>
    </tr></thead>
    <tbody>
      ${stores.map(s => {
        const st = storeTotals[s.id] || { fact: 0, plan: 0, percent: 0 };
        return `<tr>
          <td class="mx-store">${s.name}</td>
          ${products.map(p => cellHtml(cells[s.id]?.[p.id])).join('')}
          ${totHtml(st)}
        </tr>`;
      }).join('')}
    </tbody>
    <tfoot><tr>
      <td class="mx-store mx-total">Итого</td>
      ${products.map(p => totHtml(productTotals[p.id])).join('')}
      <td class="mx-cell mx-total mx-grand">
        <div class="mx-fact">${fmtAxis(Object.values(productTotals).reduce((s, t) => s + t.fact, 0))}</div>
      </td>
    </tr></tfoot>
  </table>`;
}

// ── Ingest history ─────────────────────────────────────────────────────────
function renderIngestHistory(runs) {
  const el = $('ingestHistory');
  if (!el) return;
  if (!runs.length) {
    el.innerHTML = '<div class="empty-state">Нет истории загрузок.</div>'; return;
  }
  const statusBadge = s => {
    const txt = s === 'success' ? 'Успех' : s === 'duplicate' ? 'Дубликат' : 'Ошибка';
    return `<span class="ingest-badge ${s}">${txt}</span>`;
  };
  el.innerHTML = `<table><thead><tr>
    <th>Дата</th>
    <th>Период</th>
    <th>Источник</th>
    <th>Объект</th>
    <th class="num">Планов</th>
    <th class="num">Продаж</th>
    <th>Статус</th>
    <th>Примечание</th>
  </tr></thead><tbody>
    ${runs.map(r => `<tr>
      <td>${formatDateShort(r.createdAt)}</td>
      <td>${r.period || '—'}</td>
      <td>${r.sourceSystem || '—'}</td>
      <td><small class="muted">${(r.sourceObject || '—').slice(0, 40)}</small></td>
      <td class="num">${r.stats?.plans || 0}</td>
      <td class="num">${r.stats?.sales || 0}</td>
      <td>${statusBadge(r.status)}</td>
      <td><small class="muted">${r.error ? r.error.slice(0, 60) : ''}</small></td>
    </tr>`).join('')}
  </tbody></table>`;
}

// ── Marketing ──────────────────────────────────────────────────────────────
function renderMarketingKpis(mkt) {
  const el = $('mkKpis');
  if (!mkt || !mkt.totals) { el.innerHTML = ''; return; }
  const t = mkt.totals;
  const roasTone = t.roas >= 4 ? 'good' : t.roas >= 2 ? 'warn' : 'bad';
  const cards = [
    { label: 'Расходы',           value: formatMoney(t.spend),   tone: 'neutral' },
    { label: 'Выручка (маркет.)', value: formatMoney(t.revenue),  tone: 'neutral' },
    { label: 'ROAS',              value: t.roas.toFixed(2),       tone: roasTone  },
    { label: 'CPL',               value: formatMoney(t.cpl),      tone: 'neutral' },
    { label: 'CAC',               value: formatMoney(t.cac),      tone: 'neutral' },
    { label: 'Доля от продаж',    value: `${mkt.salesShare}%`,    tone: 'neutral' },
  ];
  el.innerHTML = cards.map(c => `
    <article class="kpi ${c.tone}">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
    </article>`).join('');
}

function renderMarketingChannels(mkt) {
  const el = $('mkChannels');
  if (!mkt || !mkt.channels.length) {
    el.innerHTML = `<tr><td colspan="11" class="empty-state" style="padding:32px;text-align:center">
      Нет данных по каналам за период.<br>
      <small class="muted">Загрузите через POST /api/ingest/marketing с ключом X-API-Key</small>
    </td></tr>`;
    return;
  }
  const roasTone = r => r >= 4 ? 'good' : r >= 2 ? 'warn' : 'bad';
  el.innerHTML = mkt.channels.map(ch => `
    <tr>
      <td><strong>${ch.channelName}</strong></td>
      <td class="num">${formatMoney(ch.spend)}</td>
      <td class="num">${formatMoney(ch.revenue)}</td>
      <td class="num"><span class="${roasTone(ch.roas)}">${ch.roas.toFixed(2)}</span></td>
      <td class="num">${formatNum(ch.leads)}</td>
      <td class="num">${ch.leads > 0 ? formatMoney(ch.cpl) : '—'}</td>
      <td class="num">${formatNum(ch.orders)}</td>
      <td class="num">${ch.orders > 0 ? formatMoney(ch.cac) : '—'}</td>
      <td class="num">${formatNum(ch.impressions)}</td>
      <td class="num">${ch.ctr}%</td>
      <td class="num">${ch.cvr}%</td>
    </tr>`).join('');
}

function renderMarketingInsights(analysis, mkt) {
  const el = $('mkInsights');
  if (!mkt || !mkt.channels.length) {
    el.innerHTML = `<div class="exec-block key" style="grid-column:1/-1">
      <div class="exec-label">Нет данных</div>
      <ul class="exec-list">
        <li>Загрузите данные через <code>POST /api/ingest/marketing</code></li>
        <li>Формат: <code>{ "period": "2026-04", "metrics": [{ "channelId": "vk", ... }] }</code></li>
      </ul>
    </div>`;
    return;
  }
  if (!analysis) { el.innerHTML = '<div class="empty-state">Загрузка анализа...</div>'; return; }
  const block = (cls, label, items) => `
    <div class="exec-block ${cls}">
      <div class="exec-label">${label}</div>
      <ul class="exec-list">${items.length
        ? items.map(i => `<li>${i}</li>`).join('')
        : '<li class="muted">Нет данных</li>'}</ul>
    </div>`;
  const engineLabel = analysis.engine === 'llm'
    ? `LLM (${analysis.model || 'groq'})`
    : 'Правила';
  const summaryHtml = analysis.summary
    ? `<div class="exec-summary" style="grid-column:1/-1">${analysis.summary}</div>`
    : '';
  el.innerHTML =
    summaryHtml +
    block('key',   '● Инсайты',        analysis.insights)     +
    block('prior', '▲ Рекомендации',   analysis.recommendations) +
    block('risk',  '! Предупреждения', analysis.warnings)     +
    `<div class="exec-footer" style="grid-column:1/-1">Источник: ${engineLabel} · Сформирован ${formatDate(analysis.generatedAt)}</div>`;
}

async function loadMarketing() {
  if (!state.period) return;
  try {
    const [mkt, analysis] = await Promise.all([
      fetchJson(`/api/dashboard/marketing?period=${encodeURIComponent(state.period)}`),
      fetchJson('/api/analysis/marketing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: state.period })
      }).catch(() => null)
    ]);
    state.marketing = mkt;
    renderMarketingKpis(mkt);
    renderMarketingChannels(mkt);
    renderMarketingInsights(analysis, mkt);
  } catch (err) {
    $('mkInsights').innerHTML = `<div class="empty-state" style="grid-column:1/-1">Ошибка загрузки: ${err.message}</div>`;
  }
}

// ── Reports accordion ──────────────────────────────────────────────────────
function initReportsAccordion() {
  document.querySelectorAll('#tabReports .section').forEach((section, idx) => {
    const children = Array.from(section.children);
    const triggerEl = children.find(el =>
      el.classList.contains('section-label') || el.classList.contains('section-header')
    );
    if (!triggerEl) return;

    const contentEls = children.filter(el => el !== triggerEl);
    if (!contentEls.length) return;

    const body = document.createElement('div');
    body.className = 'acc-body';
    contentEls.forEach(el => body.appendChild(el));
    section.appendChild(body);

    const labelEl = triggerEl.classList.contains('section-label')
      ? triggerEl
      : (triggerEl.querySelector('.section-label') || triggerEl);

    const arrow = document.createElement('span');
    arrow.className = 'acc-arrow';
    arrow.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    labelEl.appendChild(arrow);

    if (idx > 0) {
      section.classList.add('acc-closed');
      body.style.maxHeight = '0';
      body.style.overflow = 'hidden';
    } else {
      body.style.maxHeight = 'none';
    }

    const toggle = () => {
      const isClosed = section.classList.contains('acc-closed');
      if (isClosed) {
        section.classList.remove('acc-closed');
        body.style.overflow = 'hidden';
        body.style.maxHeight = body.scrollHeight + 'px';
        body.addEventListener('transitionend', () => {
          if (!section.classList.contains('acc-closed')) {
            body.style.maxHeight = 'none';
            body.style.overflow = '';
          }
        }, { once: true });
      } else {
        body.style.maxHeight = body.scrollHeight + 'px';
        body.style.overflow = 'hidden';
        requestAnimationFrame(() => requestAnimationFrame(() => {
          section.classList.add('acc-closed');
          body.style.maxHeight = '0';
        }));
      }
    };

    triggerEl.style.cursor = 'pointer';
    triggerEl.addEventListener('click', e => {
      if (e.target.closest('.icon-btn')) return;
      toggle();
    });
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
POST /api/ingest/sales   — только продажи
POST /api/ingest/marketing — маркетинговые каналы</code>
  </div>`;
}

// ── Reports tab ────────────────────────────────────────────────────────────
async function loadProductForecast() {
  if (!state.period) return;
  try {
    const data = await fetchJson(`/api/dashboard/product-forecast?period=${encodeURIComponent(state.period)}`);
    state.productForecast = data;
    renderProductForecastReport(data);
  } catch { renderProductForecastReport(null); }
}

async function loadMatrix() {
  if (!state.period) return;
  const matrix = await fetchJson(`/api/dashboard/matrix?period=${encodeURIComponent(state.period)}`);
  state.matrix = matrix;
  renderMatrix(matrix);
}

async function loadIngestRuns() {
  try {
    const data = await fetchJson('/api/ingest/runs?limit=20');
    state.ingestRuns = data.runs || [];
    renderIngestHistory(state.ingestRuns);
  } catch { renderIngestHistory([]); }
}

function renderReports(summary) {
  renderAbcTable('abcProducts', computeAbc(summary.products, 'fact', 'productName'));
  renderAbcTable('abcStores', computeAbc(summary.stores, 'fact', 'storeName'));
  renderGrowthReport(summary);
  renderExecutive(summary);
  renderWeeklyChart(summary);
  renderBcgChart(summary);
  renderStoreForecastReport(summary);
  renderDistribution(summary);
  renderGapReport(summary);
  renderMarginChart(summary);
  renderAvgCheckChart(summary);
  renderStoreRankChart(summary);
  renderCategoryChart(summary);
  loadProductForecast();
  loadMatrix();
  loadIngestRuns();
}

// ── CSV export ─────────────────────────────────────────────────────────────
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

// ── Data loading ───────────────────────────────────────────────────────────
async function loadMetadata() {
  const meta = await fetchJson('/api/metadata');
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
}

function userLogout() {
  localStorage.removeItem('maria_user_token');
  state.userToken = '';
  state.currentUser = null;
  window.location.reload();
}

async function loadSummary() {
  if (!state.period) return;
  const summary = await fetchJson(`/api/dashboard/summary?period=${encodeURIComponent(state.period)}`);
  state.summary = summary;
  if (!state.selectedStoreId && summary.stores[0]) {
    state.selectedStoreId = summary.stores[0].storeId;
    $('storeDetailTitle').textContent = summary.stores[0].storeName;
  }

  renderKpis(summary);
  renderForecast(summary);
  renderTrendChart(summary);
  renderDailyChart(summary);
  renderComparison(summary);
  renderSpotlight(summary);
  renderRecommendations(summary);
  renderMarketNews();
  renderStores(summary);
  renderProducts(summary);
  await loadStoreDetails();
  await loadComments();

  if (state.activeTab === 'reports') renderReports(summary);

  $('lastUpdate').textContent = `обновлено: ${new Date().toLocaleTimeString('ru-RU')}`;
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
  // Dark theme (before anything else to avoid flash)
  initDarkTheme();

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  initReportsAccordion();

  // Sortable table headers
  document.querySelectorAll('#storesTableEl th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      state.storeSort = state.storeSort.key === k
        ? { key: k, dir: state.storeSort.dir * -1 }
        : { key: k, dir: -1 };
      if (state.summary) renderStores(state.summary);
    });
  });

  // Product sort
  $('productSort').addEventListener('change', e => {
    state.productSort = e.target.value;
    if (state.summary) renderProducts(state.summary);
  });

  // Print button
  $('printBtn').addEventListener('click', () => {
    // Open all accordion sections before printing
    document.querySelectorAll('#tabReports .section.acc-closed').forEach(section => {
      const body = section.querySelector('.acc-body');
      if (body) { body.style.maxHeight = 'none'; body.style.overflow = ''; }
      section.classList.remove('acc-closed');
    });
    window.print();
  });

  // Plan edit modal
  $('planSaveBtn').addEventListener('click', savePlanEdit);
  $('planCancelBtn').addEventListener('click', closePlanEdit);
  $('modalClose').addEventListener('click', closePlanEdit);
  $('planEditModal').addEventListener('click', e => { if (e.target === $('planEditModal')) closePlanEdit(); });

  // Comments
  initComments();

  // 1С Guide
  initUppGuide();

  // Exports
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

  $('exportAbcBtn')?.addEventListener('click', () => {
    if (!state.summary) return;
    exportCsv(computeAbc(state.summary.products, 'fact', 'productName').map(i => ({
      '№': i.rank, 'Наименование': i.name, 'Выручка': i.value,
      'Доля%': i.share.toFixed(1), 'Накоп%': i.cumPct.toFixed(1), 'Группа': i.abc
    })), `abc-${state.period}.csv`);
  });

  $('exportGrowthBtn')?.addEventListener('click', () => {
    if (!state.summary) return;
    const active = (state.summary.trend?.periods || []).filter(p => p.plan > 0 || p.fact > 0);
    exportCsv(active.map((p, i) => {
      const prev = active[i - 1];
      return {
        'Период': p.period, 'Факт': p.fact,
        'Рост': prev ? (p.fact - prev.fact).toFixed(0) : '',
        'Рост%': prev && prev.fact > 0 ? ((p.fact - prev.fact) / prev.fact * 100).toFixed(1) : '',
        'Выполнение%': p.completion, 'Маржа': p.margin
      };
    }), `growth-${state.period}.csv`);
  });

  const exportMatrix = () => {
    if (!state.matrix) return;
    const { stores, products, cells, storeTotals } = state.matrix;
    exportCsv(stores.map(s => {
      const row = { 'Точка': s.name, 'Регион': s.region };
      for (const p of products) {
        const c = cells[s.id]?.[p.id];
        row[p.name] = c ? c.fact : 0;
      }
      const t = storeTotals[s.id] || {};
      row['Итого факт'] = t.fact || 0;
      row['Итого план'] = t.plan || 0;
      row['Выполнение%'] = t.percent || 0;
      return row;
    }), `matrix-${state.period}.csv`);
  };
  $('exportMatrixBtn')?.addEventListener('click', exportMatrix);
  $('exportMatrixBtnH')?.addEventListener('click', exportMatrix);

  const exportMktg = () => {
    if (!state.marketing?.channels.length) return;
    exportCsv(state.marketing.channels.map(ch => ({
      'Канал': ch.channelName, 'Расходы': ch.spend, 'Выручка': ch.revenue,
      'ROAS': ch.roas, 'Лиды': ch.leads, 'CPL': ch.cpl, 'Заказы': ch.orders,
      'CAC': ch.cac, 'Показы': ch.impressions, 'Клики': ch.clicks, 'CTR%': ch.ctr, 'CVR%': ch.cvr
    })), `marketing-${state.period}.csv`);
  };
  $('exportMktgBtn')?.addEventListener('click', exportMktg);
  $('exportMktgBtnH')?.addEventListener('click', exportMktg);

  // Load data
  try {
    const meta = await loadMetadata();
    initPin(meta.pinRequired);
    await loadSummary();
    connectEvents();
    $('periodSelect').addEventListener('change', async e => {
      state.period = e.target.value;
      state.selectedStoreId = '';
      $('storeDetailTitle').textContent = 'Детализация точки';
      await loadSummary();
    });
    setInterval(loadSummary, 30000);
  } catch (err) {
    document.body.innerHTML = `<main style="padding:48px;text-align:center;color:#dc2626">Ошибка загрузки: ${err.message}</main>`;
  }
}

init();
