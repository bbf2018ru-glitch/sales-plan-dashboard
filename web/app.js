// ── State ──────────────────────────────────────────────────────────────────
const state = {
  period: '',
  selectedStoreId: '',
  activeTab: 'sales',
  summary: null,
  matrix: null,
  marketing: null,
  storeSort: { key: 'percent', dir: -1 },
  productSort: 'fact'
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
function pctTone(v) { return v >= 100 ? 'good' : v >= 80 ? 'warn' : 'bad'; }
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
  if (!vis.length) { el.innerHTML = '<div class="empty-state">Нет дневных данных.</div>'; return; }

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

// ── KPIs ───────────────────────────────────────────────────────────────────
function renderKpis(summary) {
  const f = summary.forecast;
  const cards = [
    { label: 'План сети',  value: formatMoney(summary.totals.plan),   tone: 'neutral' },
    { label: 'Факт сети',  value: formatMoney(summary.totals.fact),   tone: 'neutral' },
    { label: 'Выполнение', value: `${summary.totals.completion}%`,    tone: pctTone(summary.totals.completion) },
    { label: 'Маржа',      value: formatMoney(summary.totals.margin), tone: summary.totals.margin >= 0 ? 'good' : 'bad' },
    { label: 'Маржа %',    value: `${summary.totals.marginPct}%`,    tone: summary.totals.marginPct >= 20 ? 'good' : summary.totals.marginPct >= 10 ? 'warn' : 'bad' },
    { label: 'Прогноз',    value: formatMoney(f.projectedFact),       tone: f.tone }
  ];
  $('kpis').innerHTML = cards.map(c => `
    <article class="kpi ${c.tone}">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
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
    </tr>`;
  }).join('');

  document.querySelectorAll('#storesTable tr').forEach(row => {
    row.addEventListener('click', () => {
      state.selectedStoreId = row.dataset.storeId;
      const store = sorted.find(s => s.storeId === row.dataset.storeId);
      if (store) $('storeDetailTitle').textContent = store.storeName;
      renderStores(summary);
      loadStoreDetails();
    });
  });
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

// ── Reports accordion ─────────────────────────────────────────────────────
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
    arrow.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
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

// ── Market news content ────────────────────────────────────────────────────
const MARKET_NEWS = [
  {
    tag: 'Тренд', tone: 'accent',
    date: 'Апрель 2025',
    title: 'Бенто-торты: рост +25% г/г',
    text: 'Мини-торты в коробках остаются в топе. Покупатели выбирают их как подарок на 1–2 человека. Фокус на упаковке и персонализации.'
  },
  {
    tag: 'Рынок', tone: 'good',
    date: 'Q1 2025',
    title: 'Кофе с собой обгоняет торты',
    text: 'Кофейный сегмент в кондитерских Сибири +18% год к году. Главный драйвер — офисная аудитория. Рассмотрите расширение линейки.'
  },
  {
    tag: 'Сезон', tone: 'warn',
    date: 'Май–Июнь 2025',
    title: 'Выпускные: ожидаемый рост +35%',
    text: 'Сезон выпускных вечеров запускается в мае. Рост заказных тортов +35% в мае-июне — готовьте производственные мощности заранее.'
  },
  {
    tag: 'Новинка', tone: 'accent',
    date: 'Весна 2025',
    title: 'Корейский стиль: buttercream flowers',
    text: 'Торты с цветами из крема в корейском стиле — один из топ-запросов в соцсетях. Высокий средний чек и виральность в Instagram.'
  },
  {
    tag: 'Рынок', tone: 'good',
    date: 'Q1 2025',
    title: 'Средний чек вырос на 12%',
    text: 'В кондитерских Сибири средний чек +12% г/г. Покупатели готовы к премиуму — важно обеспечить соответствующий сервис.'
  },
  {
    tag: 'Совет', tone: 'neutral',
    date: 'Апрель 2025',
    title: 'Программы лояльности удерживают 30%+',
    text: 'Кондитерские с программой лояльности демонстрируют возврат клиентов на 30% выше. Персонализированные предложения к дням рождения особенно эффективны.'
  }
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

// ── Distribution chart ─────────────────────────────────────────────────────
function renderDistribution(summary) {
  const el = $('distributionChart');
  if (!el) return;
  const brackets = [
    { label: 'Сверх плана (≥110%)', min: 110, max: Infinity,   cls: 'good',    icon: '★' },
    { label: 'Выполнение (100–109%)', min: 100, max: 110,       cls: 'good',    icon: '✓' },
    { label: 'Близко (90–99%)',       min: 90,  max: 100,       cls: 'warn',    icon: '~' },
    { label: 'Отставание (80–89%)',   min: 80,  max: 90,        cls: 'warn',    icon: '!' },
    { label: 'В риске (<80%)',        min: 0,   max: 80,        cls: 'bad',     icon: '✗' },
  ];
  const total = summary.stores.length;
  el.innerHTML = brackets.map(b => {
    const stores = summary.stores.filter(s => s.percent >= b.min && s.percent < b.max);
    const pct = total > 0 ? Math.round(stores.length / total * 100) : 0;
    const barW = pct;
    const names = stores.map(s => s.storeName).join(', ') || '—';
    return `<div class="dist-row" title="${names}">
      <div class="dist-label">
        <span class="${b.cls}">${b.icon}</span>
        ${b.label}
      </div>
      <div class="dist-track">
        <div class="dist-bar ${b.cls}" style="width:${barW}%"></div>
      </div>
      <div class="dist-count">
        <strong>${stores.length}</strong>
        <span class="muted">/${total}</span>
      </div>
    </div>`;
  }).join('');
}

// ── Gap analysis ───────────────────────────────────────────────────────────
function renderGapReport(summary) {
  const el = $('gapTable');
  if (!el) return;
  const { remainingDays } = summary.forecast;
  const lagging = [...summary.stores]
    .filter(s => s.gap < 0)
    .sort((a, b) => a.gap - b.gap);
  if (!lagging.length) {
    el.innerHTML = '<div class="empty-state">Все точки выполняют план.</div>';
    return;
  }
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
  const stores = [...summary.stores]
    .filter(s => s.fact > 0)
    .sort((a, b) => b.marginPct - a.marginPct);
  const maxFact = Math.max(...stores.map(s => s.fact), 1);
  el.innerHTML = stores.map(s => {
    const barW = (s.fact / maxFact * 100).toFixed(1);
    const mTone = s.marginPct >= 25 ? 'good' : s.marginPct >= 15 ? 'warn' : 'bad';
    return `<div class="rank-row">
      <div class="rank-label" title="${s.storeName}">${s.storeName}</div>
      <div class="rank-track">
        <div class="rank-fact-bar ${mTone}" style="width:${barW}%"></div>
      </div>
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
  const stores = [...summary.stores]
    .filter(s => s.quantity > 0)
    .map(s => ({ ...s, avgCheck: s.fact / s.quantity }))
    .sort((a, b) => b.avgCheck - a.avgCheck);
  const maxCheck = Math.max(...stores.map(s => s.avgCheck), 1);
  el.innerHTML = stores.map(s => {
    const barW = (s.avgCheck / maxCheck * 100).toFixed(1);
    const rank = s.avgCheck > maxCheck * 0.75 ? 'good' : s.avgCheck > maxCheck * 0.4 ? 'warn' : 'neutral';
    return `<div class="rank-row">
      <div class="rank-label" title="${s.storeName}">${s.storeName}</div>
      <div class="rank-track">
        <div class="rank-fact-bar ${rank}" style="width:${barW}%"></div>
      </div>
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
    return `
    <div class="rank-row">
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
    c.fact += p.fact;
    c.plan += p.plan;
    c.cost += (p.cost || 0);
    c.quantity += (p.quantity || 0);
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
    return `
    <div class="rank-row">
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

// ── Store × product matrix ─────────────────────────────────────────────────
function renderMatrix(matrix) {
  const el = $('storeMatrix');
  if (!matrix || !matrix.stores.length || !matrix.products.length) {
    el.innerHTML = '<div class="empty-state">Нет данных.</div>';
    return;
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

// ── Load matrix data ───────────────────────────────────────────────────────
async function loadMatrix() {
  if (!state.period) return;
  const matrix = await fetchJson(`/api/dashboard/matrix?period=${encodeURIComponent(state.period)}`);
  state.matrix = matrix;
  renderMatrix(matrix);
}

// ── Marketing tab ──────────────────────────────────────────────────────────
function renderMarketingKpis(mkt) {
  const el = $('mkKpis');
  if (!mkt || !mkt.totals) { el.innerHTML = ''; return; }
  const t = mkt.totals;
  const roasTone = t.roas >= 4 ? 'good' : t.roas >= 2 ? 'warn' : 'bad';
  const cards = [
    { label: 'Расходы',          value: formatMoney(t.spend),                  tone: 'neutral' },
    { label: 'Выручка (маркет.)',value: formatMoney(t.revenue),                 tone: 'neutral' },
    { label: 'ROAS',             value: t.roas.toFixed(2),                     tone: roasTone  },
    { label: 'CPL',              value: formatMoney(t.cpl),                     tone: 'neutral' },
    { label: 'CAC',              value: formatMoney(t.cac),                     tone: 'neutral' },
    { label: 'Доля от продаж',   value: `${mkt.salesShare}%`,                  tone: 'neutral' },
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
        <li>Загрузите маркетинговые данные через <code>POST /api/ingest/marketing</code></li>
        <li>Формат: <code>{ "period": "2026-04", "metrics": [{ "channelId": "vk", "channelName": "ВКонтакте", "spend": 50000, "leads": 120, "orders": 40, "revenue": 280000 }] }</code></li>
      </ul>
    </div>`;
    return;
  }
  if (!analysis) {
    el.innerHTML = '<div class="empty-state">Загрузка анализа...</div>';
    return;
  }
  const block = (cls, label, items) => `
    <div class="exec-block ${cls}">
      <div class="exec-label">${label}</div>
      <ul class="exec-list">${items.length
        ? items.map(i => `<li>${i}</li>`).join('')
        : '<li class="muted">Нет данных</li>'}</ul>
    </div>`;
  el.innerHTML =
    block('key',   '● Инсайты',        analysis.insights)     +
    block('prior', '▲ Рекомендации',   analysis.recommendations) +
    block('risk',  '! Предупреждения', analysis.warnings)     +
    `<div class="exec-footer" style="grid-column:1/-1">Анализ сформирован: ${formatDate(analysis.generatedAt)}</div>`;
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

// ── Reports tab ────────────────────────────────────────────────────────────
function renderReports(summary) {
  renderAbcTable('abcProducts', computeAbc(summary.products, 'fact', 'productName'));
  renderAbcTable('abcStores', computeAbc(summary.stores, 'fact', 'storeName'));
  renderGrowthReport(summary);
  renderExecutive(summary);
  renderStoreForecastReport(summary);
  renderDistribution(summary);
  renderGapReport(summary);
  renderMarginChart(summary);
  renderAvgCheckChart(summary);
  renderStoreRankChart(summary);
  renderCategoryChart(summary);
  loadMatrix();
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
  es.onerror = () => {
    $('streamStatus').textContent = '● нет связи';
    $('streamStatus').className = 'status-pill idle';
  };
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
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

  // Product sort select
  $('productSort').addEventListener('change', e => {
    state.productSort = e.target.value;
    if (state.summary) renderProducts(state.summary);
  });

  // Export: sales CSV (sidebar + header button)
  const exportSales = () => {
    if (!state.summary) return;
    exportCsv(state.summary.stores.map(s => ({
      'Точка': s.storeName,
      'Регион': s.region || '',
      'Факт': s.fact,
      'План': s.plan,
      'Выполнение%': s.percent,
      'Маржа': s.margin,
      'Маржа%': s.marginPct,
      'Ср.чек': s.quantity > 0 ? Math.round(s.fact / s.quantity) : 0,
      'Количество': s.quantity
    })), `sales-${state.period}.csv`);
  };
  $('exportSalesBtn')?.addEventListener('click', exportSales);
  $('exportSalesBtnH')?.addEventListener('click', exportSales);

  // Export: ABC CSV
  $('exportAbcBtn')?.addEventListener('click', () => {
    if (!state.summary) return;
    exportCsv(computeAbc(state.summary.products, 'fact', 'productName').map(i => ({
      '№': i.rank,
      'Наименование': i.name,
      'Выручка': i.value,
      'Доля%': i.share.toFixed(1),
      'Накоп%': i.cumPct.toFixed(1),
      'Группа': i.abc
    })), `abc-${state.period}.csv`);
  });

  // Export: matrix CSV
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

  // Export: marketing CSV
  const exportMktg = () => {
    if (!state.marketing?.channels.length) return;
    exportCsv(state.marketing.channels.map(ch => ({
      'Канал': ch.channelName,
      'Расходы': ch.spend,
      'Выручка': ch.revenue,
      'ROAS': ch.roas,
      'Лиды': ch.leads,
      'CPL': ch.cpl,
      'Заказы': ch.orders,
      'CAC': ch.cac,
      'Показы': ch.impressions,
      'Клики': ch.clicks,
      'CTR%': ch.ctr,
      'CVR%': ch.cvr
    })), `marketing-${state.period}.csv`);
  };
  $('exportMktgBtn')?.addEventListener('click', exportMktg);
  $('exportMktgBtnH')?.addEventListener('click', exportMktg);

  // Export: growth CSV
  $('exportGrowthBtn')?.addEventListener('click', () => {
    if (!state.summary) return;
    const active = (state.summary.trend?.periods || []).filter(p => p.plan > 0 || p.fact > 0);
    exportCsv(active.map((p, i) => {
      const prev = active[i - 1];
      return {
        'Период': p.period,
        'Факт': p.fact,
        'Рост': prev ? (p.fact - prev.fact).toFixed(0) : '',
        'Рост%': prev && prev.fact > 0 ? ((p.fact - prev.fact) / prev.fact * 100).toFixed(1) : '',
        'Выполнение%': p.completion,
        'Маржа': p.margin
      };
    }), `growth-${state.period}.csv`);
  });

  // Load data and start auto-refresh
  try {
    await loadMetadata();
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
