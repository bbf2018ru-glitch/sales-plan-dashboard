// AI-чат «Спроси у Маши» — Groq + контекст текущих данных дашборда.
// Без function-calling: контекст собираем заранее и упаковываем в промпт.

const { aggregateDashboard, monthKey } = require('./analytics');
const { buildInsights } = require('./insights');
const { getUpcomingEvents } = require('./calendar-irk');
const { callGroqWithFallback } = require('./groq');

// Кэш агрегации дашборда на period. aggregateDashboard тяжёлый
// (12-мес trend, все продажи), а в активной беседе пользователь шлёт
// несколько вопросов подряд про один и тот же период — пересчёт каждый
// раз тратит CPU зря. TTL 30 сек: данные за период не меняются часто,
// pull-scheduler тянет 1С раз в 15 мин, plans/sales обновляются ингестом.
const CONTEXT_TTL_MS = 30000;
const contextCache = new Map(); // period -> { context, expiresAt }

function getContext(db, period) {
  const cached = contextCache.get(period);
  if (cached && cached.expiresAt > Date.now()) return cached.context;
  const ctx = buildContext(db, period);
  contextCache.set(period, { context: ctx, expiresAt: Date.now() + CONTEXT_TTL_MS });
  return ctx;
}

function buildContext(db, period) {
  const summary = aggregateDashboard(db, period, { trendWindow: 12 });
  const t = summary.totals || {};
  const f = summary.forecast || {};
  const today = summary.today || {};
  const comparison = summary.comparison;
  const yoy = summary.yoy;

  // Топ/боттом магазины с фильтром только реальных торговых точек.
  const realStores = (summary.stores || []).filter(s => s.plan > 0);
  const top3 = [...realStores].sort((a, b) => b.percent - a.percent).slice(0, 3);
  const bot3 = [...realStores].sort((a, b) => a.percent - b.percent).slice(0, 3);

  const topProducts = (summary.products || [])
    .filter(p => p.productId !== '_total' && p.productId !== '__total__')
    .sort((a, b) => (b.fact || 0) - (a.fact || 0))
    .slice(0, 10);

  // Категории — топ-5 по выручке.
  const byCategory = new Map();
  for (const p of (summary.products || [])) {
    if (p.productId === '_total' || p.productId === '__total__') continue;
    const cat = p.category || 'Прочее';
    byCategory.set(cat, (byCategory.get(cat) || 0) + (p.fact || 0));
  }
  const topCategories = Array.from(byCategory.entries())
    .map(([name, fact]) => ({ name, fact, share: t.fact > 0 ? (fact / t.fact) * 100 : 0 }))
    .sort((a, b) => b.fact - a.fact)
    .slice(0, 5);

  const trend = (summary.trend?.periods || [])
    .filter(p => p.fact > 0)
    .slice(-6);

  // Insights — выявленные аномалии и сигналы (без LLM-обёртки).
  let insightsFindings = [];
  try {
    const ins = buildInsights ? null : null; // защита от циклической зависимости при отсутствии
    // buildInsights возвращает Promise, но в синхронном контексте его не дёрнем.
    // Вместо этого reuse: detectAnomalies можно вызвать прямо если импортирован.
  } catch {}
  // detectAnomalies — синхронный, импортирован отдельно
  try {
    const { detectAnomalies } = require('./insights');
    insightsFindings = detectAnomalies(summary, db, period) || [];
  } catch {}

  // Праздники впереди (60 дней)
  const upcomingHolidays = getUpcomingEvents(60).slice(0, 5);

  const lines = [];
  lines.push(`=== СВОДКА ЗА ${period} ===`);
  lines.push(`Факт: ${t.fact} ₽ из плана ${t.plan} ₽ (выполнение ${t.completion}%)`);
  if (t.margin !== null) lines.push(`Маржа: ${t.margin} ₽ (${t.marginPct}%)`);
  if (today.factToDate) {
    lines.push(`На сегодня (${today.elapsedDays}-й день): факт ${today.factToDate} ₽, план-на-сегодня ${today.planToDate} ₽, разрыв ${today.gapToDate} ₽`);
  }
  lines.push(`Прогноз на конец месяца: ${f.projectedFact} ₽ (${f.projectedCompletion}% к плану), метод: ${f.projectionMethod}`);
  if (f.projectionMeta) {
    const meta = f.projectionMeta;
    if (meta.basePeriod) lines.push(`  → baseline ${meta.basePeriod}, рост ${meta.growthRate}×`);
    if (meta.storesCount) lines.push(`  → per-store: ${meta.storesCount} магазинов, новых открытых ${meta.newStoresCount || 0}`);
  }
  lines.push(`Осталось дней: ${f.remainingDays}, нужно ${f.requiredPerDayToPlan} ₽/день для плана. Текущий темп ${f.averagePerDay} ₽/день.`);

  if (comparison?.hasData) {
    lines.push(`\nvs прошлый месяц (${comparison.previousPeriod}): факт ${comparison.factDelta > 0 ? '+' : ''}${comparison.factDelta} ₽ (${comparison.factDeltaPercent}%), выполнение ${comparison.completionDelta > 0 ? '+' : ''}${comparison.completionDelta} п.п.`);
  }
  if (yoy?.hasData) {
    const yLabel = yoy.yearsBack > 1 ? `${yoy.yearsBack} года назад` : 'год назад';
    lines.push(`vs тот же месяц ${yLabel} (${yoy.previousPeriod}): факт ${yoy.factDelta > 0 ? '+' : ''}${yoy.factDelta} ₽ (${yoy.factDeltaPercent}%)`);
  }

  lines.push('\n=== ВСЕ МАГАЗИНЫ ===');
  for (const s of realStores) {
    lines.push(`- ${s.storeName}: ${s.fact || 0} ₽ / ${s.plan || 0} ₽ (${s.percent || 0}%), маржа ${s.marginPct === null ? '—' : s.marginPct + '%'}`);
  }

  if (top3.length) {
    lines.push('\n=== ЛИДЕРЫ ===');
    for (const s of top3) lines.push(`- ${s.storeName}: ${s.percent}% (${s.fact} ₽ из ${s.plan} ₽)`);
  }
  if (bot3.length) {
    lines.push('\n=== ОТСТАЮЩИЕ ===');
    for (const s of bot3) lines.push(`- ${s.storeName}: ${s.percent}% (${s.fact} ₽ из ${s.plan} ₽)`);
  }

  if (topCategories.length) {
    lines.push('\n=== ТОП-5 КАТЕГОРИЙ ===');
    for (const c of topCategories) {
      lines.push(`- ${c.name}: ${Math.round(c.fact)} ₽ (${c.share.toFixed(1)}% выручки)`);
    }
  }

  if (topProducts.length) {
    lines.push('\n=== ТОП-10 ТОВАРОВ ПО ВЫРУЧКЕ ===');
    for (const p of topProducts) {
      lines.push(`- ${p.productName || p.name}: ${p.fact || 0} ₽ (${p.quantity || 0} шт)`);
    }
  }

  if (insightsFindings.length) {
    lines.push('\n=== АВТО-АНОМАЛИИ И СИГНАЛЫ (insights) ===');
    for (const fnd of insightsFindings.slice(0, 8)) {
      lines.push(`- [${fnd.severity}] ${fnd.headline}${fnd.detail ? ' — ' + fnd.detail : ''}`);
    }
  }

  if (upcomingHolidays.length) {
    lines.push('\n=== БЛИЖАЙШИЕ ПРАЗДНИКИ (60 дн) ===');
    for (const h of upcomingHolidays) {
      lines.push(`- ${h.date} (через ${h.daysFromNow} дн.): ${h.name}${h.note ? ' — ' + h.note : ''}`);
    }
  }

  if (trend.length) {
    lines.push('\n=== ТРЕНД ПО МЕСЯЦАМ ===');
    for (const p of trend) {
      lines.push(`- ${p.period}: ${p.fact} ₽ (план ${p.plan} ₽, ${p.completion}%)`);
    }
  }

  return lines.join('\n');
}

