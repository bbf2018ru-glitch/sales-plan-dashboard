/**
 * Применяет sql/init.sql к новой БД на Render PostgreSQL.
 * DATABASE_URL передаётся через переменную окружения NEW_DATABASE_URL.
 *
 * Запуск:
 *   $env:NEW_DATABASE_URL='postgresql://...' ; node scripts/apply-schema-to-new-db.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const url = process.env.NEW_DATABASE_URL;
if (!url) {
  console.error('Поставьте NEW_DATABASE_URL в переменную окружения');
  process.exit(1);
}

const pool = new Pool({
  connectionString: url + (url.includes('?') ? '&' : '?') + 'sslmode=require',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000
});
const schemaPath = path.join(__dirname, '..', 'sql', 'init.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

(async () => {
  try {
    console.log('Применяю схему...');
    await pool.query(schema);
    console.log('✓ Схема применена');

    const tables = await pool.query(`
      SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename
    `);
    console.log(`\n=== Таблицы (${tables.rows.length}) ===`);
    tables.rows.forEach(r => console.log('  ' + r.tablename));
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
