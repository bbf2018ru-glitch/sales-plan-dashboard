// Тенденции кондитерского рынка — генерация через Groq LLM с кэшом в БД.
// Промпт включает контекст сети «Мария» (Иркутск, 28 точек, домашняя
// кондитерская 33 года) + наши топ-категории и товары — чтобы AI не
// предлагал ровно то, что уже есть в ассортименте.

const { callGroqWithFallback } = require('./groq');

const TTL_MS = 24 * 60 * 60 * 1000; // сутки

function pickTopCategories(summary) {
  if (!summary?.products?.length) return [];
  const map = new Map();
  for (const p of summary.products) {
    const cat = (p.category || 'Прочее').trim();
    if (!cat || cat === '_total') continue;
    map.set(cat, (map.get(cat) || 0) + (p.fact || 0));
  }
  const totalFact = summary.totals?.fact || 1;
  return Array.from(map.entries())
    .map(([name, fact]) => ({ name, share: Math.round((fact / totalFact) * 100) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 6);
}

function pickTopProducts(summary) {
  if (!summary?.products?.length) return [];
  return [...summary.products]
    .filter(p => (p.productName || p.name) && p.productId !== '_total')
    .sort((a, b) => (b.fact || 0) - (a.fact || 0))
    .slice(0, 10)
    .map(p => p.productName || p.name);
}

// Ближайшие праздники РФ + Восточной Сибири на которые имеет смысл готовить
// ассортимент. AI берёт только те что ВПЕРЕДИ — прошедшие исключены.
const HOLIDAYS_2026 = [
  { date: '2026-02-14', name: 'День святого Валентина' },
  { date: '2026-02-19', name: 'Сагаалган (Новый год по лунному календарю)' },
  { date: '2026-02-23', name: '23 февраля (День защитника Отечества)' },
  { date: '2026-03-08', name: '8 марта' },
  { date: '2026-04-12', name: 'Пасха' },
  { date: '2026-05-01', name: '1 мая' },
  { date: '2026-05-09', name: '9 мая (День Победы)' },
  { date: '2026-06-01', name: 'День защиты детей' },
  { date: '2026-06-12', name: 'День России' },
  { date: '2026-07-08', name: 'День семьи, любви и верности' },
  { date: '2026-08-01', name: 'День города Иркутска' },
  { date: '2026-09-01', name: 'Первое сентября / День знаний' },
  { date: '2026-09-13', name: 'День Байкала' },
  { date: '2026-10-05', name: 'День учителя' },
  { date: '2026-11-29', name: 'День матери' },
  { date: '2026-12-31', name: 'Новый год' },
];

function upcomingHolidays(now, windowDays = 60) {
  const todayMs = now.getTime();
  const result = [];
  for (const h of HOLIDAYS_2026) {
    const d = new Date(h.date + 'T00:00:00+08:00'); // Иркутск
    const days = Math.round((d.getTime() - todayMs) / 86400000);
    if (days >= 0 && days <= windowDays) result.push({ ...h, daysAhead: days });
  }
  return result;
}

function buildSystemPrompt() {
  return `Ты — бренд-маркетолог кондитерской «Мария» (Иркутск, Восточная Сибирь).
Контекст бренда: 33 года на рынке, домашняя кондитерская, 28 точек, ЦА — семьи + корпораты + частные заказы.
Конкуренты Иркутска: Стефания (31 филиал), Яхонт (28), Этика, Вернисаж, 1-й Гастроном — у всех слабая цифровая зрелость.

Твоя задача — давать актуальные тренды кондитерского рынка России и конкретные рекомендации что внедрить «Марии».

Правила:
- Не предлагай то, что у нас уже есть (см. ассортимент в контексте).
- Учитывай Восточную Сибирь (праздники, климат, локальные предпочтения).
- Бренд НЕ массмаркет-вычурный, домашний — не предлагай эффекты ради эффектов.
- Каждый тренд должен иметь КОНКРЕТНОЕ действие (рецепт/категория/формат), а не общее «развивать SMM».
- Отвечай СТРОГО валидным JSON без пояснений до или после.
- ВАЖНО: смотри на текущую дату из user-промпта. Не предлагай праздники которые УЖЕ прошли в этом году. Фокус на ближайшие 30-60 дней + устойчивые тренды.

Формат ответа:
{
  "trends": [
    {
      "title": "Короткое название тренда (3-5 слов)",
      "category": "Торты|Десерты|Конфеты|Печенье|Здоровое|Праздничное|Корпоратив|Подарки",
      "trend": "rising|stable|niche",
      "summary": "1-2 предложения почему важно — со ссылкой на демографию/тренды/конкурентов",
      "recommendation": "1 конкретное действие — что именно ввести в ассортимент или формат",
      "have_already": false
    }
  ]
}

Выдай ровно 6 трендов. trend='rising' если категория растёт сейчас (фокусировать), 'stable' если устойчивая база (не упустить), 'niche' если для узкой ЦА но с маржой.`;
}

function buildUserPrompt({ topCategories, topProducts, today, holidays }) {
  const lines = [];
  lines.push(`Сегодняшняя дата: ${today.toISOString().slice(0, 10)} (${today.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}).`);
  lines.push('');
  if (holidays.length) {
    lines.push('Ближайшие праздники (только впереди, в течение 60 дней):');
    for (const h of holidays) lines.push(`- ${h.date} (через ${h.daysAhead} дн.) — ${h.name}`);
    lines.push('');
  } else {
    lines.push('Ближайшие 60 дней без крупных праздников — фокус на устойчивые тренды и сезон.');
    lines.push('');
  }
  if (topCategories.length) {
    lines.push('Наши топ-категории по выручке:');
    for (const c of topCategories) lines.push(`- ${c.name}: ${c.share}% выручки`);
    lines.push('');
  }
  if (topProducts.length) {
    lines.push('Наш топ-10 товаров (что уже хорошо продаётся, не предлагай повтор):');
    for (const p of topProducts) lines.push(`- ${p}`);
    lines.push('');
  }
  lines.push('Дай 6 трендов кондитерского рынка с конкретными рекомендациями для «Марии».');
  return lines.join('\n');
}

function safeParseTrends(text) {
  if (!text) return null;
  // LLM может добавить ```json...``` фенсы — снимаем
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed?.trends)) return parsed.trends;
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    // Иногда LLM возвращает текст вокруг JSON — попробуем выкусить
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const p = JSON.parse(m[0]);
        if (Array.isArray(p?.trends)) return p.trends;
      } catch { /* ignore */ }
    }
    return null;
  }
}

