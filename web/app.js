// ── State ──────────────────────────────────────────────────────────────────
const state = {
  period: '',
  selectedStoreId: '',
  activeTab: 'sales',
  summary: null,
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
          <div class="detail-pct ${tone}">${item.percent}%</div>
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

// ── Reports tab ────────────────────────────────────────────────────────────
function renderReports(summary) {
  renderAbcTable('abcProducts', computeAbc(summary.products, 'fact', 'productName'));
  renderAbcTable('abcStores', computeAbc(summary.stores, 'fact', 'storeName'));
  renderGrowthReport(summary);
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
  renderStores(summary);
  renderProducts(summary);
  renderSpotlight(summary);
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
