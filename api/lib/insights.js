// Топ-5 «что посмотреть» — детектор аномалий на правилах + опциональная
// LLM-обёртка через Groq. Без LLM возвращает rule-based буллеты.

const https = require('https');
const { getUpcomingEvents, seasonalContext, holidayDaysInPeriod } = require('./calendar-irk');

// ─── Детектор аномалий ────────────────────────────────────────────────────
// Возвращает массив [{ severity, kind, store?, product?, headline, detail }]
// severity: 'high' | 'medium' | 'low'

// Какую долю от выручки сети нужно иметь категория/магазин, чтобы считаться
// «в работе». Меньше = из инсайтов исключаются.
const ACTIVITY_SHARE_MIN = 0.02;       // 2% от выручки сети — категория «в работе»
const ACTIVITY_STORE_FACT_MIN = 50000; // ₽ за период — магазин «в работе»

// Был ли магазин активен последние N дней (есть продажи).
// Защищает от алертов по точкам которые закрыты/выходят из сети.
function storeActiveRecently(storeId, db, period, daysBack = 7) {
  const cutoff = Date.now() - daysBack * 86400 * 1000;
  for (const s of db.sales || []) {
    if (s.period !== period) continue;
    if ((s.storeId || s.store_id) !== storeId) continue;
    const at = s.soldAt || s.sold_at;
    if (!at) continue;
    if (new Date(at).getTime() >= cutoff) return true;
  }
  return false;
}

