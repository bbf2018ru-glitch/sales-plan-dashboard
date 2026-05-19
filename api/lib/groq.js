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

module.exports = { callGroq, chatCompletion, DEFAULT_MODEL };
