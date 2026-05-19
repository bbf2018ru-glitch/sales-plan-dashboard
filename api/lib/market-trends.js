// Тенденции кондитерского рынка — генерация через Groq LLM с кэшом в БД.
// Промпт включает контекст сети «Мария» (Иркутск, 28 точек, домашняя
// кондитерская 33 года) + наши топ-категории и товары — чтобы AI не
// предлагал ровно то, что уже есть в ассортименте.

const { chatCompletion } = require('./groq');

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

function seasonHint(monthNum) {
  if ([12, 1, 2].includes(monthNum)) return 'Зима (Новый год, Сагаалган, 23 февраля, 8 марта)';
  if ([3, 4, 5].includes(monthNum)) return 'Весна (8 марта, Пасха, 9 мая, выпускные)';
  if ([6, 7, 8].includes(monthNum)) return 'Лето (День защиты детей, свадьбы, ягодный сезон, День Байкала)';
  return 'Осень (1 сентября, День матери, корпоративы)';
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

function buildUserPrompt({ topCategories, topProducts, monthName, monthNum, year }) {
  const lines = [];
  lines.push(`Сегодня: ${monthName} ${year}. Сезон: ${seasonHint(monthNum)}.`);
  lines.push('');
  if (topCategories.length) {
    lines.push('Наши топ-категории по выручке:');
    for (const c of topCategories) lines.push(`- ${c.name}: ${c.share}% выручки`);
    lines.push('');
  }
  if (topProducts.length) {
    lines.push('Наш топ-10 товаров (что уже хорошо продаётся):');
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
  const monthNames = ['', 'январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  const monthNum = now.getMonth() + 1;
  const ctx = {
    topCategories: pickTopCategories(summary),
    topProducts: pickTopProducts(summary),
    monthName: monthNames[monthNum],
    monthNum,
    year: now.getFullYear(),
  };
  const system = buildSystemPrompt();
  const user = buildUserPrompt(ctx);
  const raw = await chatCompletion({
    apiKey,
    model,
    system,
    user,
    temperature: 0.5,
    maxTokens: 1500,
    timeoutMs: 30000,
  });
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
