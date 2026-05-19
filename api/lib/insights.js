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
const ACTIVITY_CAT_FACT_MIN = 100000;  // ₽ за период — категория «в работе» (даже если доля норм)

// Лидер показывается только для «нормальных» магазинов — иначе точка с
// заниженным планом (Солнечный 11/4: план 100К, факт 660К → 660%) забивает
// слот лидерства, а реальные крупные магазины не видны.
const LEADER_PLAN_MIN = 500000;        // ₽ — план должен быть «настоящим»
const LEADER_PERCENT_MAX = 200;        // % — выше — это уже не лидер, а план-аномалия

// Plan-anomaly: явный признак ошибки в планировании 1С. Выносим отдельным
// сигналом, чтобы пользователь поправил план или убедился что точка не
// тестовая/новая/закрытая.
const PLAN_ANOMALY_PERCENT = 300;      // % — выше — почти наверняка ошибка плана
const PLAN_ANOMALY_PLAN_MAX = 200000;  // ₽ — план явно занижен относительно сети

// Категории которые НЕ показываем в инсайтах. По фидбеку пользователя:
//   «Хлеб»          — направление закрыто
//   «Торты на заказ» — и в прошлом году не было полноценной работы
//   «Прочее», «Сырьё*», «Тара», «Добавки», «Акция» — служебные/не-розничные
const CATEGORY_BLACKLIST = /(^Хлеб$|Торты на заказ|^Прочее$|^Сырь[её]|^Тара|^Добавки|^Акция|^Сертификат|^Товары для праздника)/i;
function isCategoryRelevant(name) {
  if (!name) return false;
  return !CATEGORY_BLACKLIST.test(String(name).trim());
}

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
    const upcoming = getUpcomingEvents(60).filter((e) => e.impact !== 'low');
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

  // 1. Точки в риске — выполнение < 80%, начиная с середины месяца.
  //    Раньше показывали только когда оставалось ≤10 дней — слишком поздно:
  //    при 12 днях до конца месяца руководитель уже хочет видеть провисающие
  //    точки чтобы успеть среагировать. Теперь алертим с elapsedDays ≥ 10.
  //    Фильтр: только активные за последнюю неделю + значимый объём.
  const remainingDays = summary.forecast.remainingDays;
  const elapsedDays = summary.forecast.elapsedDays || 0;
  if (remainingDays > 0 && elapsedDays >= 10) {
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
        detail: `Чтобы выйти в план, нужно ${formatRu(reqPerDay)} ₽/день. Сейчас в среднем ${formatRu(s.fact / Math.max(elapsedDays, 1))} ₽/день.`,
      });
    }
  }

  // 1а. План-аномалии — магазины с явно заниженным планом (percent > 300%
  //     или план < 200К при значимом факте). Отдельный сигнал «проверьте план в 1С»:
  //     это НЕ лидерство, а ошибка в данных.
  const planAnomalies = summary.stores
    .filter((s) => s.fact >= ACTIVITY_STORE_FACT_MIN)
    .filter((s) => s.plan > 0)
    .filter((s) => s.percent > PLAN_ANOMALY_PERCENT || s.plan < PLAN_ANOMALY_PLAN_MAX)
    .filter((s) => storeActiveRecently(s.storeId, db, period))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 2);
  for (const s of planAnomalies) {
    findings.push({
      severity: 'medium',
      kind: 'plan-anomaly',
      store: s.storeName,
      headline: `${s.storeName}: ${s.percent}% — вероятно ошибка плана`,
      detail: `План ${formatRu(s.plan)} ₽, факт ${formatRu(s.fact)} ₽. Проверьте план в 1С — точка может быть тестовой, новой или с заниженным значением.`,
    });
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

  // 3. YoY-просадки. ВАЖНО: сравниваем «факт на сегодня» с «факт на тот же
  //    день того же месяца год назад» — а не весь месяц с месяцем (это
  //    некорректно когда текущий месяц ещё не закончился).
  const today = summary.today || {};
  if (today.yoyTodayFact != null && today.yoyTodayFact > 0 && today.elapsedDays > 0) {
    const curFact = today.factToDate || 0;
    const prevFact = today.yoyTodayFact;
    const yoyDayDelta = ((curFact - prevFact) / prevFact) * 100;
    if (yoyDayDelta < -5) {
      const yearLabel = today.yoyTodayYearsBack > 1
        ? `тот же день ${today.yoyTodayYearsBack} года назад (${today.yoyTodayPeriod})`
        : `тот же день год назад (${today.yoyTodayPeriod})`;
      findings.push({
        severity: yoyDayDelta < -15 ? 'high' : 'medium',
        kind: 'yoy-today-decline',
        headline: `За ${today.elapsedDays} дн. на ${yoyDayDelta.toFixed(1)}% ниже ${yearLabel}`,
        detail: `На этот день прошлого года накопили: ${formatRu(prevFact)} ₽. Сейчас: ${formatRu(curFact)} ₽.`,
      });
    }
  }

  // YoY-просадки по категориям
  if (summary.yoy?.hasData) {
    // Анализ категорий YoY с тройным фильтром:
    //   - доля ≥ 2% от выручки сети (категория активна сейчас)
    //   - текущий fact ≥ 100К (значимый объём, не эфемера)
    //   - прошлый fact ≥ 100К (категория реально работала, не разовая активность)
    //   - не в blacklist (хлеб/торты-на-заказ/служебные)
    // Сравниваем только за пройденные дни (untilDay = elapsedDays из today)
    const untilDay = today.elapsedDays || summary.forecast?.elapsedDays || null;
    const yoyCategories = compareCategoriesYoY(db, period, summary.yoy.previousPeriod, untilDay);
    const activeCatYoy = yoyCategories
      .filter((c) => c.deltaPercent < -10)
      .filter((c) => c.fact >= ACTIVITY_CAT_FACT_MIN)
      .filter((c) => c.previousFact >= ACTIVITY_CAT_FACT_MIN)
      .filter((c) => c.fact / networkFact >= ACTIVITY_SHARE_MIN)
      .filter((c) => isCategoryRelevant(c.name));
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

  // ── ПОЗИТИВНЫЕ СИГНАЛЫ (показываем когда нет критики, чтобы блок не пустовал) ──

  // 5а. Магазины-лидеры (выполнение 100-200%). Top-3 чтобы дать reference.
  //     Жёсткий нижний порог по плану: точки с планом <500К отсекаем,
  //     иначе аномалии вроде «Солнечный 11/4: план 100К → 660%» забивают
  //     слот вместо реального лидера. Верхний порог 200% — выше это уже
  //     plan-anomaly (см. блок 1а), не лидерство.
  const leaders = summary.stores
    .filter((s) => s.plan >= LEADER_PLAN_MIN)
    .filter((s) => s.percent >= 100 && s.percent <= LEADER_PERCENT_MAX)
    .filter((s) => s.fact >= ACTIVITY_STORE_FACT_MIN)
    .filter((s) => storeActiveRecently(s.storeId, db, period))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 3);
  for (const s of leaders) {
    findings.push({
      severity: 'low',
      kind: 'leader-store',
      store: s.storeName,
      headline: `✓ ${s.storeName}: выполнение ${s.percent}%`,
      detail: `Факт ${formatRu(s.fact)} ₽ при плане ${formatRu(s.plan)} ₽. Полезно изучить что они делают и масштабировать.`
    });
  }

  // 5а-bis. Топ по абсолютной выручке — независимо от %. Даёт positive reference
  //         когда нет лидеров по проценту (типичная картина в середине месяца:
  //         все на 50-70% плана, но кто-то всё равно тянет больше всех в деньгах).
  //         Дедуп: если магазин уже в leaders — не дублируем.
  const leaderIds = new Set(leaders.map((s) => s.storeId));
  const topByRevenue = summary.stores
    .filter((s) => s.fact >= ACTIVITY_STORE_FACT_MIN)
    .filter((s) => !leaderIds.has(s.storeId))
    .filter((s) => storeActiveRecently(s.storeId, db, period))
    .sort((a, b) => (b.fact || 0) - (a.fact || 0))
    .slice(0, 1);
  for (const s of topByRevenue) {
    const pct = s.plan > 0 ? ` (${s.percent}% плана)` : '';
    findings.push({
      severity: 'low',
      kind: 'top-revenue-store',
      store: s.storeName,
      headline: `★ Топ по выручке: ${s.storeName} — ${formatRu(s.fact)} ₽${pct}`,
      detail: `Самый большой оборот в сети за период. План ${formatRu(s.plan)} ₽. Даже если процент не лидерский — это объёмная точка, на её динамику стоит обращать внимание первой.`
    });
  }

  // 5б. Растущие категории vs прошлый год — позитив (с теми же фильтрами)
  if (summary.yoy?.hasData) {
    const untilDay = today.elapsedDays || summary.forecast?.elapsedDays || null;
    const yoyCats = compareCategoriesYoY(db, period, summary.yoy.previousPeriod, untilDay);
    const growing = yoyCats
      .filter((c) => c.deltaPercent > 15)
      .filter((c) => c.fact >= ACTIVITY_CAT_FACT_MIN)
      .filter((c) => c.previousFact >= ACTIVITY_CAT_FACT_MIN)
      .filter((c) => c.fact / networkFact >= ACTIVITY_SHARE_MIN)
      .filter((c) => isCategoryRelevant(c.name))
      .sort((a, b) => b.deltaPercent - a.deltaPercent)
      .slice(0, 1);
    for (const c of growing) {
      findings.push({
        severity: 'low',
        kind: 'category-yoy-growth',
        headline: `↗ «${c.name}» — +${c.deltaPercent.toFixed(0)}% к прошлому году`,
        detail: `Прошлый год за этот период: ${formatRu(c.previousFact)} ₽. Сейчас: ${formatRu(c.fact)} ₽. Что работает — масштабировать.`
      });
    }
  }

  // 5в. Общая позитивная динамика (если сеть идёт лучше прошлого года)
  if (today.yoyTodayFact != null && today.yoyTodayFact > 0 && today.elapsedDays > 0) {
    const yoyDayDelta = ((today.factToDate - today.yoyTodayFact) / today.yoyTodayFact) * 100;
    if (yoyDayDelta > 10) {
      const yearLabel = today.yoyTodayYearsBack > 1 ? `${today.yoyTodayYearsBack} года` : 'год';
      findings.push({
        severity: 'low',
        kind: 'yoy-today-growth',
        headline: `↗ Сеть на +${yoyDayDelta.toFixed(1)}% выше того же дня ${yearLabel} назад`,
        detail: `На ${today.elapsedDays}-й день месяца накопили ${formatRu(today.factToDate)} ₽. В прошлом ${today.yoyTodayPeriod}: ${formatRu(today.yoyTodayFact)} ₽.`
      });
    }
  }

  // 5г. Топ-категория недели — самая значимая по выручке
  const topCat = aggregateByCategory(summary.products)
    .filter((c) => c.fact > 0 && isCategoryRelevant(c.name))
    .sort((a, b) => b.fact - a.fact)
    .slice(0, 1);
  for (const c of topCat) {
    const share = (c.fact / networkFact) * 100;
    findings.push({
      severity: 'low',
      kind: 'top-category',
      headline: `Топ-категория: «${c.name}» — ${share.toFixed(0)}% выручки`,
      detail: `Факт ${formatRu(c.fact)} ₽. Это основа выручки — следить за поставками и наличием.`
    });
  }

  // 6. Праздники впереди
  const upcoming = getUpcomingEvents(60).filter((e) => e.impact !== 'low');
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

  return findings;
}

// Сравнение категорий «факт-на-сегодня vs факт-на-этот-же-день-год-назад».
// untilDay — до какого дня месяца включительно считать (чтобы текущий
// неполный месяц справедливо сравнивался с тем же отрезком прошлого).
function compareCategoriesYoY(db, period, yoyPeriod, untilDay) {
  const cur = aggregateCategoryFromDb(db, period, untilDay);
  const prev = aggregateCategoryFromDb(db, yoyPeriod, untilDay);
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

function aggregateCategoryFromDb(db, period, untilDay) {
  const productCat = new Map(db.products.map((p) => [p.id, p.category || 'Прочее']));
  const totals = new Map();
  for (const s of db.sales) {
    if (s.period !== period) continue;
    // Если задан untilDay — берём только продажи до этого дня месяца включительно
    if (untilDay) {
      const at = s.soldAt || s.sold_at;
      if (!at) continue;
      const d = new Date(at);
      if (Number.isNaN(d.getTime())) continue;
      if (d.getUTCDate() > untilDay) continue;
    }
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
    upcoming: getUpcomingEvents(60).slice(0, 4),
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
  const upcoming = getUpcomingEvents(60).slice(0, 5);
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
