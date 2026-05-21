// Общий helper для вызовов Groq API. Поддерживает GROQ_BASE_URL env
// (прокси для регионально-заблокированных IP). Используется и в ai-chat,
// и в insights — раньше было два почти одинаковых клиента.

const https = require('node:https');

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TIMEOUT_MS = 30000;

function callGroq({ apiKey, model, messages, temperature, maxTokens, timeoutMs }) {
  if (!apiKey) throw new Error('Groq apiKey не задан');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Groq: messages обязательны');
  }
  const body = JSON.stringify({
    model: model || DEFAULT_MODEL,
    messages,
    temperature: temperature ?? 0.2,
    max_tokens: maxTokens ?? 500
  });

  const baseUrl = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const url = new URL(`${baseUrl}/chat/completions`);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Groq ${res.statusCode}: ${raw.slice(0, 300)}`));
        }
        try {
          const p = JSON.parse(raw);
          resolve(p.choices?.[0]?.message?.content || '');
        } catch (e) {
          reject(new Error('Groq parse failed: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () => req.destroy(new Error('Groq timeout')));
    req.write(body);
    req.end();
  });
}

// Удобный shortcut для system+user пары.
function chatCompletion({ apiKey, model, system, user, temperature, maxTokens, timeoutMs }) {
  return callGroq({
    apiKey,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature,
    maxTokens,
    timeoutMs
  });
}

// Пробует модели по списку, при 429 (квота исчерпана) переключается
// на следующую. Полезно для Free tier где у моделей разные дневные лимиты:
//   llama-3.3-70b-versatile: ~100K TPD
//   llama-3.1-8b-instant:    ~500K TPD (резерв когда 70b кончилась)
async function callGroqWithFallback({ apiKey, models, ...rest }) {
  let lastErr;
  for (const model of models) {
    try {
      return { text: await callGroq({ apiKey, model, ...rest }), model };
    } catch (err) {
      lastErr = err;
      if (/Groq 429/.test(err.message)) continue;
      throw err;
    }
  }
  throw lastErr || new Error('All Groq models rate-limited');
}

// Единый каскад провайдеров для LLM: OpenAI (если ключ задан) → Groq 70b → Groq 8b.
// Возвращает { text, model, provider } — caller может показать какой бэкенд ответил.
// Cascading логика:
//   - OpenAI сначала: лучше следует инструкциям, отдельный лимит от Groq
//   - При 429/5xx/timeout на OpenAI → fallback на Groq 70b
//   - При 429 на Groq 70b → fallback на Groq 8b
async function callLlmCascade({ messages, temperature, maxTokens, timeoutMs }) {
  const { callOpenAI } = require('./openai');
  const openaiKey = process.env.OPENAI_API_KEY || '';
  const groqKey = process.env.GROQ_KEY || process.env.GROQ_API_KEY || '';

  const attempts = [];
  if (openaiKey) attempts.push({ provider: 'openai', model: process.env.OPENAI_MODEL || 'gpt-4o-mini', fn: callOpenAI, apiKey: openaiKey });
  if (groqKey) {
    attempts.push({ provider: 'groq', model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', fn: callGroq, apiKey: groqKey });
    attempts.push({ provider: 'groq', model: 'llama-3.1-8b-instant', fn: callGroq, apiKey: groqKey });
  }
  if (attempts.length === 0) throw new Error('Ни OPENAI_API_KEY, ни GROQ_KEY не заданы в env');

  let lastErr;
  for (const a of attempts) {
    try {
      const text = await a.fn({ apiKey: a.apiKey, model: a.model, messages, temperature, maxTokens, timeoutMs });
      return { text, model: a.model, provider: a.provider };
    } catch (err) {
      lastErr = err;
      // 401/403/409/429/5xx/timeout — переходим на следующего провайдера.
      // 403 особенно важно: OpenAI блокирует РФ IP-адреса, без fallback чат
      // вообще не работает с VDS в РФ.
      if (/\b(4(0[139]|29)|5\d\d|timeout)\b/i.test(err.message)) continue;
      throw err;
    }
  }
  throw lastErr || new Error('Все LLM-провайдеры недоступны');
}

module.exports = { callGroq, chatCompletion, callGroqWithFallback, callLlmCascade, DEFAULT_MODEL };
