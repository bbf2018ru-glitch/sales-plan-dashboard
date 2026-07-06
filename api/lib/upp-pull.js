const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { URL } = require('node:url');

// 1С на тяжёлых выгрузках (/sales-detail за полный месяц, /pull) отвечает
// ~100-120с. Прежние 60с резали ответ → оба ретрая падали по таймауту и
// витрина «Маркетинг по каналам» оставалась пустой/с нулями. 180с с запасом.
const DEFAULT_TIMEOUT_MS = 180000;

async function fetchUppPackage(opts) {
  // Retry: 1 повтор через 2 сек на случай разового таймаута/сбоя сети
  try {
    return await fetchUppPackageOnce(opts);
  } catch (e) {
    if (!/timeout|ECONN|ETIMEDOUT|EHOSTUNREACH/i.test(e.message)) throw e;
    await new Promise(r => setTimeout(r, 2000));
    return fetchUppPackageOnce(opts);
  }
}

function fetchUppPackageOnce({ url, username, password, period, timeoutMs }) {
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
      // Копим Buffer'ы и декодируем ОДИН раз в конце. Раньше было `raw += chunk`,
      // что декодирует каждый TCP-чанк отдельно — многобайтовый UTF-8 символ
      // (кириллица), попавший на границу чанка, бился на два `�`. На больших
      // ответах (/sales-detail, 78k+ строк, мегабайты) это рандомно портило
      // storeCode/cardCode/суммы → фантомные точки и искажённая выручка.
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
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

// Прогоняет fetch+ingest в worker-потоке (вне главного event-loop). Резолвит
// объект run либо реджектит ошибкой (реальной пула/ingest или инфраструктурной).
function runPullIngestInWorker({ uppConfig, period, storeOptions }) {
  const { Worker } = require('node:worker_threads');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'pull-ingest-worker.js'), {
        workerData: { uppConfig, period, storeOptions }
      });
    } catch (spawnErr) {
      // Синхронный сбой старта воркера — помечаем как инфраструктурный (фолбэк выше).
      spawnErr.workerInfra = true;
      return reject(spawnErr);
    }
    worker.once('message', (msg) => {
      worker.terminate();
      if (msg && msg.ok) done(resolve, msg.run);
      else done(reject, new Error((msg && msg.error) || 'worker ingest failed'));
    });
    worker.once('error', (err) => { err.workerInfra = true; done(reject, err); });
    worker.once('exit', (code) => {
      if (code !== 0 && !settled) { const e = new Error(`pull worker exited (${code}) без результата`); e.workerInfra = true; done(reject, e); }
    });
  });
}

/**
 * Запускает периодический опрос HTTP-сервиса 1С УПП.
 * При storeOptions.databaseUrl (прод, postgres) тяжёлый fetch+ingest уходит в
 * worker-поток, чтобы не морозить главный event-loop. При инфраструктурном сбое
 * воркера — безопасный фолбэк на inline-ingest (данные всё равно обновятся;
 * ingestUppPayload идемпотентен по packageId/payloadHash).
 * Возвращает функцию остановки.
 */
function startPullScheduler({ config, store, storeOptions, intervalMs, onResult, onError }) {
  if (!config.url) return () => {};
  const useWorker = !!(storeOptions && storeOptions.databaseUrl);
  const ingestInline = async (period) => {
    const payload = await fetchUppPackage({ ...config, period });
    return store.ingestUppPayload(payload);
  };
  const trigger = async () => {
    try {
      const period = config.currentPeriod ? config.currentPeriod() : undefined;
      let run;
      if (useWorker) {
        try {
          const uppConfig = { url: config.url, username: config.username, password: config.password, timeoutMs: config.timeoutMs };
          run = await runPullIngestInWorker({ uppConfig, period, storeOptions });
        } catch (workerErr) {
          if (workerErr.workerInfra) {
            console.error(`[upp-pull] worker infra failure → inline fallback: ${workerErr.message}`);
            run = await ingestInline(period);
          } else {
            throw workerErr; // реальная ошибка пула/ingest — в onError
          }
        }
      } else {
        run = await ingestInline(period);
      }
      onResult?.(run);
    } catch (error) {
      onError?.(error);
    }
  };
  trigger();
  const handle = setInterval(trigger, intervalMs);
  return () => clearInterval(handle);
}

module.exports = { fetchUppPackage, startPullScheduler, runPullIngestInWorker };
