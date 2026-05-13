/**
 * READ-ONLY проверка: подключаемся к Render PG извне и считаем что в БД.
 * Ничего не меняет. Только COUNT(*) и LIMIT 5.
 */
const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL не задан'); process.exit(1); }

const pool = new Pool({
  connectionString: url + (/sslmode=/i.test(url) ? '' : (url.includes('?') ? '&' : '?') + 'sslmode=require'),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000
});

(async () => {
  try {
    const v = await pool.query('SELECT version()');
    console.log('✓ Подключение OK ·', v.rows[0].version.substring(0, 60));

    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM stores)            AS stores,
        (SELECT COUNT(*) FROM products)          AS products,
        (SELECT COUNT(*) FROM plans)             AS plans,
        (SELECT COUNT(*) FROM sales)             AS sales,
        (SELECT COUNT(*) FROM marketing_metrics) AS marketing,
        (SELECT COUNT(*) FROM comments)          AS comments,
        (SELECT COUNT(*) FROM ingest_runs)       AS ingest_runs
    `);
    console.log('\n=== Кол-во записей ===');
    console.log(counts.rows[0]);

    const stores = await pool.query(`SELECT id, name, region, source FROM stores ORDER BY id LIMIT 30`);
    console.log(`\n=== Магазины (всего ${stores.rowCount}) ===`);
    stores.rows.forEach(s => console.log(`  ${s.id}  ${s.name}  [${s.region}]  src=${s.source||'-'}`));

    const periods = await pool.query(`SELECT period, COUNT(*) AS plans, SUM(amount)::numeric AS sum FROM plans GROUP BY period ORDER BY period`);
    console.log(`\n=== Периоды в plans ===`);
    periods.rows.forEach(p => console.log(`  ${p.period}  rows=${p.plans}  sum=${Number(p.sum).toLocaleString('ru-RU')}`));

    const salesP = await pool.query(`SELECT period, COUNT(*) AS rows, SUM(amount)::numeric AS sum FROM sales GROUP BY period ORDER BY period`);
    console.log(`\n=== Периоды в sales ===`);
    salesP.rows.forEach(p => console.log(`  ${p.period}  rows=${p.rows}  sum=${Number(p.sum).toLocaleString('ru-RU')}`));

    const ing = await pool.query(`SELECT id, package_id, source_system, period, status, created_at FROM ingest_runs ORDER BY created_at DESC LIMIT 5`);
    console.log(`\n=== Последние ingest_runs (${ing.rowCount}) ===`);
    ing.rows.forEach(r => console.log(`  ${r.created_at}  ${r.source_system}  ${r.period}  ${r.status}  pkg=${r.package_id}`));
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
