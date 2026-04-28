const https = require('node:https');

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TIMEOUT_MS = 30000;

function callGroq({ apiKey, model, system, user, timeoutMs }) {
  const body = JSON.stringify({
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Groq ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) {
            reject(new Error('Groq вернул пустой ответ'));
            return;
          }
          resolve(content);
        } catch (error) {
          reject(new Error(`Не удалось разобрать ответ Groq: ${error.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error('LLM timeout'));
    });
    req.write(body);
    req.end();
  });
}

function buildSystemPrompt() {
  return `Ты — старший маркетинг-аналитик сети кондитерских «Мария» в Иркутске.
Получаешь сводку маркетинг-метрик и продаж за период. Твоя задача — найти неочевидные связи и дать практические рекомендации, привязанные к конкретным каналам и точкам.

Отвечай строго в JSON:
{
  "summary": "1-2 предложения общей картины с ключевыми цифрами",
  "insights": ["наблюдение, опирающееся на цифры из контекста", ...],
  "warnings": ["риск или проблема, требующая внимания", ...],
  "recommendations": ["конкретное действие с цифрами и сроками", ...]
}

Правила:
- Все суммы в рублях, проценты — числом с %
- Используй ТОЛЬКО данные из контекста, не выдумывай цифры или каналы
- Каждая рекомендация должна быть actionable: что именно сделать, на сколько, в какие сроки
- Не повторяй одно и то же между insights / warnings / recommendations
- 4-6 пунктов в insights, 1-3 в warnings, 3-5 в recommendations
- Если каналов мало — анализируй то, что есть, не придумывай отсутствующие`;
}

function buildUserPrompt({ period, marketing, sales }) {
  const lines = [];
  lines.push(`Период: ${period}`);

  lines.push('');
  lines.push('=== Маркетинг (агрегат) ===');
  const t = marketing.totals;
  lines.push(`Расход: ${t.spend} ₽ | Выручка с маркетинга: ${t.revenue} ₽ | ROAS: ${t.roas}`);
  lines.push(`CTR: ${t.ctr}% | CVR: ${t.cvr}% | CPL: ${t.cpl} ₽ | CAC: ${t.cac} ₽ | AOV: ${t.aov} ₽`);
  lines.push(`Лиды: ${t.leads} | Заказы: ${t.orders} | Сессии: ${t.sessions} | Клики: ${t.clicks} | Показы: ${t.impressions}`);
  lines.push(`Доля маркетинговой выручки от общего факта продаж: ${marketing.salesShare}%`);

  lines.push('');
  lines.push('=== Каналы ===');
  for (const ch of marketing.channels) {
    lines.push(
      `- ${ch.channelName}: spend ${ch.spend} ₽, revenue ${ch.revenue} ₽, ROAS ${ch.roas}, ` +
      `orders ${ch.orders}, leads ${ch.leads}, CTR ${ch.ctr}%, CVR ${ch.cvr}%, CAC ${ch.cac} ₽, AOV ${ch.aov} ₽`
    );
  }

  lines.push('');
  lines.push('=== Продажи ===');
  const st = sales.totals;
  lines.push(`Факт: ${st.fact} ₽ при плане ${st.plan} ₽ (выполнение ${st.completion}%)`);
  lines.push(`Маржа: ${st.margin} ₽ (${st.marginPct}% от выручки) | Себестоимость: ${st.cost} ₽`);
  lines.push(`Кол-во проданных позиций: ${st.quantity}`);

  if (sales.forecast) {
    lines.push(
      `Прогноз на конец месяца: ${sales.forecast.projectedFact} ₽ (${sales.forecast.projectedCompletion}% от плана). ` +
      `Осталось дней: ${sales.forecast.remainingDays}. Нужно ${sales.forecast.requiredPerDayToPlan} ₽/день для выхода в план. ` +
      `Текущий темп: ${sales.forecast.averagePerDay} ₽/день.`
    );
  }

  if (sales.comparison?.hasData) {
    const cmp = sales.comparison;
    lines.push(
      `Сравнение с ${cmp.previousPeriod}: факт изменился на ${cmp.factDelta} ₽ (${cmp.factDeltaPercent}%), ` +
      `выполнение ${cmp.completionDelta > 0 ? '+' : ''}${cmp.completionDelta}пп, маржа ${cmp.marginDelta} ₽.`
    );
  }

  if (sales.trend?.periods?.length) {
    const active = sales.trend.periods.filter((p) => p.fact > 0);
    if (active.length) {
      lines.push('');
      lines.push('=== Тренд по периодам ===');
      for (const p of active) {
        lines.push(`- ${p.period}: план ${p.plan} ₽, факт ${p.fact} ₽ (${p.completion}%), маржа ${p.marginPct}%`);
      }
    }
  }

  lines.push('');
  lines.push('=== Топ-3 точки по выручке ===');
  for (const s of sales.stores.slice(0, 3)) {
    lines.push(`- ${s.storeName}: ${s.fact} ₽ (${s.percent}% плана, маржа ${s.marginPct}%)`);
  }

  lines.push('');
  lines.push('=== Отстающие точки (низший % выполнения, среди тех у кого есть план) ===');
  const lagging = [...sales.stores]
    .filter((s) => s.plan > 0)
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 3);
  for (const s of lagging) {
    lines.push(`- ${s.storeName}: ${s.percent}% (${s.fact} из ${s.plan} ₽)`);
  }

  return lines.join('\n');
}

async function analyzeWithLLM({ period, marketing, sales, apiKey, model, timeoutMs }) {
  if (!apiKey) {
    throw new Error('GROQ_API_KEY не задан');
  }
  const raw = await callGroq({
    apiKey,
    model,
    timeoutMs,
    system: buildSystemPrompt(),
    user: buildUserPrompt({ period, marketing, sales })
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`LLM вернул невалидный JSON: ${raw.slice(0, 200)}`);
  }
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    insights: Array.isArray(parsed.insights) ? parsed.insights.filter((x) => typeof x === 'string') : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((x) => typeof x === 'string') : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.filter((x) => typeof x === 'string') : []
  };
}

module.exports = { analyzeWithLLM };
