const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT_MS = 30000;

function fetchUppPackage({ url, username, password, period, timeoutMs }) {
  if (!url) throw new Error('UPP_PULL_URL не задан');
  const target = new URL(url);
  if (period) target.searchParams.set('period', period);
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const headers = { 'Accept': 'application/json' };
  if (username) {
    const auth = Buffer.from(`${username}:${password || ''}`).toString('base64');
    headers['Authorization'] = `Basic ${auth}`;
  }

  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + (target.search || ''),
      method: 'GET',
      headers
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`UPP HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`UPP вернул не-JSON: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error('UPP pull timeout'));
    });
    req.end();
  });
}

/**
 * Запускает периодический опрос HTTP-сервиса 1С УПП.
 * Возвращает функцию остановки.
 */
function startPullScheduler({ config, store, intervalMs, onResult, onError }) {
  if (!config.url) return () => {};
  const trigger = async () => {
    try {
      const period = config.currentPeriod ? config.currentPeriod() : undefined;
      const payload = await fetchUppPackage({ ...config, period });
      const run = await store.ingestUppPayload(payload);
      onResult?.(run);
    } catch (error) {
      onError?.(error);
    }
  };
  trigger();
  const handle = setInterval(trigger, intervalMs);
  return () => clearInterval(handle);
}

module.exports = { fetchUppPackage, startPullScheduler };