// Динамические подсказки для начального экрана чата — на основе текущего
// состояния дашборда (insights findings и календарь).
function buildSuggestions(db, period) {
  const summary = aggregateDashboard(db, period);
  const suggestions = [];
  let insightsFindings = [];
  try {
    const { detectAnomalies } = require('./insights');
    insightsFindings = detectAnomalies(summary, db, period) || [];
  } catch {}

  // 1. План-аномалия
  const planAnomaly = insightsFindings.find(f => f.kind === 'plan-anomaly');
  if (planAnomaly) {
    suggestions.push({ short: `Что с планом «${planAnomaly.store}»?`, full: `Почему у магазина «${planAnomaly.store}» так сильно отличается выполнение от других? Это ошибка плана?` });
  }
  // 2. Lagging stores
  const lagging = insightsFindings.filter(f => f.kind === 'lagging-store');
  if (lagging.length >= 2) {
    suggestions.push({ short: 'Что сделать с отстающими?', full: `${lagging.length} магазинов проседают. Что мне сделать чтобы поднять их до конца месяца?` });
  }
  // 3. Близкий праздник
  const upcoming = getUpcomingEvents(14);
  const nextHoliday = upcoming.find(e => e.impact !== 'low');
  if (nextHoliday) {
    suggestions.push({ short: `План на «${nextHoliday.name}»`, full: `Через ${nextHoliday.daysFromNow} дней — ${nextHoliday.name}. Что подготовить, какие категории качать, какой ассортимент?` });
  }
  // 4. Прогноз и риск
  const f = summary.forecast || {};
  if (f.projectedCompletion && f.projectedCompletion < 95 && f.remainingDays > 0) {
    suggestions.push({ short: 'Успеем ли в план?', full: `Прогноз на конец месяца ${f.projectedCompletion}%. Что конкретно сделать чтобы догнать план?` });
  }
  // 5. YoY-просадка
  const yoyDecline = insightsFindings.find(f => f.kind === 'category-yoy-decline');
  if (yoyDecline) {
    suggestions.push({ short: `Просадка «${yoyDecline.headline.match(/«(.+?)»/)?.[1] || 'категории'}»`, full: `${yoyDecline.headline}. Почему могло упасть и что сделать?` });
  }
  // Базовые fallback'и если активных сигналов мало
  const fallback = [
    { short: 'Как мы сегодня?', full: 'Кратко: как мы сегодня в плане выполнения и прогноза?' },
    { short: 'Топ-3 товара', full: 'Топ-3 товаров по выручке и марже за период?' },
    { short: 'Что в категориях?', full: 'Какие категории растут, какие падают? Что я не вижу?' },
    { short: 'Лидер месяца', full: 'Какой магазин самый сильный и за счёт чего?' },
  ];
  for (const fb of fallback) {
    if (suggestions.length >= 5) break;
    if (!suggestions.some(s => s.short === fb.short)) suggestions.push(fb);
  }
  return suggestions.slice(0, 5);
}

