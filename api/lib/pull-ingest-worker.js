// Worker-thread: тянет пакет из 1С УПП, ингестит и считает сводку дашборда ВНЕ
// главного event-loop. Тяжёлый синхронный путь (JSON.parse мегабайтного ответа →
// normalizeUppPayload ~78k строк → JSON.stringify(raw)) + агрегация снимка морозили
// единственный event-loop сервера на КАЖДЫЙ пул (~1/мин) — дашборд подвисал у всех.
// Здесь всё это в отдельном потоке со своим pg-пулом; главный процесс отзывчив.
// Возвращаем run + посчитанные totals (для SSE) — чтобы main не грузил getDb/aggregate.
const { parentPort, workerData } = require('node:worker_threads');
const { fetchUppPackage } = require('./upp-pull');
const { createStore } = require('../storage');

(async () => {
  const store = createStore(workerData.storeOptions);
  try {
    const payload = await fetchUppPackage({ ...workerData.uppConfig, period: workerData.period });
    const run = await store.ingestUppPayload(payload);
    // Сводка считается ЗДЕСЬ (воркер уже прочитал БД под ingest, кэш свежий) — main
    // получит готовые totals и не будет блокировать луп на getDb+aggregateDashboard.
    // Если не вышло — не критично: main посчитает сам как фолбэк (totals undefined).
    let totals;
    try {
      if (run && run.status === 'success') {
        const { aggregateDashboard } = require('./analytics');
        const db = await store.getDb();
        totals = aggregateDashboard(db, workerData.period).totals;
      }
    } catch (_) { totals = undefined; }
    parentPort.postMessage({ ok: true, run, totals });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
  } finally {
    // Закрываем свой пул (postgres) — воркер одноразовый, живёт один пул.
    try { if (store && store.pool && typeof store.pool.end === 'function') await store.pool.end(); } catch (_) {}
  }
})();
