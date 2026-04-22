const state = {
  period: '',
  selectedStoreId: '',
  summary: null,
  marketing: null,
  analysis: null
};

const periodSelect = document.getElementById('periodSelect');
const kpis = document.getElementById('kpis');
const storesTable = document.getElementById('storesTable');
const productsList = document.getElementById('productsList');
const spotlight = document.getElementById('spotlight');
const storeDetails = document.getElementById('storeDetails');
const streamStatus = document.getElementById('streamStatus');
const lastUpdate = document.getElementById('lastUpdate');
const marketingSummary = document.getElementById('marketingSummary');
const marketingChannels = document.getElementById('marketingChannels');
const analysisPanel = document.getElementById('analysisPanel');
const analysisButton = document.getElementById('runAnalysisButton');
const analysisStatus = document.getElementById('analysisStatus');
const forecastPanel = document.getElementById('forecastPanel');
const comparisonPanel = document.getElementById('comparisonPanel');
const dailyPanel = document.getElementById('dailyPanel');
const executivePanel = document.getElementById('executivePanel');
const trendPanel = document.getElementById('trendPanel');

function formatMoney(value) {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0
  }).format(value || 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(value || 0);
}

function formatRatio(value) {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(value || 0);
}

function formatDate(value) {
  if (!value) return 'нет';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU');
}

function percentTone(value) {
  if (value >= 100) return 'good';
  if (value >= 80) return 'warn';
  return 'bad';
}

function roasTone(value) {
  if (value >= 4) return 'good';
  if (value >= 2) return 'warn';
  return 'bad';
}

async function fetchJson(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(body.error || 'Request failed');
  }
  return res.json();
}

async function loadMetadata() {
  const metadata = await fetchJson('/api/metadata');
  periodSelect.innerHTML = metadata.periods
    .map((period) => `<option value="${period}">${period}</option>`)
    .join('');
  state.period = metadata.periods[0] || '';
  periodSelect.value = state.period;
}

function renderKpis(summary) {
  const cards = [
    {
      label: 'План сети',
      value: formatMoney(summary.totals.plan),
      tone: 'neutral'
    },
    {
      label: 'Факт сети',
      value: formatMoney(summary.totals.fact),
      tone: 'neutral'
    },
    {
      label: 'Выполнение',
      value: `${summary.totals.completion}%`,
      tone: percentTone(summary.totals.completion)
    },
    {
      label: 'Продано единиц',
      value: formatNumber(summary.totals.quantity),
      tone: 'neutral'
    },
    {
      label: 'Прогноз месяца',
      value: formatMoney(summary.forecast.projectedFact),
      tone: summary.forecast.tone
    },
    {
      label: 'Нужно в день',
      value: formatMoney(summary.forecast.requiredPerDayToPlan),
      tone: summary.forecast.requiredPerDayToPlan > summary.forecast.averagePerDay ? 'bad' : 'good'
    },
    {
      label: 'Темп к плану',
      value: `${summary.forecast.paceVsPlan}%`,
      tone: summary.forecast.tone
    }
  ];

  kpis.innerHTML = cards.map((card) => `
    <article class="kpi ${card.tone}">
      <div class="kpi-label">${card.label}</div>
      <div class="kpi-value">${card.value}</div>
    </article>
  `).join('');
}