async function generateTrends({ apiKey, model, summary }) {
  if (!apiKey) throw new Error('GROQ_KEY не задан');
  const now = new Date();
  const ctx = {
    topCategories: pickTopCategories(summary),
    topProducts: pickTopProducts(summary),
    today: now,
    holidays: upcomingHolidays(now, 60),
  };
  const system = buildSystemPrompt();
  const user = buildUserPrompt(ctx);
  // При 429 на 70b — fallback на 8b-instant с большим дневным лимитом.
  const { text: raw, model: usedModel } = await callGroqWithFallback({
    apiKey,
    models: [model || 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.5,
    maxTokens: 1500,
    timeoutMs: 30000,
  });
  ctx.model = usedModel;
  const trends = safeParseTrends(raw);
  if (!trends || !trends.length) {
    throw new Error('LLM вернул не-JSON или пустой массив');
  }
  // Нормализуем структуру — на случай если LLM придумал свои поля
  const normalized = trends.slice(0, 8).map((t) => ({
    title: String(t.title || '').slice(0, 100),
    category: String(t.category || 'Прочее').slice(0, 30),
    trend: ['rising', 'stable', 'niche'].includes(t.trend) ? t.trend : 'stable',
    summary: String(t.summary || '').slice(0, 400),
    recommendation: String(t.recommendation || '').slice(0, 400),
    have_already: !!t.have_already,
  })).filter(t => t.title && t.summary);
  return { trends: normalized, context: ctx };
}

async function getMarketTrends({ store, apiKey, model, summary, force }) {
  if (!force) {
    const cached = await store.getLastMarketTrends(TTL_MS);
    if (cached) {
      return {
        ...cached,
        cached: true,
        ageSec: Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 1000),
      };
    }
  }
  const { trends, context } = await generateTrends({ apiKey, model, summary });
  const generatedAt = new Date().toISOString();
  await store.saveMarketTrends(trends, context);
  return { trends, context, generatedAt, cached: false, ageSec: 0 };
}

module.exports = { getMarketTrends, generateTrends, TTL_MS };
