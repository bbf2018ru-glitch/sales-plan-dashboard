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
  const pct = t.completion || 0;
  const gap = (t.plan || 0) - (t.fact || 0);
  const f = summary.forecast || {};

  // Топ-3 отстающих магазина
  const lagging = (summary.stores || [])
    .filter(s => s.plan > 0)
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 3);

  // Топ-3 лидера
  const leaders = (summary.stores || [])
    .filter(s => s.plan > 0)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 3);

  // Какой текст по состоянию плана
  let mood = 'ok';
  let moodLabel = 'идём в плане';
  let moodIcon = '✓';
  if (f.status && /угроз|разрыв|fail/i.test(f.status)) { mood = 'bad'; moodLabel = f.status; moodIcon = '⚠'; }
  else if (pct < 60) { mood = 'warn'; moodLabel = 'отстаём от плана'; moodIcon = '↓'; }
  else if (pct >= 100) { mood = 'great'; moodLabel = 'план перевыполнен'; moodIcon = '✓'; }

  // Период «План май» — название месяца
  const [yyyy, mm] = (summary.period || state.period || '').split('-');
  const months = ['', 'январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  const monthName = months[+mm] || '';

  el.innerHTML = `
    <div class="hero-card hero-${mood}">
      <div class="hero-icon">${moodIcon}</div>
      <div class="hero-body">
        <div class="hero-headline">
          План ${escapeHtml(monthName)} ${escapeHtml(yyyy || '')} — <b>${pct}%</b>
          <span class="hero-mood">${escapeHtml(moodLabel)}</span>
        </div>
        <div class="hero-sub">
          Факт <b>${fmtMoneyShort(t.fact || 0)}</b> из ${fmtMoneyShort(t.plan || 0)}
          ${gap > 0 ? `· до конца месяца нужно ещё <b class="hero-gap">${fmtMoneyShort(gap)}</b>` : ''}
          ${f.runwayGap ? `· прогноз разрыва: <b>${fmtMoneyShort(f.runwayGap)}</b>` : ''}
        </div>
        ${lagging.length ? `<div class="hero-lists">
          <div class="hero-list">
            <div class="hero-list-title">⬇ Отстают</div>
            ${lagging.map(s => `<div class="hero-store hero-store-bad">${escapeHtml(s.storeName)} <b>${s.percent}%</b></div>`).join('')}
          </div>
          <div class="hero-list">
            <div class="hero-list-title">⬆ Лидеры</div>
            ${leaders.map(s => `<div class="hero-store hero-store-good">${escapeHtml(s.storeName)} <b>${s.percent}%</b></div>`).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>
  `;
  el.classList.remove('hidden');
}

function renderKpis(summary) {
  const f = summary.forecast;
  const c = summary.comparison;
  const planIncomplete = summary?.planHealth && summary.planHealth.ok === false;
  const deltaArrow = c?.hasData && c.factDelta > 0 ? '↑' : c?.hasData && c.factDelta < 0 ? '↓' : '';
  const deltaTxt = c?.hasData ? ` ${deltaArrow}${c.factDeltaPercent > 0 ? '+' : ''}${c.factDeltaPercent}%` : '';

  // При неполном плане искажённые KPI прячем за «—», чтобы не вводить в заблуждение
  const completionVal = planIncomplete ? '—' : `${summary.totals.completion}%`;
  const completionTone = planIncomplete ? 'neutral' : pctTone(summary.totals.completion);
  const completionSub  = planIncomplete ? 'план неполный' : '';

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

  const cards = [
    { label: 'План сети',  value: formatMoney(summary.totals.plan),   sub: (planIncomplete ? 'возможно неполный' : '') + vsPrev('plan'), tone: 'neutral' },
    { label: 'Факт сети',  value: formatMoney(summary.totals.fact),   sub: deltaTxt + vsPrev('fact'), tone: 'neutral' },
    { label: 'Выполнение', value: completionVal,                       sub: completionSub + vsPrev('completion'), tone: completionTone },
    { label: 'Маржа',      value: formatMoney(summary.totals.margin), sub: (isNum(summary.totals.marginPct) ? `${summary.totals.marginPct}% от выр.` : 'нет данных от 1С') + vsPrev('margin'), tone: !isNum(summary.totals.margin) ? 'neutral' : summary.totals.margin >= 0 ? 'good' : 'bad', cls: 'kpi-margin' },
    { label: 'Прогноз',    value: projectedVal,                       sub: projectedSub,  tone: projectedTone },
    { label: 'Нужно/день', value: requiredVal,                        sub: requiredSub,   tone: requiredTone }
  ];
  $('kpis').innerHTML = cards.map(c => `
    <article class="kpi ${c.tone} ${c.cls || ''}">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
      ${c.sub ? `<div class="kpi-sub">${c.sub}</div>` : ''}
    </article>`).join('');
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
  const lPctStr  = planIncomplete ? formatMoney(l?.fact || 0)  : `${l ? l.percent : 0}%`;
  const lgPctStr = planIncomplete ? formatMoney(lg?.fact || 0) : `${lg ? lg.percent : 0}%`;
  const lMeta    = planIncomplete ? 'факт (% при неполном плане)' : (l ? formatMoney(l.fact) : '');
  const lgMeta   = planIncomplete ? 'факт (% при неполном плане)' : (lg ? formatMoney(lg.gap) : '');
  $('spotlight').innerHTML = `
    <div class="spot-card leader">
      <div class="spot-label">Лидер</div>
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

  $('storesTable').innerHTML = sorted.map((s, idx) => {
    const avgCheck = s.quantity > 0 ? s.fact / s.quantity : 0;
    const tone = pctTone(s.percent);
    // Тренд-индикатор
    const prev = prevPct[s.storeId];
    let trendHtml;
    if (typeof prev === 'number' && prev > 0) {
      const delta = (s.percent || 0) - prev;
      const arr = delta > 1 ? '↑' : delta < -1 ? '↓' : '→';
      const trTone = delta > 1 ? 'good' : delta < -1 ? 'bad' : 'neutral';
      trendHtml = `<span class="trend-cell ${trTone}" title="vs прошлый месяц: ${prev}% → ${s.percent}%">${arr} ${delta > 0 ? '+' : ''}${delta.toFixed(0)} п.п.</span>`;
    } else {
      trendHtml = `<span class="trend-cell neutral" title="Нет данных за прошлый месяц">—</span>`;
    }
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
    { title: 'Сбросить закреплённые блоки', sub: 'Вернуть исходный порядок секций', run: () => resetPinned() },
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

function openAiChat() {
  $('aiChatWidget')?.classList.remove('hidden');
  localStorage.setItem(AI_CHAT_OPEN_KEY, '1');
  renderAiChatMessages();
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

// Сборка таблиц всего видимого таба в один TSV (Excel-friendly).
// Каждая таблица отдельной секцией с заголовком.
// ─── Закладки/избранное на панелях ────────────────────────────────────────
// v2: сбрасываем старые закладки (после перестройки порядка секций они могли
// тащить блоки на верх и ломать новый порядок).
const PINNED_KEY = 'maria_pinned_panels_v2';
try { localStorage.removeItem('maria_pinned_panels_v1'); } catch {}
function getPinned() {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) || '[]')); }
  catch { return new Set(); }
}
function setPinned(set) {
  localStorage.setItem(PINNED_KEY, JSON.stringify([...set]));
}
function slugifyPanel(text) {
  return String(text || '').toLowerCase()
    .replace(/[^а-яёa-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
function enhancePinningInSection(rootEl) {
  if (!rootEl) return;
  const pinned = getPinned();
  const panels = Array.from(rootEl.querySelectorAll('.panel, .section'));
  // Карта: panel → wrapper (.section если есть, иначе .panel)
  for (const panel of panels) {
    // Берём только панели с заголовком — без заголовка пиновать нечего
    const titleEl = panel.querySelector(':scope > .panel-header .panel-title, :scope > .section-header .section-label, :scope > .section-label');
    if (!titleEl) continue;
    const id = slugifyPanel(titleEl.textContent);
    if (!id) continue;
    panel.dataset.pinId = id;
    // Добавляем кнопку если её ещё нет
    if (!panel.querySelector(':scope > .pin-btn-host > .pin-btn')) {
      const host = document.createElement('span');
      host.className = 'pin-btn-host';
      host.innerHTML = `<button class="pin-btn ${pinned.has(id) ? 'pinned' : ''}" title="Закрепить наверху" aria-label="Закрепить">★</button>`;
      // Вставляем рядом с заголовком
      titleEl.appendChild(host);
      host.querySelector('.pin-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const pset = getPinned();
        if (pset.has(id)) pset.delete(id); else pset.add(id);
        setPinned(pset);
        applyPinnedOrder();
      });
    }
  }
  applyPinnedOrder();
}
function applyPinnedOrder() {
  const pinned = getPinned();
  document.querySelectorAll('[data-pin-id]').forEach(p => {
    const isPinned = pinned.has(p.dataset.pinId);
    p.classList.toggle('panel-pinned', isPinned);
    const btn = p.querySelector('.pin-btn');
    if (btn) btn.classList.toggle('pinned', isPinned);
  });
  // КРИТИЧНО: если нет закреплённых — НЕ делаем appendChild. Иначе при каждом
  // обновлении дашборда (каждые 15 мин через scheduler) DOM пересобирается,
  // даже если результат идентичный — потенциальный source багов с порядком.
  if (pinned.size === 0) return;
  // Перемещаем pinned в начало внутри каждого таба/страницы
  const roots = [
    ...document.querySelectorAll('.atab-section:not(.hidden)'),
    document.querySelector('#page-dashboard:not(.hidden)')
  ].filter(Boolean);
  for (const root of roots) {
    const panels = Array.from(root.querySelectorAll(':scope > .panel[data-pin-id], :scope > .section[data-pin-id]'));
    // Stable sort: pinned первыми, остальные сохраняют порядок
    const sorted = panels.slice().sort((a, b) => {
      const pa = pinned.has(a.dataset.pinId) ? 0 : 1;
      const pb = pinned.has(b.dataset.pinId) ? 0 : 1;
      return pa - pb;
    });
    sorted.forEach(el => root.appendChild(el));
  }
}

function resetPinned() {
  localStorage.removeItem(PINNED_KEY);
  document.querySelectorAll('[data-pin-id]').forEach(p => {
    p.classList.remove('panel-pinned');
    p.querySelector('.pin-btn')?.classList.remove('pinned');
  });
  // Перезагрузка чтобы DOM-порядок вернулся к естественному из HTML
  setTimeout(() => window.location.reload(), 100);
}

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
  if (!state.selectedStoreId && summary.stores[0]) {
    state.selectedStoreId = summary.stores[0].storeId;
    $('storeDetailTitle').textContent = summary.stores[0].storeName;
  }

  applyMarginVisibility(summary);
  renderPlanHealth(summary);
  renderSummaryHero(summary);
  renderStickyMetrics(summary);
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

function enhancePinningOnPage() {
  // Вызывается после каждой загрузки данных — на случай новых динамических панелей
  enhancePinningInSection($('page-dashboard'));
  document.querySelectorAll('.atab-section:not(.hidden)').forEach(s => enhancePinningInSection(s));
}

function switchPage(page) {
  analyticsState.currentPage = page;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('nav-active', b.dataset.page === page));
  $('page-dashboard').classList.toggle('hidden', page !== 'dashboard');
  $('page-analytics').classList.toggle('hidden', page !== 'analytics');
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

