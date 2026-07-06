// Worker-thread: тянет пакет из 1С УПП и ингестит его ВНЕ главного event-loop.
// Тяжёлый синхронный путь (JSON.parse мегабайтного ответа → normalizeUppPayload
// ~78k строк → JSON.stringify(raw)) морозил единственный event-loop сервера на
// несколько секунд на КАЖДЫЙ пул (~1/мин) — дашборд подвисал у всех. Здесь эта
// цепочка выполняется в отдельном потоке со своим pg-пулом; главный процесс
// остаётся отзывчивым. Результат (run) возвращается в главный поток сообщением.
const { parentPort, workerData } = require('node:worker_threads');
const { fetchUppPackage } = require('./upp-pull');
const { createStore } = require('../storage');

(async () => {
  const store = createStore(workerData.storeOptions);
  try {
    const payload = await fetchUppPackage({ ...workerData.uppConfig, period: workerData.period });
    const run = await store.ingestUppPayload(payload);
    parentPort.postMessage({ ok: true, run });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
  } finally {
    // Закрываем свой пул (postgres) — воркер одноразовый, живёт один пул.
    try { if (store && store.pool && typeof store.pool.end === 'function') await store.pool.end(); } catch (_) {}
  }
})();