function detectAnomalies(summary, db, period) {
  const findings = [];
  const networkFact = summary.totals.fact || 1;

  // Если в периоде нет ни планов, ни фактов — это просто будущий или ещё
  // не загруженный месяц. Не показываем «прогноз 0%», «-100% YoY» и пр.
  // Возвращаем только upcoming holidays.
  const hasAnyData = (summary.totals.plan || 0) > 0 || (summary.totals.fact || 0) > 0;
  if (!hasAnyData) {
    const upcoming = getUpcomingEvents(35).filter((e) => e.impact !== 'low');
    if (upcoming.length) {
      const e = upcoming[0];
      findings.push({
        severity: e.daysFromNow <= 7 ? 'high' : 'medium',
        kind: 'upcoming-holiday',
        headline: `${e.name} — через ${e.daysFromNow} дн. (${e.date})`,
        detail: e.note || 'Закладывайте плановый рост спроса. Заказы на торты приходят за несколько дней.',
      });
    }
    findings.push({
      severity: 'low',
      kind: 'no-data',
      headline: 'За этот период данных пока нет',
      detail: 'Дождитесь выгрузки из 1С или выберите другой период в селекторе.',
    });
    return findings;
  }

  // 1. Точки в риске — выполнение < 80% при оставшихся днях ≤ 7.
  //    Фильтр: только активные за последнюю неделю + значимый объём,
  //    чтобы не алертить про закрытые/служебные точки.
  const remainingDays = summary.forecast.remainingDays;
  if (remainingDays > 0 && remainingDays <= 10) {
    const risky = summary.stores
      .filter((s) => s.plan > 0 && s.percent < 80)
      .filter((s) => s.fact >= ACTIVITY_STORE_FACT_MIN)
      .filter((s) => storeActiveRecently(s.storeId, db, period))
      .sort((a, b) => a.percent - b.percent)
      .slice(0, 3);
    for (const s of risky) {
      const reqPerDay = (s.plan - s.fact) / remainingDays;
      findings.push({
        severity: s.percent < 60 ? 'high' : 'medium',
        kind: 'lagging-store',
        store: s.storeName,
        headline: `${s.storeName}: выполнение ${s.percent}%, осталось ${remainingDays} дн.`,
        detail: `Чтобы выйти в план, нужно ${formatRu(reqPerDay)} ₽/день. Сейчас в среднем ${formatRu(s.fact / Math.max(summary.forecast.elapsedDays, 1))} ₽/день.`,
      });
    }
  }

  // 2. Прогноз сети ниже плана
  if (summary.forecast.projectedCompletion < 95 && remainingDays > 0) {
    findings.push({
      severity: summary.forecast.projectedCompletion < 85 ? 'high' : 'medium',
      kind: 'forecast-low',
      headline: `Прогноз закрытия месяца — ${summary.forecast.projectedCompletion}%`,
      detail: `При текущем темпе сеть закроется на ${formatRu(summary.forecast.projectedFact)} ₽ (план ${formatRu(summary.totals.plan)} ₽). До конца месяца ${remainingDays} дн.`,
    });
  }

  // 3. YoY-просадки по категориям
  if (summary.yoy?.hasData) {
    const yoyDelta = summary.yoy.factDeltaPercent;
    if (yoyDelta < -5) {
      findings.push({
        severity: yoyDelta < -15 ? 'high' : 'medium',
        kind: 'yoy-decline',
        headline: `Сеть на ${yoyDelta.toFixed(1)}% ниже того же месяца год назад`,
        detail: `Прошлый ${summary.yoy.previousPeriod}: ${formatRu(summary.yoy.previousTotals.fact)} ₽. Сейчас: ${formatRu(summary.totals.fact)} ₽.`,
      });
    }
    // Анализ категорий YoY. Фильтр: текущая доля категории ≥ 2% от выручки сети
    // (иначе это «спящие» направления — не алертим про них).
    const yoyCategories = compareCategoriesYoY(db, period, summary.yoy.previousPeriod);
    const activeCatYoy = yoyCategories
      .filter((c) => c.deltaPercent < -10)
      .filter((c) => c.fact / networkFact >= ACTIVITY_SHARE_MIN);
    for (const c of activeCatYoy.slice(0, 2)) {
      findings.push({
        severity: c.deltaPercent < -25 ? 'high' : 'medium',
        kind: 'category-yoy-decline',
        headline: `Категория «${c.name}» — ${c.deltaPercent.toFixed(1)}% к прошлому году`,
        detail: `Прошлый год: ${formatRu(c.previousFact)} ₽. Сейчас: ${formatRu(c.fact)} ₽.`,
      });
    }
  }

  // 4. Точки с провалом маржи. Фильтр: только значимые по объёму магазины,
  //    активные за последнюю неделю.
  const marginIssues = summary.stores
    .filter((s) => s.fact >= ACTIVITY_STORE_FACT_MIN && s.marginPct !== null && s.marginPct < 15)
    .filter((s) => storeActiveRecently(s.storeId, db, period))
    .sort((a, b) => a.marginPct - b.marginPct)
    .slice(0, 2);
  for (const s of marginIssues) {
    findings.push({
      severity: s.marginPct < 5 ? 'high' : 'medium',
      kind: 'low-margin-store',
      store: s.storeName,
      headline: `${s.storeName}: маржинальность ${s.marginPct}%`,
      detail: `Норма для кондитерской — 25–35%. Проверьте списания и закупочные цены.`,
    });
  }

  // 5. Категории с мизерной долей (< 2%) — НЕ показываем.
  // По смыслу это «спящие» направления, по которым работа не ведётся,
  // и пользователь явно просил их исключить из инсайтов.

  // 6. Праздники впереди
  const upcoming = getUpcomingEvents(35).filter((e) => e.impact !== 'low');
  if (upcoming.length) {
    const e = upcoming[0];
    const tone = e.daysFromNow <= 7 ? 'high' : 'medium';
    findings.push({
      severity: tone,
      kind: 'upcoming-holiday',
      headline: `${e.name} — через ${e.daysFromNow} дн. (${e.date})`,
      detail: e.note || 'Закладывайте плановый рост спроса. Заказы на торты приходят за несколько дней.',
    });
  }

  // 7. Дни с праздниками в текущем периоде — простой счётчик
  const hd = holidayDaysInPeriod(period);
  if (hd.length > 0 && remainingDays > 0) {
    const upcomingHd = hd.filter((h) => h.day > (summary.forecast.elapsedDays || 0));
    if (upcomingHd.length > 0) {
      const e = upcomingHd[0];
      // не дублировать с пунктом 6 — пропустим, если уже добавлено
    }
  }

  return findings;
}

