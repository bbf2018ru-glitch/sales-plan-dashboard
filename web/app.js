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

// ── KPIs ───────────────────────────────────────────────────────────────────
function renderKpis(summary) {
  const f = summary.forecast;
  const c = summary.comparison;
  const deltaArrow = c?.hasData && c.factDelta > 0 ? '↑' : c?.hasData && c.factDelta < 0 ? '↓' : '';
  const deltaTxt = c?.hasData ? ` ${deltaArrow}${c.factDeltaPercent > 0 ? '+' : ''}${c.factDeltaPercent}%` : '';
  const cards = [
    { label: 'План сети',  value: formatMoney(summary.totals.plan),   sub: '', tone: 'neutral' },
    { label: 'Факт сети',  value: formatMoney(summary.totals.fact),   sub: deltaTxt, tone: 'neutral' },
    { label: 'Выполнение', value: `${summary.totals.completion}%`,    sub: '', tone: pctTone(summary.totals.completion) },
    { label: 'Маржа',      value: formatMoney(summary.totals.margin), sub: isNum(summary.totals.marginPct) ? `${summary.totals.marginPct}% от выр.` : 'нет данных от 1С', tone: !isNum(summary.totals.margin) ? 'neutral' : summary.totals.margin >= 0 ? 'good' : 'bad' },
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
      <div class="cmp-row"><span>Маржа</span><strong class="${!isNum(c.marginDelta) ? '' : c.marginDelta >= 0 ? 'positive' : 'negative'}">${isNum(c.marginDelta) ? signed(c.marginDelta, formatMoney) : '—'}</strong></div>
      <div class="cmp-row"><span>Количество</span><strong class="${c.quantityDelta >= 0 ? 'positive' : 'negative'}">${signed(c.quantityDelta, formatNum)}</strong></div>
    </div>
  </div>`;
}

function renderComparison(summary) {
  $('comparisonPanel').innerHTML =
    renderCmpCard('vs. прошлый месяц', summary.comparison) +
    renderCmpCard('vs. тот же месяц год назад', summary.yoy);
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
      <td class="num ${!isNum(s.margin) ? '' : s.margin >= 0 ? 'positive' : 'negative'}">${formatMoney(s.margin)}</td>
      <td class="num ${!isNum(s.marginPct) ? '' : s.marginPct >= 20 ? 'good' : s.marginPct >= 10 ? 'warn' : 'bad'}">${formatPct(s.marginPct)}</td>
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

function productDisplayName(p) {
  if (p.productId === '_total' || p.productName === '_total') return 'ИТОГО по магазину';
  return p.productName || p.productId;
}

// ── Products list ──────────────────────────────────────────────────────────
function renderProducts(summary) {
  const sorted = [...summary.products]
    .filter(p => p.productId !== '_total')
    .sort((a, b) => b[state.productSort] - a[state.productSort]);
  $('productsList').innerHTML = sorted.map(p => {
    const tone = pctTone(p.percent);
    return `
    <div class="prod-item">
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
  const summary = await fetchJson(`/api/dashboard/summary?period=${encodeURIComponent(state.period)}&trend_window=24`);
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
  renderStores(summary);
  renderProducts(summary);
  await loadStoreDetails();
  await loadComments();

  $('lastUpdate').textContent = `обновлено: ${new Date().toLocaleTimeString('ru-RU')}`;
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

  const llmHtml = data.llmSummary
    ? `<div class="ins-llm"><div class="ins-llm-label">Резюме AI:</div><div class="ins-llm-text">${escapeHtml(data.llmSummary).replace(/\n/g, '<br>')}</div></div>`
    : '';

  el.innerHTML = `
    ${llmHtml}
    <div class="ins-grid">
      <div class="ins-col">
        <div class="ins-col-label">Что посмотреть</div>
        ${findingsHtml || '<div class="empty-state" style="padding:12px">Аномалий не найдено — сеть в норме.</div>'}
      </div>
      <div class="ins-col">
        <div class="ins-col-label">Календарь — ближайшие 45 дн.</div>
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
    if (state.summary) renderProducts(state.summary);
  });

  $('printBtn').addEventListener('click', () => window.print());

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

  try {
    const meta = await loadMetadata();
    initPin(meta.pinRequired);
    await loadSummary();
    loadInsights();
    connectEvents();
    $('periodSelect').addEventListener('change', async e => {
      state.period = e.target.value;
      state.selectedStoreId = '';
      $('storeDetailTitle').textContent = 'Детализация точки';
      await loadSummary();
      loadInsights();
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

init();