function renderForecast(summary) {
  const tone = summary.forecast.tone;
  const paceTone = summary.forecast.paceVsPlan >= 100 ? 'good' : summary.forecast.paceVsPlan >= 90 ? 'warn' : 'bad';

  forecastPanel.innerHTML = `
    <article class="forecast-card ${tone}">
      <div class="forecast-kicker">Прогноз</div>
      <div class="forecast-title">${summary.forecast.status}</div>
      <div class="forecast-metrics">
        <div><span>К концу месяца</span><strong>${formatMoney(summary.forecast.projectedFact)}</strong></div>
        <div><span>Ожидаемое выполнение</span><strong>${summary.forecast.projectedCompletion}%</strong></div>
        <div><span>Прогнозный разрыв</span><strong class="${summary.forecast.runwayGap >= 0 ? 'positive' : 'negative'}">${formatMoney(summary.forecast.runwayGap)}</strong></div>
      </div>
    </article>
    <article class="forecast-card neutral">
      <div class="forecast-kicker">Ритм</div>
      <div class="forecast-title">Что нужно делать ежедневно</div>
      <div class="forecast-metrics">
        <div><span>Средний факт в день</span><strong>${formatMoney(summary.forecast.averagePerDay)}</strong></div>
        <div><span>План в день</span><strong>${formatMoney(summary.forecast.planPerDay)}</strong></div>
        <div><span>Нужно до плана</span><strong>${formatMoney(summary.forecast.requiredPerDayToPlan)}</strong></div>
      </div>
    </article>
    <article class="forecast-card ${paceTone}">
      <div class="forecast-kicker">Период</div>
      <div class="forecast-title">Где мы находимся сейчас</div>
      <div class="forecast-metrics">
        <div><span>Прошло дней</span><strong>${formatNumber(summary.forecast.elapsedDays)} / ${formatNumber(summary.forecast.totalDays)}</strong></div>
        <div><span>Осталось дней</span><strong>${formatNumber(summary.forecast.remainingDays)}</strong></div>
        <div><span>Темп к плану</span><strong>${summary.forecast.paceVsPlan}%</strong></div>
      </div>
    </article>
  `;
}

function signedMoney(value) {
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatMoney(value)}`;
}

function signedNumber(value, suffix = '') {
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatRatio(value)}${suffix}`;
}

function renderComparison(summary) {
  const comparison = summary.comparison;

  if (!comparison || !comparison.hasData) {
    comparisonPanel.innerHTML = '<div class="details-empty">Нет данных за предыдущий период для сравнения.</div>';
    return;
  }

  comparisonPanel.innerHTML = `
    <div class="comparison-card ${comparison.tone}">
      <div class="comparison-kicker">Предыдущий период</div>
      <div class="comparison-title">${comparison.previousPeriod}</div>
      <div class="comparison-list">
        <div><span>Факт продаж</span><strong class="${comparison.factDelta >= 0 ? 'positive' : 'negative'}">${signedMoney(comparison.factDelta)}</strong></div>
        <div><span>Изменение, %</span><strong class="${comparison.factDelta >= 0 ? 'positive' : 'negative'}">${signedNumber(comparison.factDeltaPercent, '%')}</strong></div>
        <div><span>Выполнение плана</span><strong class="${comparison.completionDelta >= 0 ? 'positive' : 'negative'}">${signedNumber(comparison.completionDelta, ' п.п.')}</strong></div>
        <div><span>План</span><strong class="${comparison.planDelta >= 0 ? 'positive' : 'negative'}">${signedMoney(comparison.planDelta)}</strong></div>
        <div><span>Количество</span><strong class="${comparison.quantityDelta >= 0 ? 'positive' : 'negative'}">${signedNumber(comparison.quantityDelta)}</strong></div>
      </div>
    </div>
  `;
}

