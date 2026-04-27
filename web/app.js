// ── State ──────────────────────────────────────────────────────────────────
const state = {
  period: '',
  selectedStoreId: '',
  activeTab: 'sales',
  summary: null,
  marketing: null,
  storeSort: { key: 'percent', dir: -1 },
  productSort: 'fact',
  budget: Number(localStorage.getItem('mkt_budget') || 0)
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Formatters ─────────────────────────────────────────────────────────────
function formatMoney(v) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(v || 0);
}
function formatNum(v) { return new Intl.NumberFormat('ru-RU').format(v || 0); }
function formatRatio(v) { return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v || 0); }
function formatDate(v) {
  if (!v) return 'нет';
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toLocaleString('ru-RU');
}
function pctTone(v) { return v >= 100 ? 'good' : v >= 80 ? 'warn' : 'bad'; }
function roasTone(v) { return v >= 4 ? 'good' : v >= 2 ? 'warn' : 'bad'; }
function signed(v, fmt) { return `${v > 0 ? '+' : ''}${fmt(v)}`; }
function fmtAxis(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}М`;
  if (v >= 1000) return `${(v / 1000).toFixed(0)}К`;
  return String(Math.round(v));
}

// ── HTTP ───────────────────────────────────────────────────────────────────
async function fetchJson(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: 'Ошибка запроса' }));
    throw new Error(b.error || 'Ошибка запроса');
  }
  return res.json();
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
  if (tab === 'reports' && state.summary) renderReports(state.summary, state.marketing);
  if (tab === 'marketing' && state.summary) renderMarketingDynamics();
}

// ── SVG: trend line chart ──────────────────────────────────────────────────
function renderTrendChart(summary) {
  const el = $('trendChart');
  const pts = (summary.trend?.periods || []).filter(p => p.plan > 0 || p.fact > 0);
  if (pts.length < 2) { el.innerHTML = '<div class="details-empty">Недостаточно данных для графика.</div>'; return; }

  const W = 560, H = 240, pad = { t: 24, r: 20, b: 46, l: 68 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b, n = pts.length;
  const maxVal = Math.max(...pts.flatMap(p => [p.plan, p.fact]), 1);
  const xp = i => pad.l + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
  const yp = v => pad.t + ph - (v / maxVal) * ph;

  const grids = Array.from({ length: 5 }, (_, i) => {
    const v = maxVal / 4 * i, y = yp(v);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + pw}" y2="${y.toFixed(1)}" stroke="#ece4d8" stroke-width="1"/>
    <text x="${pad.l - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#9ca3af" font-size="11">${fmtAxis(v)}</text>`;
  }).join('');

  const planD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xp(i).toFixed(1)},${yp(p.plan).toFixed(1)}`).join(' ');
  const factD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xp(i).toFixed(1)},${yp(p.fact).toFixed(1)}`).join(' ');
  const areaD = `${factD} L${xp(n - 1).toFixed(1)},${(pad.t + ph).toFixed(1)} L${xp(0).toFixed(1)},${(pad.t + ph).toFixed(1)} Z`;

  const dots = pts.map((p, i) => {
    const clr = p.completion >= 100 ? '#16a34a' : p.completion >= 80 ? '#f59e0b' : '#ef4444';
    return `<circle cx="${xp(i).toFixed(1)}" cy="${yp(p.fact).toFixed(1)}" r="5" fill="${clr}" stroke="white" stroke-width="2"/>
    <circle cx="${xp(i).toFixed(1)}" cy="${yp(p.plan).toFixed(1)}" r="3" fill="white" stroke="#9ca3af" stroke-width="1.5"/>
    <text x="${xp(i).toFixed(1)}" y="${(yp(p.fact) - 10).toFixed(1)}" text-anchor="middle" fill="#6b7280" font-size="10">${p.completion}%</text>`;
  }).join('');

  const xlabels = pts.map((p, i) =>
    `<text x="${xp(i).toFixed(1)}" y="${(pad.t + ph + 18).toFixed(1)}" text-anchor="middle" fill="#9ca3af" font-size="11">${p.period}</text>`
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
    <path d="${planD}" fill="none" stroke="#d1d5db" stroke-width="2" stroke-dasharray="6,4"/>
    <path d="${factD}" fill="none" stroke="#0f766e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}${xlabels}
    <text x="${pad.l}" y="${H - 4}" fill="#9ca3af" font-size="10">─ ─ план</text>
    <text x="${pad.l + 54}" y="${H - 4}" fill="#0f766e" font-size="10">─── факт</text>
  </svg>`;
}

// ── SVG: daily bar chart ───────────────────────────────────────────────────
function renderDailyChart(summary) {
  const el = $('dailyChart');
  const rows = summary.daily || [];
  const elapsed = summary.forecast.elapsedDays || rows.length;
  const vis = rows.slice(0, Math.max(elapsed, 5));
  if (!vis.length) { el.innerHTML = '<div class="details-empty">Нет дневных данных.</div>'; return; }

  const W = 560, H = 220, pad = { t: 16, r: 20, b: 34, l: 68 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b, n = vis.length;
  const maxVal = Math.max(...vis.flatMap(r => [r.plan, r.fact]), 1);
  const slot = pw / n, barW = Math.max(slot * 0.5, 3);
  const yp = v => pad.t + ph - (v / maxVal) * ph;
  const bh = v => Math.max((v / maxVal) * ph, 0);

  const grids = Array.from({ length: 4 }, (_, i) => {
    const v = maxVal / 3 * i, y = yp(v);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + pw}" y2="${y.toFixed(1)}" stroke="#ece4d8" stroke-width="1"/>
    <text x="${pad.l - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#9ca3af" font-size="11">${fmtAxis(v)}</text>`;
  }).join('');

  const bars = vis.map((row, i) => {
    const cx = pad.l + i * slot + slot / 2;
    const clr = row.percent >= 100 ? '#16a34a' : row.percent >= 80 ? '#f59e0b' : '#ef4444';
    const showLabel = i === 0 || (i + 1) % 5 === 0 || i === n - 1;
    return `<rect x="${(cx - barW / 2 - 1).toFixed(1)}" y="${yp(row.plan).toFixed(1)}" width="${(barW + 2).toFixed(1)}" height="${bh(row.plan).toFixed(1)}" rx="2" fill="#ddd6cc"/>
    <rect x="${(cx - barW / 2).toFixed(1)}" y="${yp(row.fact).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh(row.fact).toFixed(1)}" rx="2" fill="${clr}" opacity="0.88"/>
    ${showLabel ? `<text x="${cx.toFixed(1)}" y="${(pad.t + ph + 14).toFixed(1)}" text-anchor="middle" fill="#9ca3af" font-size="10">${row.day}</text>` : ''}`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    ${grids}${bars}
    <text x="${pad.l}" y="${H - 2}" fill="#9ca3af" font-size="10">▭ план   ▮ факт</text>
  </svg>`;
}

// ── Sparkline ──────────────────────────────────────────────────────────────
function sparkline(pct) {
  const clr = pct >= 100 ? '#16a34a' : pct >= 80 ? '#f59e0b' : '#ef4444';
  return `<div class="spark-wrap"><div class="spark-bar" style="width:${Math.min(pct, 140)}%;background:${clr}"></div></div>`;
}

// ── Sales tab renders ──────────────────────────────────────────────────────
function renderKpis(summary) {
  const f = summary.forecast;
  const cards = [
    { label: 'План сети',    value: formatMoney(summary.totals.plan),              tone: 'neutral' },
    { label: 'Факт сети',    value: formatMoney(summary.totals.fact),              tone: 'neutral' },
    { label: 'Выполнение',   value: `${summary.totals.completion}%`,               tone: pctTone(summary.totals.completion) },
    { label: 'Маржа',        value: formatMoney(summary.totals.margin),            tone: summary.totals.margin >= 0 ? 'good' : 'bad' },
    { label: 'Маржа %',      value: `${summary.totals.marginPct}%`,               tone: summary.totals.marginPct >= 20 ? 'good' : summary.totals.marginPct >= 10 ? 'warn' : 'bad' },
    { label: 'Прогноз',      value: formatMoney(f.projectedFact),                  tone: f.tone },
    { label: 'Нужно/день',   value: formatMoney(f.requiredPerDayToPlan),           tone: f.requiredPerDayToPlan > f.averagePerDay ? 'bad' : 'good' },
    { label: 'Продано, шт',  value: formatNum(summary.totals.quantity),            tone: 'neutral' }
  ];
  $('kpis').innerHTML = cards.map(c => `
    <article class="kpi ${c.tone}">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
    </article>`).join('');
}

function renderForecast(summary) {
  const f = summary.forecast;
  const paceTone = f.paceVsPlan >= 100 ? 'good' : f.paceVsPlan >= 90 ? 'warn' : 'bad';
  $('forecastPanel').innerHTML = `
    <article class="forecast-card ${f.tone}">
      <div class="forecast-kicker">Прогноз</div>
      <div class="forecast-title">${f.status}</div>
      <div class="forecast-metrics">
        <div><span>К концу месяца</span><strong>${formatMoney(f.projectedFact)}</strong></div>
        <div><span>Ожидаемое %</span><strong>${f.projectedCompletion}%</strong></div>
        <div><span>Разрыв прогноза</span><strong class="${f.runwayGap >= 0 ? 'positive' : 'negative'}">${formatMoney(f.runwayGap)}</strong></div>
      </div>
    </article>
    <article class="forecast-card neutral">
      <div class="forecast-kicker">Ритм</div>
      <div class="forecast-title">Ежедневный темп</div>
      <div class="forecast-metrics">
        <div><span>Средний факт/день</span><strong>${formatMoney(f.averagePerDay)}</strong></div>
        <div><span>План/день</span><strong>${formatMoney(f.planPerDay)}</strong></div>
        <div><span>Нужно до плана</span><strong>${formatMoney(f.requiredPerDayToPlan)}</strong></div>
      </div>
    </article>
    <article class="forecast-card ${paceTone}">
      <div class="forecast-kicker">Период</div>
      <div class="forecast-title">Где мы сейчас</div>
      <div class="forecast-metrics">
        <div><span>Прошло дней</span><strong>${f.elapsedDays} / ${f.totalDays}</strong></div>
        <div><span>Осталось</span><strong>${f.remainingDays} дн.</strong></div>
        <div><span>Темп к плану</span><strong>${f.paceVsPlan}%</strong></div>
      </div>
    </article>`;
}

function renderComparison(summary) {
  const c = summary.comparison;
  if (!c?.hasData) {
    $('comparisonPanel').innerHTML = '<div class="details-empty">Нет данных за предыдущий период.</div>';
    return;
  }
  $('comparisonPanel').innerHTML = `
    <div class="comparison-card ${c.tone}">
      <div class="comparison-kicker">vs. предыдущий период</div>
      <div class="comparison-title">${c.previousPeriod}</div>
      <div class="comparison-list">
        <div><span>Факт</span><strong class="${c.factDelta >= 0 ? 'positive' : 'negative'}">${signed(c.factDelta, formatMoney)}</strong></div>
        <div><span>Изм. %</span><strong class="${c.factDelta >= 0 ? 'positive' : 'negative'}">${signed(c.factDeltaPercent, v => v.toFixed(1) + '%')}</strong></div>
        <div><span>Выполнение</span><strong class="${c.completionDelta >= 0 ? 'positive' : 'negative'}">${signed(c.completionDelta, v => v.toFixed(1) + ' п.п.')}</strong></div>
        <div><span>Маржа</span><strong class="${c.marginDelta >= 0 ? 'positive' : 'negative'}">${signed(c.marginDelta, formatMoney)}</strong></div>
        <div><span>Количество</span><strong class="${c.quantityDelta >= 0 ? 'positive' : 'negative'}">${signed(c.quantityDelta, formatNum)}</strong></div>
      </div>
    </div>`;
}

function renderStores(summary) {
  const { key, dir } = state.storeSort;
  const sorted = [...summary.stores].sort((a, b) => {
    if (typeof a[key] === 'string') return a[key].localeCompare(b[key]) * dir;
    return (a[key] - b[key]) * dir;
  });

  document.querySelectorAll('#storesTableEl th.sortable').forEach(th => {
    const labels = { storeName: 'Точка', plan: 'План', fact: 'Факт', percent: '%', margin: 'Маржа', marginPct: 'Марж.%', gap: 'Откл.' };
    th.textContent = labels[th.dataset.sort] + (th.dataset.sort === key ? (dir === -1 ? ' ↓' : ' ↑') : '');
  });

  $('storesTable').innerHTML = sorted.map(s => `
    <tr data-store-id="${s.storeId}" class="${state.selectedStoreId === s.storeId ? 'active' : ''}">
      <td>
        <button class="store-button" data-store-id="${s.storeId}">
          <span>${s.storeName}</span>
          <small>${s.region || '—'}</small>
        </button>
      </td>
      <td>${formatMoney(s.plan)}</td>
      <td>${formatMoney(s.fact)}</td>
      <td>
        <div class="progress-row">
          <span class="progress-value ${pctTone(s.percent)}">${s.percent}%</span>
          <div class="progress-track"><div class="progress-bar ${pctTone(s.percent)}" style="width:${Math.min(s.percent, 140)}%"></div></div>
        </div>
      </td>
      <td class="${s.margin >= 0 ? 'positive' : 'negative'}">${formatMoney(s.margin)}</td>
      <td class="${s.marginPct >= 20 ? 'good' : s.marginPct >= 10 ? 'warn' : 'bad'}">${s.marginPct}%</td>
      <td class="${s.gap >= 0 ? 'positive' : 'negative'}">${formatMoney(s.gap)}</td>
      <td>${sparkline(s.percent)}</td>
    </tr>`).join('');

  document.querySelectorAll('.store-button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedStoreId = btn.dataset.storeId;
      renderStores(summary);
      loadStoreDetails();
    });
  });
}

function renderProducts(summary) {
  const sorted = [...summary.products].sort((a, b) => b[state.productSort] - a[state.productSort]);
  $('productsList').innerHTML = sorted.map(p => `
    <div class="rank-item">
      <div class="rank-head">
        <div>
          <div class="rank-title">${p.productName}</div>
          <div class="rank-subtitle">${p.category || 'Без категории'}</div>
        </div>
        <div class="rank-metric ${pctTone(p.percent)}">${p.percent}%</div>
      </div>
      <div class="progress-track"><div class="progress-bar ${pctTone(p.percent)}" style="width:${Math.min(p.percent, 140)}%"></div></div>
      <div class="rank-foot">
        <span>Факт: ${formatMoney(p.fact)}</span>
        <span>Маржа: ${formatMoney(p.margin)}</span>
        <span>Шт: ${formatNum(p.quantity)}</span>
      </div>
    </div>`).join('');
}

function renderSpotlight(summary) {
  const l = summary.leader, lg = summary.lagger;
  $('spotlight').innerHTML = `
    <div class="spot-card leader">
      <div class="spot-label">Лидер</div>
      <div class="spot-title">${l ? l.storeName : '—'}</div>
      <div class="spot-value">${l ? l.percent : 0}%</div>
      <div class="spot-meta">${l ? formatMoney(l.fact) : ''}</div>
    </div>
    <div class="spot-card lagger">
      <div class="spot-label">Риск</div>
      <div class="spot-title">${lg ? lg.storeName : '—'}</div>
      <div class="spot-value">${lg ? lg.percent : 0}%</div>
      <div class="spot-meta">${lg ? formatMoney(lg.gap) : ''}</div>
    </div>
    <div class="spot-card neutral">
      <div class="spot-label">Последняя продажа</div>
      <div class="spot-title">${formatDate(summary.lastSaleAt)}</div>
      <div class="spot-meta">Период ${summary.period}</div>
    </div>`;
}

function renderMarketTrend() {
  $('marketTrend').innerHTML = `
    <div class="market-trend-item">
      <div class="market-trend-label">Иркутск · Кондитерский рынок</div>
      <div class="muted" style="font-size:13px">Для отображения подключите источник рыночной аналитики</div>
    </div>
    <div class="market-trend-item">
      <div class="market-trend-label">Россия · Отрасль (Росстат / ЕМИСС)</div>
      <div class="muted" style="font-size:13px">Источник не подключён</div>
    </div>
    <div class="market-trend-item">
      <div class="market-trend-label">Сезонность спроса</div>
      <div class="muted" style="font-size:13px">Подключите Яндекс Wordstat для анализа</div>
    </div>`;
}

// ── Marketing tab renders ──────────────────────────────────────────────────
function renderMarketingKpis(marketing, budget) {
  const spend = budget > 0 ? budget : marketing.totals.spend;
  const roi = spend > 0 ? ((marketing.totals.revenue - spend) / spend * 100) : 0;
  const cards = [
    { label: 'Расход',       value: formatMoney(marketing.totals.spend),  tone: 'neutral' },
    { label: 'Выручка (атр.)', value: formatMoney(marketing.totals.revenue), tone: 'neutral' },
    { label: 'ROAS',         value: formatRatio(marketing.totals.roas),   tone: roasTone(marketing.totals.roas) },
    { label: 'ROI',          value: `${roi.toFixed(1)}%`,                  tone: roi >= 100 ? 'good' : roi >= 0 ? 'warn' : 'bad' },
    { label: 'CPL',          value: formatMoney(marketing.totals.cpl),    tone: 'neutral' },
    { label: 'CAC',          value: formatMoney(marketing.totals.cac),    tone: 'neutral' },
    { label: 'Лиды',         value: formatNum(marketing.totals.leads),    tone: 'neutral' },
    { label: 'Заказы',       value: formatNum(marketing.totals.orders),   tone: 'neutral' }
  ];
  $('marketingKpis').innerHTML = cards.map(c => `
    <article class="kpi ${c.tone}">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
    </article>`).join('');
}

function renderMarketingChannels(marketing) {
  const el = $('marketingChannels');
  if (!marketing.channels.length) {
    el.innerHTML = '<div class="details-empty">Нет данных за период. Загрузите данные через API или подключите источник.</div>';
    return;
  }
  el.innerHTML = marketing.channels.map(ch => {
    const roi = ch.spend > 0 ? ((ch.revenue - ch.spend) / ch.spend * 100) : 0;
    const roiTone = roi >= 100 ? 'good' : roi >= 0 ? 'warn' : 'bad';
    return `
    <div class="rank-item">
      <div class="rank-head">
        <div>
          <div class="rank-title">${ch.channelName}</div>
          <div class="rank-subtitle">Лиды: ${formatNum(ch.leads)} · Заказы: ${formatNum(ch.orders)} · CTR: ${ch.ctr}% · CVR: ${ch.cvr}%</div>
        </div>
        <div class="channel-badges">
          <span class="badge-metric ${roasTone(ch.roas)}">ROAS ${formatRatio(ch.roas)}</span>
          <span class="badge-metric ${roiTone}">ROI ${roi.toFixed(0)}%</span>
        </div>
      </div>
      <div class="progress-track"><div class="progress-bar ${roasTone(ch.roas)}" style="width:${Math.min(ch.roas * 25, 100)}%"></div></div>
      <div class="rank-foot">
        <span>Расход: ${formatMoney(ch.spend)}</span>
        <span>Выручка: ${formatMoney(ch.revenue)}</span>
        <span>CPL: ${formatMoney(ch.cpl)}</span>
        <span>CAC: ${formatMoney(ch.cac)}</span>
        <span>AOV: ${formatMoney(ch.aov)}</span>
      </div>
    </div>`;
  }).join('');
}

function updateRoiResult(marketing) {
  const el = $('roiResult');
  const budget = parseFloat($('roiBudget').value) || state.budget;
  if (!budget) { el.innerHTML = '<div class="muted" style="margin-top:8px">Введите бюджет для расчёта ROI</div>'; return; }
  const rev = marketing.totals.revenue;
  const roi = ((rev - budget) / budget * 100);
  const roas = rev / budget;
  el.innerHTML = `
    <div class="roi-metrics">
      <div><span>Выручка маркетинга</span><strong>${formatMoney(rev)}</strong></div>
      <div><span>Введённый бюджет</span><strong>${formatMoney(budget)}</strong></div>
      <div><span>ROI</span><strong class="${roi >= 100 ? 'positive' : roi >= 0 ? '' : 'negative'}">${roi.toFixed(1)}%</strong></div>
      <div><span>ROAS (по бюджету)</span><strong class="${roasTone(roas)}">${roas.toFixed(2)}</strong></div>
    </div>`;
}

function renderMarketingDynamics() {
  const el = $('marketingDynamics');
  if (!state.summary || !state.marketing) { el.innerHTML = '<div class="muted">Загрузка...</div>'; return; }
  const m = state.marketing, s = state.summary;
  const improved = [], worsened = [], recs = [];

  if (s.comparison?.hasData) {
    const c = s.comparison;
    if (c.factDelta > 0) improved.push(`Выручка выросла на ${formatMoney(c.factDelta)} (+${c.factDeltaPercent.toFixed(1)}%)`);
    else worsened.push(`Выручка упала на ${formatMoney(Math.abs(c.factDelta))} (${c.factDeltaPercent.toFixed(1)}%)`);
    if (c.completionDelta > 0) improved.push(`Выполнение плана улучшилось на ${c.completionDelta.toFixed(1)} п.п.`);
    else if (c.completionDelta < 0) worsened.push(`Выполнение плана упало на ${Math.abs(c.completionDelta).toFixed(1)} п.п.`);
    if (c.marginDelta > 0) improved.push(`Маржа выросла на ${formatMoney(c.marginDelta)}`);
    else if (c.marginDelta < 0) worsened.push(`Маржа упала на ${formatMoney(Math.abs(c.marginDelta))}`);
  }

  if (m.totals.roas >= 4) improved.push(`ROAS ${m.totals.roas} — отличная маркетинговая эффективность`);
  else if (m.totals.roas < 2) worsened.push(`ROAS ${m.totals.roas} — маркетинг не окупается`);

  if (m.totals.ctr >= 1.5) improved.push(`CTR ${m.totals.ctr}% — хорошая кликабельность объявлений`);
  else worsened.push(`CTR ${m.totals.ctr}% — низкая кликабельность объявлений`);

  if (s.forecast.projectedCompletion >= 100) improved.push(`Прогноз: план закрывается по текущему темпу`);
  else worsened.push(`Прогноз выполнения: ${s.forecast.projectedCompletion}% — план под угрозой`);

  if (s.forecast.projectedCompletion < 100)
    recs.push(`Увеличить среднедневную выручку до ${formatMoney(s.forecast.requiredPerDayToPlan)}/день`);
  if (m.totals.roas < 3) recs.push('Перераспределить бюджет в каналы с ROAS > 3');
  if (m.totals.ctr < 1.5) recs.push('Обновить рекламные креативы — низкий CTR указывает на слабый оффер');
  if (m.totals.cvr < 2) recs.push('Проверить посадочные страницы и скорость ответа менеджеров');
  if (m.bestChannel) recs.push(`Масштабировать "${m.bestChannel.channelName}" — лучший ROAS ${m.bestChannel.roas}`);
  if (m.worstChannel && m.worstChannel !== m.bestChannel)
    recs.push(`Пересмотреть бюджет "${m.worstChannel.channelName}" — низкий ROAS ${m.worstChannel.roas}`);

  const block = (title, items, cls) => !items.length ? '' : `
    <div class="dynamics-block ${cls}">
      <div class="dynamics-label">${title}</div>
      <ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>
    </div>`;

  el.innerHTML = block('✓ Улучшилось', improved, 'good') +
    block('✗ Ухудшилось', worsened, 'bad') +
    block('Рекомендации', recs, 'neutral') ||
    '<div class="muted">Нет данных для сравнения.</div>';
}

function renderAnalysis(analysis) {
  const warn = analysis.warnings.length
    ? `<div class="analysis-block"><div class="analysis-label">Риски</div>
       <ul class="analysis-list">${analysis.warnings.map(i => `<li>${i}</li>`).join('')}</ul></div>` : '';
  $('analysisPanel').innerHTML = `
    <div class="analysis-summary">${analysis.summary}</div>
    <div class="analysis-block"><div class="analysis-label">Выводы</div>
    <ul class="analysis-list">${analysis.insights.map(i => `<li>${i}</li>`).join('')}</ul></div>
    ${warn}
    <div class="analysis-block"><div class="analysis-label">Рекомендации</div>
    <ul class="analysis-list">${analysis.recommendations.map(i => `<li>${i}</li>`).join('')}</ul></div>
    <div class="analysis-footer">Сформировано: ${formatDate(analysis.generatedAt)}</div>`;
  const s = $('analysisStatus');
  if (s) s.textContent = `обновлён: ${formatDate(analysis.generatedAt)}`;
}

// ── Reports tab renders ────────────────────────────────────────────────────
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

function renderAbcTable(elId, items) {
  const el = $(elId);
  if (!items.length) { el.innerHTML = '<div class="details-empty">Нет данных.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
    <th>№</th><th>Наименование</th><th>Выручка</th><th>Доля</th><th>Накоп.</th><th>Группа</th>
  </tr></thead><tbody>
    ${items.map(i => `<tr>
      <td>${i.rank}</td>
      <td>${i.name}</td>
      <td>${formatMoney(i.value)}</td>
      <td>${i.share.toFixed(1)}%</td>
      <td>${i.cumPct.toFixed(1)}%</td>
      <td><span class="abc-badge abc-${i.abc}">${i.abc}</span></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function renderRoiReport(marketing) {
  const el = $('roiReport');
  if (!marketing?.channels.length) { el.innerHTML = '<div class="details-empty">Нет маркетинговых данных.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
    <th>Канал</th><th>Расход</th><th>Выручка</th><th>ROAS</th><th>ROI</th><th>CPL</th><th>CAC</th>
  </tr></thead><tbody>
    ${marketing.channels.map(ch => {
      const roi = ch.spend > 0 ? ((ch.revenue - ch.spend) / ch.spend * 100) : 0;
      return `<tr>
        <td>${ch.channelName}</td>
        <td>${formatMoney(ch.spend)}</td>
        <td>${formatMoney(ch.revenue)}</td>
        <td class="${roasTone(ch.roas)}">${formatRatio(ch.roas)}</td>
        <td class="${roi >= 100 ? 'positive' : roi < 0 ? 'negative' : ''}">${roi.toFixed(0)}%</td>
        <td>${formatMoney(ch.cpl)}</td>
        <td>${formatMoney(ch.cac)}</td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

function renderGrowthReport(summary) {
  const el = $('growthReport');
  const active = (summary.trend?.periods || []).filter(p => p.plan > 0 || p.fact > 0);
  if (active.length < 2) { el.innerHTML = '<div class="details-empty">Недостаточно данных.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
    <th>Период</th><th>Факт</th><th>Рост</th><th>Рост %</th><th>Вып. %</th><th>Маржа</th>
  </tr></thead><tbody>
    ${active.map((p, i) => {
      const prev = active[i - 1];
      const delta = prev ? p.fact - prev.fact : null;
      const deltaPct = prev && prev.fact > 0 ? delta / prev.fact * 100 : null;
      return `<tr class="${p.period === summary.period ? 'active' : ''}">
        <td>${p.period}</td>
        <td>${formatMoney(p.fact)}</td>
        <td>${delta !== null ? `<span class="${delta >= 0 ? 'positive' : 'negative'}">${signed(delta, formatMoney)}</span>` : '—'}</td>
        <td>${deltaPct !== null ? `<span class="${deltaPct >= 0 ? 'positive' : 'negative'}">${signed(deltaPct, v => v.toFixed(1) + '%')}</span>` : '—'}</td>
        <td><span class="${pctTone(p.completion)}">${p.completion}%</span></td>
        <td>${formatMoney(p.margin)}</td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

function renderSalesReport(summary) {
  const el = $('salesReport');
  el.innerHTML = `<table><thead><tr>
    <th>Точка</th><th>Факт</th><th>%</th><th>Маржа</th><th>Шт</th>
  </tr></thead><tbody>
    ${summary.stores.map(s => `<tr>
      <td>${s.storeName}</td>
      <td>${formatMoney(s.fact)}</td>
      <td><span class="${pctTone(s.percent)}">${s.percent}%</span></td>
      <td class="${s.margin >= 0 ? 'positive' : 'negative'}">${formatMoney(s.margin)}</td>
      <td>${formatNum(s.quantity)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function renderExecutive(summary) {
  const e = summary.executive;
  $('executivePanel').innerHTML = `
    <div class="executive-block">
      <div class="analysis-label">Ключевое</div>
      <ul class="analysis-list">${e.headlines.map(i => `<li>${i}</li>`).join('')}</ul>
    </div>
    <div class="executive-block">
      <div class="analysis-label">Приоритеты</div>
      <ul class="analysis-list">${e.priorities.map(i => `<li>${i}</li>`).join('')}</ul>
    </div>
    <div class="executive-block">
      <div class="analysis-label">Риски</div>
      <ul class="analysis-list">${e.alerts.map(i => `<li>${i}</li>`).join('')}</ul>
    </div>
    <div class="analysis-footer">Сформировано: ${formatDate(e.generatedAt)}</div>`;
}

function renderReports(summary, marketing) {
  renderAbcTable('abcProducts', computeAbc(summary.products, 'fact', 'productName'));
  renderAbcTable('abcStores', computeAbc(summary.stores, 'fact', 'storeName'));
  renderRoiReport(marketing);
  renderGrowthReport(summary);
  renderSalesReport(summary);
  renderExecutive(summary);
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
}

async function loadStoreDetails() {
  const el = $('storeDetails');
  if (!state.selectedStoreId) { el.innerHTML = 'Выберите точку в таблице.'; return; }
  const d = await fetchJson(`/api/dashboard/store?period=${encodeURIComponent(state.period)}&storeId=${encodeURIComponent(state.selectedStoreId)}`);
  el.innerHTML = `
    <div class="details-title">${d.store.name}</div>
    <div class="details-subtitle">${d.store.region || '—'}</div>
    <div class="details-list">
      ${d.items.map(item => `
        <div class="details-row">
          <div>
            <div class="details-product">${item.productName}</div>
            <div class="details-category">${item.category || 'Без категории'}</div>
          </div>
          <div class="details-metrics">
            <span>${formatMoney(item.fact)}</span>
            <strong class="${pctTone(item.percent)}">${item.percent}%</strong>
          </div>
        </div>`).join('')}
    </div>`;
}

async function loadSummary() {
  if (!state.period) return;
  const [summary, marketing] = await Promise.all([
    fetchJson(`/api/dashboard/summary?period=${encodeURIComponent(state.period)}`),
    fetchJson(`/api/dashboard/marketing?period=${encodeURIComponent(state.period)}`)
  ]);
  state.summary = summary;
  state.marketing = marketing;
  if (!state.selectedStoreId && summary.stores[0]) state.selectedStoreId = summary.stores[0].storeId;

  renderKpis(summary);
  renderForecast(summary);
  renderTrendChart(summary);
  renderDailyChart(summary);
  renderComparison(summary);
  renderStores(summary);
  renderProducts(summary);
  renderSpotlight(summary);
  renderMarketTrend();
  renderMarketingKpis(marketing, state.budget);
  renderMarketingChannels(marketing);
  updateRoiResult(marketing);
  await loadStoreDetails();

  if (state.activeTab === 'reports') renderReports(summary, marketing);
  if (state.activeTab === 'marketing') renderMarketingDynamics();

  $('lastUpdate').textContent = `обновлено: ${new Date().toLocaleTimeString('ru-RU')}`;
}

// ── SSE ────────────────────────────────────────────────────────────────────
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => {
    $('streamStatus').textContent = 'поток подключён';
    $('streamStatus').className = 'status-pill live';
  });
  const reload = async () => {
    $('streamStatus').textContent = 'обновление';
    $('streamStatus').className = 'status-pill syncing';
    await loadSummary();
    $('streamStatus').textContent = 'поток подключён';
    $('streamStatus').className = 'status-pill live';
  };
  ['sales_updated', 'plans_updated', 'marketing_updated'].forEach(e => es.addEventListener(e, reload));
  es.onerror = () => { $('streamStatus').textContent = 'переподключение'; $('streamStatus').className = 'status-pill idle'; };
}

// ── Marketing analysis ─────────────────────────────────────────────────────
async function runMarketingAnalysis() {
  const btn = $('runAnalysisButton');
  const status = $('analysisStatus');
  btn.disabled = true;
  btn.textContent = 'Считаю...';
  if (status) status.textContent = 'выполняется...';
  try {
    const analysis = await fetchJson('/api/analysis/marketing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period: state.period })
    });
    renderAnalysis(analysis);
  } catch (err) {
    $('analysisPanel').innerHTML = `<div class="details-empty">Ошибка: ${err.message}</div>`;
    if (status) status.textContent = 'ошибка';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Запустить анализ';
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  // Restore saved budget
  const budgetInput = $('totalBudgetInput');
  const roiBudgetInput = $('roiBudget');
  if (budgetInput) budgetInput.value = state.budget || '';
  if (roiBudgetInput) roiBudgetInput.value = state.budget || '';

  // Restore competitor notes
  const notesEl = $('competitorNotes');
  const savedNotes = localStorage.getItem('competitor_notes') || '';
  if (notesEl) notesEl.value = savedNotes;
  if (savedNotes) {
    const saved = $('competitorNotesSaved');
    if (saved) saved.innerHTML = `<div class="saved-note">${savedNotes.replace(/\n/g, '<br>')}</div>`;
  }

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Sortable headers
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

  // Budget input (ROI tab)
  if (roiBudgetInput) {
    roiBudgetInput.addEventListener('input', () => {
      state.budget = parseFloat(roiBudgetInput.value) || 0;
      localStorage.setItem('mkt_budget', state.budget);
      if (state.marketing) { updateRoiResult(state.marketing); renderMarketingKpis(state.marketing, state.budget); }
    });
  }

  // Budget save (sidebar)
  const saveBudgetBtn = $('saveBudgetBtn');
  if (saveBudgetBtn) {
    saveBudgetBtn.addEventListener('click', () => {
      const v = parseFloat(budgetInput?.value) || 0;
      state.budget = v;
      localStorage.setItem('mkt_budget', v);
      if (roiBudgetInput) roiBudgetInput.value = v || '';
      if (state.marketing) { updateRoiResult(state.marketing); renderMarketingKpis(state.marketing, state.budget); }
    });
  }

  // Competitor notes
  const saveNotesBtn = $('saveNotesBtn');
  if (saveNotesBtn) {
    saveNotesBtn.addEventListener('click', () => {
      const notes = notesEl?.value.trim() || '';
      localStorage.setItem('competitor_notes', notes);
      const saved = $('competitorNotesSaved');
      if (saved) saved.innerHTML = notes ? `<div class="saved-note">${notes.replace(/\n/g, '<br>')}</div>` : '';
    });
  }

  // Marketing analysis
  const analysisBtn = $('runAnalysisButton');
  if (analysisBtn) analysisBtn.addEventListener('click', runMarketingAnalysis);

  // Export: sales CSV
  const exportSales = () => {
    if (!state.summary) return;
    exportCsv(state.summary.stores.map(s => ({
      'Точка': s.storeName, 'Регион': s.region || '', 'План': s.plan, 'Факт': s.fact,
      'Выполнение%': s.percent, 'Маржа': s.margin, 'Маржа%': s.marginPct,
      'Отклонение': s.gap, 'Количество': s.quantity
    })), `sales-${state.period}.csv`);
  };
  $('exportSalesBtn')?.addEventListener('click', exportSales);
  $('exportSalesBtnHeader')?.addEventListener('click', exportSales);

  // Export: ABC CSV
  $('exportAbcBtn')?.addEventListener('click', () => {
    if (!state.summary) return;
    exportCsv(computeAbc(state.summary.products, 'fact', 'productName').map(i => ({
      '№': i.rank, 'Наименование': i.name, 'Выручка': i.value,
      'Доля%': i.share.toFixed(1), 'Накоп%': i.cumPct.toFixed(1), 'Группа': i.abc
    })), `abc-${state.period}.csv`);
  });

  // Export: ROI CSV
  $('exportRoiBtn')?.addEventListener('click', () => {
    if (!state.marketing?.channels.length) return;
    exportCsv(state.marketing.channels.map(ch => {
      const roi = ch.spend > 0 ? ((ch.revenue - ch.spend) / ch.spend * 100).toFixed(1) : 0;
      return { 'Канал': ch.channelName, 'Расход': ch.spend, 'Выручка': ch.revenue, 'ROAS': ch.roas, 'ROI%': roi, 'CPL': ch.cpl, 'CAC': ch.cac };
    }), `roi-${state.period}.csv`);
  });

  // Export: Growth CSV
  $('exportGrowthBtn')?.addEventListener('click', () => {
    if (!state.summary) return;
    const active = (state.summary.trend?.periods || []).filter(p => p.plan > 0 || p.fact > 0);
    exportCsv(active.map((p, i) => {
      const prev = active[i - 1];
      return { 'Период': p.period, 'Факт': p.fact, 'Рост': prev ? (p.fact - prev.fact).toFixed(0) : '', 'Выполнение%': p.completion, 'Маржа': p.margin };
    }), `growth-${state.period}.csv`);
  });

  // Integration connect buttons (placeholder)
  document.querySelectorAll('.badge-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      alert(`Для подключения «${btn.dataset.source}» передайте API-токен разработчику. Интеграция в разработке.`);
    });
  });

  // Main load
  try {
    await loadMetadata();
    await loadSummary();
    connectEvents();
    $('periodSelect').addEventListener('change', async e => {
      state.period = e.target.value;
      $('analysisPanel').innerHTML = 'Нажмите «Запустить анализ».';
      const s = $('analysisStatus');
      if (s) s.textContent = 'анализ не запускался';
      await loadSummary();
    });
    setInterval(loadSummary, 30000);
  } catch (err) {
    document.body.innerHTML = `<main class="fatal">Ошибка загрузки: ${err.message}</main>`;
  }
}

init();
