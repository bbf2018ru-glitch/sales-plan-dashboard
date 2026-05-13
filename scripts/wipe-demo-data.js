/**
 * Полная очистка demo seed-данных в Render PostgreSQL.
 *
 * Запуск:
 *   node scripts/wipe-demo-data.js
 *
 * Берёт DATABASE_URL из .env. Очищает stores/products/plans/sales/
 * marketing_metrics/comments — то что обычно сидируется. ingest_runs,
 * raw_upp_payloads, upp_diagnostic, users, user_stores оставляет.
 *
 * После запуска в БД останутся только реальные данные от 1С (как только
 * Hellstaff отправит первый ingest).
 */

const fs = require('fs');
const path = require('path');

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

let url = process.env.DATABASE_URL;
const externalRe = /\.oregon-postgres\.render\.com/;

if (!externalRe.test(url)) {
  console.error('Похоже DATABASE_URL — internal URL. Для подключения извне нужен external (с .oregon-postgres.render.com)');
  process.exit(1);
}

if (!/sslmode=/i.test(url)) {
  url += (url.includes('?') ? '&' : '?') + 'sslmode=require';
}

const pool = new Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000
});

(async () => {
  try {
    console.log('=== До очистки ===');
    const before = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM stores)              AS stores,
        (SELECT COUNT(*) FROM products)            AS products,
        (SELECT COUNT(*) FROM plans)               AS plans,
        (SELECT COUNT(*) FROM sales)               AS sales,
        (SELECT COUNT(*) FROM marketing_metrics)   AS marketing,
        (SELECT COUNT(*) FROM comments)            AS comments,
        (SELECT COUNT(*) FROM ingest_runs)         AS ingest_runs
    `);
    console.log(before.rows[0]);

    console.log('\n=== Удаление demo-данных ===');
    await pool.query(`
      TRUNCATE
        plans,
        sales,
        marketing_metrics,
        comments,
        user_stores,
        products,
        stores
      RESTART IDENTITY CASCADE
    `);
    console.log('✓ TRUNCATE выполнен');

    const after = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM stores)              AS stores,
        (SELECT COUNT(*) FROM products)            AS products,
        (SELECT COUNT(*) FROM plans)               AS plans,
        (SELECT COUNT(*) FROM sales)               AS sales,
        (SELECT COUNT(*) FROM marketing_metrics)   AS marketing,
        (SELECT COUNT(*) FROM comments)            AS comments,
        (SELECT COUNT(*) FROM ingest_runs)         AS ingest_runs
    `);
    console.log('\n=== После очистки ===');
    console.log(after.rows[0]);
    console.log('\n✓ Готово. Дашборд теперь пустой и ждёт реальных данных от 1С.');
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
