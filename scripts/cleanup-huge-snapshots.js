/**
 * Очистка таблицы upp_diagnostic от слишком больших снимков и старых записей.
 * Используется когда сервер падает в OOM при чтении огромного диагностического
 * пакета от 1С.
 *
 * Запуск:
 *   node scripts/cleanup-huge-snapshots.js
 *
 * Берёт DATABASE_URL из env (либо .env файла проекта, либо системной переменной).
 */

const fs = require('fs');
const path = require('path');

// Поддержка .env без дополнительных пакетов
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath) && !process.env.DATABASE_URL) {
  const env = fs.readFileSync(envPath, 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL не задан. Поставьте в .env или передайте через переменную окружения.');
  process.exit(1);
}

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MAX_SIZE = 30_000_000; // 30 МБ
const KEEP_LATEST = 3;

(async () => {
  try {
    console.log('=== Анализ таблицы upp_diagnostic ===');
    const before = await pool.query(`
      SELECT id, received_at, size_bytes,
             length(payload::text) as actual_size
      FROM upp_diagnostic ORDER BY received_at DESC
    `);
    console.log(`Всего снимков: ${before.rows.length}`);
    let totalSize = 0;
    before.rows.forEach(r => {
      totalSize += r.actual_size || 0;
      console.log(`  id=${r.id}  ${r.received_at}  declared=${(r.size_bytes||0).toLocaleString()}  actual=${(r.actual_size||0).toLocaleString()}`);
    });
    console.log(`Общий размер: ${totalSize.toLocaleString()} байт (${(totalSize/1024/1024).toFixed(1)} МБ)`);

    console.log(`\n=== Удаление снимков > ${MAX_SIZE} байт (30 МБ) ===`);
    const big = await pool.query(
      `DELETE FROM upp_diagnostic
       WHERE length(payload::text) > $1 OR size_bytes > $1
       RETURNING id, size_bytes, length(payload::text) as actual`,
      [MAX_SIZE]
    );
    console.log(`Удалено крупных: ${big.rowCount}`);
    big.rows.forEach(r => console.log(`  id=${r.id}  size=${(r.actual||0).toLocaleString()}`));

    console.log(`\n=== Оставляем ${KEEP_LATEST} последних ===`);
    const old = await pool.query(
      `DELETE FROM upp_diagnostic
       WHERE id NOT IN (
         SELECT id FROM upp_diagnostic ORDER BY received_at DESC LIMIT $1
       )
       RETURNING id`,
      [KEEP_LATEST]
    );
    console.log(`Удалено старых: ${old.rowCount}`);

    console.log('\n=== VACUUM (освобождение места) ===');
    await pool.query('VACUUM upp_diagnostic');
    console.log('VACUUM выполнен');

    const after = await pool.query(
      `SELECT id, received_at, size_bytes, length(payload::text) as actual_size
       FROM upp_diagnostic ORDER BY received_at DESC`
    );
    console.log(`\n=== После очистки: ${after.rows.length} снимков ===`);
    after.rows.forEach(r => console.log(`  id=${r.id}  ${r.received_at}  size=${(r.actual_size||0).toLocaleString()}`));

    console.log('\n✓ Готово. Render-сервис теперь сможет нормально стартовать.');
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