function compareCategoriesYoY(db, period, yoyPeriod) {
  const cur = aggregateCategoryFromDb(db, period);
  const prev = aggregateCategoryFromDb(db, yoyPeriod);
  const result = [];
  for (const [name, fact] of cur.entries()) {
    const previousFact = prev.get(name) || 0;
    if (previousFact > 0) {
      const deltaPercent = ((fact - previousFact) / previousFact) * 100;
      result.push({ name, fact, previousFact, deltaPercent });
    }
  }
  return result.sort((a, b) => a.deltaPercent - b.deltaPercent);
}

function aggregateCategoryFromDb(db, period) {
  const productCat = new Map(db.products.map((p) => [p.id, p.category || 'Прочее']));
  const totals = new Map();
  for (const s of db.sales) {
    if (s.period !== period) continue;
    const cat = productCat.get(s.productId) || 'Прочее';
    totals.set(cat, (totals.get(cat) || 0) + Number(s.amount || 0));
  }
  return totals;
}

function aggregateByCategory(products) {
  const map = new Map();
  for (const p of products) {
    if (p.productId === '_total') continue;
    const cat = p.category || 'Прочее';
    if (!map.has(cat)) map.set(cat, { name: cat, fact: 0 });
    map.get(cat).fact += p.fact || 0;
  }
  return Array.from(map.values());
}

function formatRu(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value || 0);
}

// ─── Вывод в формате Топ-5 ────────────────────────────────────────────────

function rankAndTrim(findings, limit = 5) {
  const order = { high: 0, medium: 1, low: 2 };
  return findings
    .sort((a, b) => order[a.severity] - order[b.severity])
    .slice(0, limit);
}

// ─── LLM-обёртка через Groq ───────────────────────────────────────────────

async function callGroq(apiKey, model, messages, timeoutMs = 15000) {
  const body = JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 700 });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Groq HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed.choices?.[0]?.message?.content || '');
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Groq timeout')); });
    req.write(body);
    req.end();
  });
}

async function llmRefineInsights(findings, summary, period, groqConfig) {
  if (!groqConfig?.apiKey) return null;

  const ctx = {
    period,
    totals: summary.totals,
    forecast: summary.forecast,
    yoy: summary.yoy?.hasData ? {
      factDeltaPercent: summary.yoy.factDeltaPercent,
      previousPeriod: summary.yoy.previousPeriod,
    } : null,
    findings: findings.map((f) => ({ kind: f.kind, severity: f.severity, headline: f.headline, detail: f.detail })),
    upcoming: getUpcomingEvents(45).slice(0, 4),
    seasonal: seasonalContext(),
  };

  const system = `Ты — аналитик кондитерской сети «Мария» в Иркутске. Тебе дают сырые сигналы из дашборда (аномалии, тренды, праздники Восточной Сибири). Сформулируй 5 буллетов на русском языке: что важно сделать на этой и следующей неделе. Каждый буллет — 1–2 предложения, конкретное действие, без воды. Учитывай Иркутск (часовой пояс UTC+8, праздники: Сагаалган, 9 мая в Иркутске с ограничением алкоголя, День города, День Байкала). Не выдумывай цифры — используй только те, что в данных.`;

  const user = `Период: ${period}\nДанные:\n${JSON.stringify(ctx, null, 2)}\n\nВыдай ровно 5 буллетов в формате:\n1. <текст>\n2. <текст>\n...`;

  try {
    const text = await callGroq(groqConfig.apiKey, groqConfig.model || 'llama-3.3-70b-versatile', [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    return text;
  } catch (err) {
    console.warn('[insights] Groq failed:', err.message);
    return null;
  }
}

// ─── Главная функция ──────────────────────────────────────────────────────

async function buildInsights(summary, db, period, options = {}) {
  const findings = detectAnomalies(summary, db, period);
  const top = rankAndTrim(findings, 5);
  const upcoming = getUpcomingEvents(45).slice(0, 5);
  const seasonal = seasonalContext();

  let llmText = null;
  if (options.groq?.apiKey) {
    llmText = await llmRefineInsights(top, summary, period, options.groq);
  }

  return {
    period,
    generatedAt: new Date().toISOString(),
    findings: top,
    findingsAll: findings,
    upcomingEvents: upcoming,
    seasonalContext: seasonal,
    llmSummary: llmText,
    engine: llmText ? 'llm+rules' : 'rules',
  };
}

module.exports = { buildInsights, detectAnomalies };