function renderDaily(summary) {
  const rows = summary.daily || [];
  if (!rows.length) {
    dailyPanel.innerHTML = '<div class="details-empty">Нет дневных данных.</div>';
    return;
  }

  const visibleRows = rows.slice(0, Math.max(summary.forecast.elapsedDays, 7));

  dailyPanel.innerHTML = `
    <div class="daily-table-wrap">
      <table class="daily-table">
        <thead>
          <tr>
            <th>День</th>
            <th>План / день</th>
            <th>Факт / день</th>
            <th>План накоп.</th>
            <th>Факт накоп.</th>
            <th>%</th>
            <th>Разрыв</th>
          </tr>
        </thead>
        <tbody>
          ${visibleRows.map((row) => `
            <tr>
              <td>${row.day}</td>
              <td>${formatMoney(row.plan)}</td>
              <td>${formatMoney(row.fact)}</td>
              <td>${formatMoney(row.cumulativePlan)}</td>
              <td>${formatMoney(row.cumulativeFact)}</td>
              <td><span class="${percentTone(row.percent)}">${row.percent}%</span></td>
              <td class="${row.gap >= 0 ? 'positive' : 'negative'}">${formatMoney(row.gap)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderExecutive(summary) {
  const executive = summary.executive;

  executivePanel.innerHTML = `
    <div class="executive-block">
      <div class="analysis-label">Ключевое</div>
      <ul class="analysis-list">${executive.headlines.map((item) => `<li>${item}</li>`).join('')}</ul>
    </div>
    <div class="executive-block">
      <div class="analysis-label">Приоритеты</div>
      <ul class="analysis-list">${executive.priorities.map((item) => `<li>${item}</li>`).join('')}</ul>
    </div>
    <div class="executive-block">
      <div class="analysis-label">Риски</div>
      <ul class="analysis-list">${executive.alerts.map((item) => `<li>${item}</li>`).join('')}</ul>
    </div>
    <div class="analysis-footer">Сформировано: ${formatDate(executive.generatedAt)}</div>
  `;
}

function renderTrend(summary) {
  const periods = summary.trend?.periods || [];
  if (!periods.length) {
    trendPanel.innerHTML = '<div class="details-empty">Нет данных по тренду.</div>';
    return;
  }

  trendPanel.innerHTML = `
    <div class="daily-table-wrap">
      <table class="daily-table">
        <thead>
          <tr>
            <th>Период</th>
            <th>План</th>
            <th>Факт</th>
            <th>%</th>
            <th>Отклонение</th>
            <th>Шт</th>
          </tr>
        </thead>
        <tbody>
          ${periods.map((row) => `
            <tr class="${row.period === summary.period ? 'active' : ''}">
              <td>${row.period}</td>
              <td>${formatMoney(row.plan)}</td>
              <td>${formatMoney(row.fact)}</td>
              <td><span class="${percentTone(row.completion)}">${row.completion}%</span></td>
              <td class="${row.gap >= 0 ? 'positive' : 'negative'}">${formatMoney(row.gap)}</td>
              <td>${formatNumber(row.quantity)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderStores(summary) {
  storesTable.innerHTML = summary.stores.map((store) => `
    <tr data-store-id="${store.storeId}" class="${state.selectedStoreId === store.storeId ? 'active' : ''}">
      <td>
        <button class="store-button" data-store-id="${store.storeId}">
          <span>${store.storeName}</span>
          <small>${store.region || 'Регион не указан'}</small>
        </button>
      </td>
      <td>${formatMoney(store.plan)}</td>
      <td>${formatMoney(store.fact)}</td>
      <td>
        <div class="progress-row">
          <span class="progress-value ${percentTone(store.percent)}">${store.percent}%</span>
          <div class="progress-track"><div class="progress-bar ${percentTone(store.percent)}" style="width: ${Math.min(store.percent, 140)}%"></div></div>
        </div>
      </td>
      <td class="${store.gap >= 0 ? 'positive' : 'negative'}">${formatMoney(store.gap)}</td>
    </tr>
  `).join('');

  for (const button of document.querySelectorAll('.store-button')) {
    button.addEventListener('click', () => {
      state.selectedStoreId = button.dataset.storeId;
      renderStores(summary);
      loadStoreDetails();
    });
  }
}

function renderProducts(summary) {
  productsList.innerHTML = summary.products.map((product) => `
    <div class="rank-item">
      <div class="rank-head">
        <div>
          <div class="rank-title">${product.productName}</div>
          <div class="rank-subtitle">${product.category || 'Без категории'}</div>
        </div>
        <div class="rank-metric ${percentTone(product.percent)}">${product.percent}%</div>
      </div>
      <div class="progress-track"><div class="progress-bar ${percentTone(product.percent)}" style="width: ${Math.min(product.percent, 140)}%"></div></div>
      <div class="rank-foot">
        <span>План: ${formatMoney(product.plan)}</span>
        <span>Факт: ${formatMoney(product.fact)}</span>
        <span>Шт: ${formatNumber(product.quantity)}</span>
      </div>
    </div>
  `).join('');
}

function renderSpotlight(summary) {
  const leader = summary.leader;
  const lagger = summary.lagger;
  spotlight.innerHTML = `
    <div class="spot-card leader">
      <div class="spot-label">Лидер</div>
      <div class="spot-title">${leader ? leader.storeName : 'Нет данных'}</div>
      <div class="spot-value">${leader ? leader.percent : 0}%</div>
      <div class="spot-meta">${leader ? formatMoney(leader.fact) : ''}</div>
    </div>
    <div class="spot-card lagger">
      <div class="spot-label">Риск</div>
      <div class="spot-title">${lagger ? lagger.storeName : 'Нет данных'}</div>
      <div class="spot-value">${lagger ? lagger.percent : 0}%</div>
      <div class="spot-meta">${lagger ? formatMoney(lagger.gap) : ''}</div>
    </div>
    <div class="spot-card neutral">
      <div class="spot-label">Последняя продажа</div>
      <div class="spot-title">${formatDate(summary.lastSaleAt)}</div>
      <div class="spot-meta">Период ${summary.period}</div>
    </div>
  `;
}

function renderMarketing(marketing) {
  state.marketing = marketing;

  const cards = [
    { label: 'Расход', value: formatMoney(marketing.totals.spend), tone: 'neutral' },
    { label: 'Выручка', value: formatMoney(marketing.totals.revenue), tone: 'neutral' },
    { label: 'ROAS', value: formatRatio(marketing.totals.roas), tone: roasTone(marketing.totals.roas) },
    { label: 'CPL', value: formatMoney(marketing.totals.cpl), tone: 'neutral' },
    { label: 'CAC', value: formatMoney(marketing.totals.cac), tone: 'neutral' },
    { label: 'CTR / CVR', value: `${marketing.totals.ctr}% / ${marketing.totals.cvr}%`, tone: 'neutral' }
  ];

  marketingSummary.innerHTML = cards.map((card) => `
    <article class="mini-kpi ${card.tone}">
      <div class="mini-kpi-label">${card.label}</div>
      <div class="mini-kpi-value">${card.value}</div>
    </article>
  `).join('');

  if (!marketing.channels.length) {
    marketingChannels.innerHTML = '<div class="details-empty">Нет маркетинговых данных за выбранный период.</div>';
    return;
  }

  marketingChannels.innerHTML = marketing.channels.map((channel) => `
    <div class="rank-item">
      <div class="rank-head">
        <div>
          <div class="rank-title">${channel.channelName}</div>
          <div class="rank-subtitle">Лиды: ${formatNumber(channel.leads)} · Заказы: ${formatNumber(channel.orders)}</div>
        </div>
        <div class="rank-metric ${roasTone(channel.roas)}">ROAS ${formatRatio(channel.roas)}</div>
      </div>
      <div class="progress-track"><div class="progress-bar ${roasTone(channel.roas)}" style="width: ${Math.min(channel.roas * 25, 100)}%"></div></div>
      <div class="rank-foot">
        <span>Расход: ${formatMoney(channel.spend)}</span>
        <span>Выручка: ${formatMoney(channel.revenue)}</span>
        <span>CPL: ${formatMoney(channel.cpl)}</span>
        <span>CAC: ${formatMoney(channel.cac)}</span>
        <span>CTR: ${channel.ctr}%</span>
        <span>CVR: ${channel.cvr}%</span>
      </div>
    </div>
  `).join('');
}

function renderAnalysis(analysis) {
  state.analysis = analysis;

  const warningsHtml = analysis.warnings.length
    ? `<div class="analysis-block">
        <div class="analysis-label">Риски</div>
        <ul class="analysis-list">${analysis.warnings.map((item) => `<li>${item}</li>`).join('')}</ul>
      </div>`
    : '';

  analysisPanel.innerHTML = `
    <div class="analysis-summary">${analysis.summary}</div>
    <div class="analysis-block">
      <div class="analysis-label">Выводы</div>
      <ul class="analysis-list">${analysis.insights.map((item) => `<li>${item}</li>`).join('')}</ul>
    </div>
    ${warningsHtml}
    <div class="analysis-block">
      <div class="analysis-label">Рекомендации</div>
      <ul class="analysis-list">${analysis.recommendations.map((item) => `<li>${item}</li>`).join('')}</ul>
    </div>
    <div class="analysis-footer">Сформировано: ${formatDate(analysis.generatedAt)}</div>
  `;

  analysisStatus.textContent = `анализ обновлен: ${formatDate(analysis.generatedAt)}`;
}

async function loadStoreDetails() {
  if (!state.selectedStoreId) {
    storeDetails.innerHTML = 'Выберите точку, чтобы увидеть товары.';
    return;
  }

  const details = await fetchJson(`/api/dashboard/store?period=${encodeURIComponent(state.period)}&storeId=${encodeURIComponent(state.selectedStoreId)}`);
  storeDetails.innerHTML = `
    <div class="details-title">${details.store.name}</div>
    <div class="details-subtitle">${details.store.region || 'Регион не указан'}</div>
    <div class="details-list">
      ${details.items.map((item) => `
        <div class="details-row">
          <div>
            <div class="details-product">${item.productName}</div>
            <div class="details-category">${item.category || 'Без категории'}</div>
          </div>
          <div class="details-metrics">
            <span>${formatMoney(item.fact)}</span>
            <strong class="${percentTone(item.percent)}">${item.percent}%</strong>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function loadSummary() {
  if (!state.period) return;

  const [summary, marketing] = await Promise.all([
    fetchJson(`/api/dashboard/summary?period=${encodeURIComponent(state.period)}`),
    fetchJson(`/api/dashboard/marketing?period=${encodeURIComponent(state.period)}`)
  ]);

  state.summary = summary;
  if (!state.selectedStoreId && summary.stores[0]) {
    state.selectedStoreId = summary.stores[0].storeId;
  }

  renderKpis(summary);
  renderForecast(summary);
  renderExecutive(summary);
  renderTrend(summary);
  renderComparison(summary);
  renderDaily(summary);
  renderStores(summary);
  renderProducts(summary);
  renderSpotlight(summary);
  renderMarketing(marketing);
  await loadStoreDetails();
  lastUpdate.textContent = `последнее обновление: ${new Date().toLocaleTimeString('ru-RU')}`;
}

async function runMarketingAnalysis() {
  analysisButton.disabled = true;
  analysisButton.textContent = 'Считаю...';
  analysisStatus.textContent = 'выполняется анализ';

  try {
    const analysis = await fetchJson('/api/analysis/marketing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ period: state.period })
    });
    renderAnalysis(analysis);
  } catch (error) {
    analysisPanel.innerHTML = `<div class="details-empty">Ошибка анализа: ${error.message}</div>`;
    analysisStatus.textContent = 'анализ завершился с ошибкой';
  } finally {
    analysisButton.disabled = false;
    analysisButton.textContent = 'Запустить анализ';
  }
}

function connectEvents() {
  const events = new EventSource('/api/events');

  events.addEventListener('open', () => {
    streamStatus.textContent = 'поток подключен';
    streamStatus.className = 'status-pill live';
  });

  const reload = async () => {
    streamStatus.textContent = 'обновление';
    streamStatus.className = 'status-pill syncing';
    await loadSummary();
    streamStatus.textContent = 'поток подключен';
    streamStatus.className = 'status-pill live';
  };

  events.addEventListener('sales_updated', reload);
  events.addEventListener('plans_updated', reload);
  events.addEventListener('marketing_updated', reload);

  events.onerror = () => {
    streamStatus.textContent = 'переподключение';
    streamStatus.className = 'status-pill idle';
  };
}

async function init() {
  try {
    await loadMetadata();
    await loadSummary();
    connectEvents();
    periodSelect.addEventListener('change', async () => {
      state.period = periodSelect.value;
      state.analysis = null;
      analysisPanel.innerHTML = 'Нажмите «Запустить анализ», чтобы получить выводы и рекомендации.';
      analysisStatus.textContent = 'анализ еще не запускался';
      await loadSummary();
    });
    analysisButton.addEventListener('click', runMarketingAnalysis);
    setInterval(loadSummary, 30000);
  } catch (error) {
    document.body.innerHTML = `<main class="fatal">Ошибка загрузки: ${error.message}</main>`;
  }
}

init();
