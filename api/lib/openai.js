// OpenAI client — HTTP запрос к api.openai.com/v1/chat/completions.
// Используется как приоритетный провайдер (выше Groq) когда OPENAI_API_KEY задан.
// gpt-4o-mini — быстрый/недорогой, хорошо следует инструкциям, отвечает на мета-вопросы.

const https = require('node:https');

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 30000;

function callOpenAI({ apiKey, model, messages, temperature, maxTokens, timeoutMs }) {
  if (!apiKey) throw new Error('OpenAI apiKey не задан');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('OpenAI: messages обязательны');
  }
  const body = JSON.stringify({
    model: model || DEFAULT_MODEL,
    messages,
    temperature: temperature ?? 0.3,
    max_tokens: maxTokens ?? 500
  });

  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = new URL(`${baseUrl}/chat/completions`);

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  };
  // Если OPENAI_BASE_URL указывает на наш прокси (Hostinger Frankfurt) —
  // добавляем shared secret. OpenAI блокирует РФ IP, поэтому VDS Timeweb
  // ходит через прокси-relay в Frankfurt.
  if (process.env.OPENAI_PROXY_AUTH) headers['X-Proxy-Auth'] = process.env.OPENAI_PROXY_AUTH;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`OpenAI ${res.statusCode}: ${raw.slice(0, 300)}`));
        }
        try {
          const p = JSON.parse(raw);
          resolve(p.choices?.[0]?.message?.content || '');
        } catch (e) {
          reject(new Error('OpenAI parse failed: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () => req.destroy(new Error('OpenAI timeout')));
    req.write(body);
    req.end();
  });
}

module.exports = { callOpenAI, DEFAULT_MODEL };
