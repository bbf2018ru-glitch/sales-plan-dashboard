#!/usr/bin/env node
/*
 * Очистка "призрачных" магазинов из продакшн PostgreSQL.
 *
 * Призрак = запись в таблице stores, где name = id (авто-заглушка, созданная
 * когда 1С присылала storeId в sales/plans, которого не было в stores[]).
 * Такие записи не имеют нормального имени — только внутренний код 1С.
 *
 * Запуск (диагностика, ничего не удаляет):
 *   node scripts/cleanup-ghost-stores.js
 *
 * Запуск с реальным удалением:
 *   node scripts/cleanup-ghost-stores.js --execute
 */

const { loadProjectEnv } = require('../api/lib/load-env');
loadProjectEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL не задан. Запустите с переменными окружения.');
  process.exit(1);
}

const { Pool } = require('pg');
const pool = new Pool({ connectionString: DATABASE_URL });
const execute = process.argv.includes('--execute');

async function main() {
  console.log(`\nРежим: ${execute ? '🔴 УДАЛЕНИЕ (--execute)' : '🟢 диагностика (без удаления)'}\n`);

  // Найти призрачные магазины (name = id — это признак авто-заглушки)
  const { rows: ghosts } = await pool.query(`
    SELECT s.id, s.name, s.region,
      (SELECT count(*) FROM sales   WHERE store_id = s.id) AS sales_count,
      (SELECT count(*) FROM plans   WHERE store_id = s.id) AS plans_count
    FROM stores s
    WHERE s.name = s.id
    ORDER BY s.id
  `);

  if (!ghosts.length) {
    console.log('✓ Призрачных магазинов не найдено. База чистая.');
    await pool.end();
    return;
  }

  console.log(`Найдено призрачных магазинов: ${ghosts.length}`);
  console.log('─'.repeat(60));
  for (const g of ghosts) {
    console.log(`  ${g.id.padEnd(30)} sales=${g.sales_count} plans=${g.plans_count}`);
  }
  console.log('─'.repeat(60));

  const totalSales = ghosts.reduce((s, g) => s + Number(g.sales_count), 0);
  const totalPlans = ghosts.reduce((s, g) => s + Number(g.plans_count), 0);
  console.log(`Итого связанных записей: ${totalSales} продаж, ${totalPlans} планов`);

  if (!execute) {
    console.log('\nЧтобы удалить, добавьте флаг --execute');
    await pool.end();
    return;
  }

  // Удаляем в правильном порядке (FK)
  const ghostIds = ghosts.map(g => g.id);
  const placeholders = ghostIds.map((_, i) => `$${i + 1}`).join(',');

  await pool.query(`DELETE FROM user_stores WHERE store_id IN (${placeholders})`, ghostIds);
  const { rowCount: delSales } = await pool.query(`DELETE FROM sales WHERE store_id IN (${placeholders})`, ghostIds);
  const { rowCount: delPlans } = await pool.query(`DELETE FROM plans WHERE store_id IN (${placeholders})`, ghostIds);
  const { rowCount: delStores } = await pool.query(`DELETE FROM stores WHERE id IN (${placeholders})`, ghostIds);

  console.log(`\n✓ Удалено: ${delStores} магазинов, ${delSales} продаж, ${delPlans} планов`);

  await pool.end();
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  pool.end();
  process.exit(1);
});
