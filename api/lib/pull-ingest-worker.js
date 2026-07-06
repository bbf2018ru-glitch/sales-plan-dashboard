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
    // Сводка И снимок БД считаются/сериализуются ЗДЕСЬ (воркер уже прочитал БД под
    // ingest). main получит готовые totals (для SSE) и снимок строкой для прайминга
    // кэша — и не будет блокировать луп ни на getDb (~2.3с), ни на aggregate (~2.2с).
    // Если не вышло — не критично: main посчитает/перезагрузит сам как фолбэк.
    let totals, snapshotJson;
    try {
      if (run && run.status === 'success') {
        const { aggregateDashboard } = require('./analytics');
        const db = await store.getDb();
        totals = aggregateDashboard(db, workerData.period).totals;
        snapshotJson = JSON.stringify(db); // ~15МБ; парсинг на main ~0.25с вместо 2.3с холодного getDb
      }
    } catch (_) { totals = undefined; snapshotJson = undefined; }
    parentPort.postMessage({ ok: true, run, totals, snapshotJson });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
  } finally {
    // Закрываем свой пул (postgres) — воркер одноразовый, живёт один пул.
    try { if (store && store.pool && typeof store.pool.end === 'function') await store.pool.end(); } catch (_) {}
  }
})();
