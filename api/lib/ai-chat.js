// AI-чат «Спроси у Маши» — Groq + контекст текущих данных дашборда.
// Без function-calling: контекст собираем заранее и упаковываем в промпт.

const { aggregateDashboard, monthKey } = require('./analytics');
const { chatCompletion } = require('./groq');

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

  const top3 = (summary.stores || [])
    .filter(s => s.plan > 0)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 3);
  const bot3 = (summary.stores || [])
    .filter(s => s.plan > 0)
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 3);

  // Топ-10 товаров по факту
  const topProducts = (summary.products || [])
    .sort((a, b) => (b.fact || 0) - (a.fact || 0))
    .slice(0, 10);

  // Тренд последних 6 мес — только с факт > 0
  const trend = (summary.trend?.periods || [])
    .filter(p => p.fact > 0)
    .slice(-6);

  const lines = [];
  lines.push(`=== СВОДКА ЗА ${period} ===`);
  lines.push(`Факт: ${t.fact} ₽ из плана ${t.plan} ₽ (выполнение ${t.completion}%)`);
  lines.push(`Маржа: ${t.margin} ₽ (${t.marginPct}%)`);
  lines.push(`Прогноз на конец месяца: ${f.projectedFact} ₽ (${f.projectedCompletion}% к плану)`);
  lines.push(`Осталось дней: ${f.remainingDays}, нужно ${f.requiredPerDayToPlan} ₽/день для плана`);

  lines.push('\n=== ВСЕ МАГАЗИНЫ ===');
  for (const s of summary.stores || []) {
    lines.push(`- ${s.storeName}: ${s.fact || 0} ₽ / ${s.plan || 0} ₽ (${s.percent || 0}%)`);
  }

  if (top3.length) {
    lines.push('\n=== ЛИДЕРЫ ===');
    for (const s of top3) lines.push(`- ${s.storeName}: ${s.percent}%`);
  }
  if (bot3.length) {
    lines.push('\n=== ОТСТАЮЩИЕ ===');
    for (const s of bot3) lines.push(`- ${s.storeName}: ${s.percent}%`);
  }

  if (topProducts.length) {
    lines.push('\n=== ТОП-10 ТОВАРОВ ПО ВЫРУЧКЕ ===');
    for (const p of topProducts) {
      lines.push(`- ${p.productName || p.name}: ${p.fact || 0} ₽ (${p.quantity || 0} шт)`);
    }
  }

  if (trend.length) {
    lines.push('\n=== ТРЕНД ===');
    for (const p of trend) {
      lines.push(`- ${p.period}: ${p.fact} ₽ (план ${p.plan} ₽, ${p.completion}%)`);
    }
  }

  return lines.join('\n');
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

  const answer = await chatCompletion({ apiKey, model, system: SYSTEM_PROMPT, user: userMsg });
  return { answer: answer.trim(), period };
}

module.exports = { askAiChat };