const SYSTEM_PROMPT = `Ты — Маша, AI-аналитик кондитерской сети «Мария» в Иркутске (28 точек).

Помогаешь руководителю быстро получить ответы о продажах. Тебе передадут текущие данные за период и вопрос пользователя.

Правила:
- Отвечай КОНКРЕТНО и КОРОТКО (2-5 предложений), без воды и приветствий
- Используй ТОЛЬКО цифры из контекста — не выдумывай
- Если данных нет — честно скажи «таких данных нет в дашборде»
- Суммы пиши в рублях, проценты с %
- Можешь использовать **жирный** для ключевых цифр, переносы строк для списков
- Если вопрос про действие («что делать?») — давай 1-2 конкретные рекомендации
- Контекст содержит данные ТОЛЬКО за текущий период — если спрашивают про другой, скажи что нужно сменить период в дашборде`;

async function askAiChat({ question, db, period, history, apiKey, model, getNotes }) {
  if (!apiKey) throw new Error('GROQ_API_KEY не задан в env');
  if (!question) throw new Error('Вопрос пустой');

  const ctx = getContext(db, monthKey(period));

  // Заметки магазинов (события) — даём AI знать про ремонты/закрытия
  let notesBlock = '';
  if (typeof getNotes === 'function') {
    try {
      const notes = await getNotes();
      if (notes && notes.length) {
        notesBlock = '\n=== ЗАМЕТКИ ПО МАГАЗИНАМ (события) ===\n' +
          notes.slice(0, 20).map(n => `- ${n.eventDate || n.period}: ${n.storeId || 'сеть'} — ${n.text}`).join('\n');
      }
    } catch {}
  }

  // Историю последних 4 сообщений тоже даём, для контекста разговора
  const histMsg = (history || []).slice(-4).map(h => `${h.role}: ${h.text}`).join('\n');

  const userMsg = `${ctx}${notesBlock}\n\n${histMsg ? '=== ИСТОРИЯ ЧАТА ===\n' + histMsg + '\n' : ''}=== ВОПРОС ===\n${question}`;

  // При 429 на 70b — fallback на 8b-instant (отдельный TPD-лимит).
  const { text, model: usedModel } = await callGroqWithFallback({
    apiKey,
    models: [model || 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg }
    ],
    temperature: 0.2,
    maxTokens: 500,
    timeoutMs: 30000
  });
  return { answer: text.trim(), period, model: usedModel };
}

module.exports = { askAiChat, buildSuggestions };
