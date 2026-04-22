const fs = require('fs');
const path = require('path');

const { normalizeDb, monthKey } = require('../lib/analytics');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'sql', 'init.sql');

class PostgresStore {
  constructor(options) {
    this.connectionString = options.connectionString;
    this.pool = null;
  }

  async init() {
    if (this.pool) {
      return;
    }

    let Pool;
    try {
      ({ Pool } = require('pg'));
    } catch (error) {
      throw new Error('Для PostgreSQL нужен пакет `pg`. Выполните `npm install` перед запуском с DATABASE_URL.');
    }

    this.pool = new Pool({
      connectionString: this.connectionString
    });

    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await this.pool.query(schema);
  }

  async getDb() {
    await this.init();

    const [stores, products, plans, sales, marketing] = await Promise.all([
      this.pool.query('select id, name, region from stores order by name'),
      this.pool.query('select id, name, category from products order by name'),
      this.pool.query('select period, store_id as "storeId", product_id as "productId", amount from plans'),
      this.pool.query('select period, store_id as "storeId", product_id as "productId", amount, cost, quantity, sold_at as "soldAt" from sales'),
      this.pool.query('select period, channel_id as "channelId", channel_name as "channelName", spend, leads, orders, revenue, impressions, clicks, sessions from marketing_metrics')
    ]);

    return normalizeDb({
      stores: stores.rows,
      products: products.rows,
      plans: plans.rows,
      sales: sales.rows,
      marketing: marketing.rows
    });
  }

  async replacePlans(body) {
    await this.init();
    const period = monthKey(body.period);
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      for (const store of Array.isArray(body.stores) ? body.stores : []) {
        await client.query(
          `insert into stores (id, name, region)
           values ($1, $2, $3)
           on conflict (id) do update set
             name = excluded.name,
             region = excluded.region`,
          [String(store.id), store.name || String(store.id), store.region || '']
        );
      }

      for (const product of Array.isArray(body.products) ? body.products : []) {
        await client.query(
          `insert into products (id, name, category)
           values ($1, $2, $3)
           on conflict (id) do update set
             name = excluded.name,
             category = excluded.category`,
          [String(product.id), product.name || String(product.id), product.category || '']
        );
      }

      await client.query('delete from plans where period = $1', [period]);

      for (const item of body.plans || []) {
        if (!item.storeId || !item.productId) {
          throw new Error('Each plan row must include storeId and productId');
        }
        await client.query(
          `insert into plans (period, store_id, product_id, amount)
           values ($1, $2, $3, $4)`,
          [period, String(item.storeId), String(item.productId), Number(item.amount || 0)]
        );
      }

      await client.query('commit');

      return {
        period,
        count: Array.isArray(body.plans) ? body.plans.length : 0
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async appendSales(body) {
    await this.init();
    const period = monthKey(body.period);
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      for (const store of Array.isArray(body.stores) ? body.stores : []) {
        await client.query(
          `insert into stores (id, name, region)
           values ($1, $2, $3)
           on conflict (id) do update set
             name = excluded.name,
             region = excluded.region`,
          [String(store.id), store.name || String(store.id), store.region || '']
        );
      }

      for (const product of Array.isArray(body.products) ? body.products : []) {
        await client.query(
          `insert into products (id, name, category)
           values ($1, $2, $3)
           on conflict (id) do update set
             name = excluded.name,
             category = excluded.category`,
          [String(product.id), product.name || String(product.id), product.category || '']
        );
      }

      if (body.replace) {
        await client.query('delete from sales where period = $1', [period]);
      }

      for (const item of body.sales || []) {
        if (!item.storeId || !item.productId) {
          throw new Error('Each sales row must include storeId and productId');
        }
        await client.query(
          `insert into sales (period, store_id, product_id, amount, cost, quantity, sold_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            period,
            String(item.storeId),
            String(item.productId),
            Number(item.amount || 0),
            Number(item.cost || 0),
            Number(item.quantity || 0),
            item.soldAt || new Date().toISOString()
          ]
        );
      }

      await client.query('commit');

      const countResult = await this.pool.query('select count(*)::int as count from sales where period = $1', [period]);
      return {
        period,
        count: countResult.rows[0].count
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceMarketing(body) {
    await this.init();
    const period = monthKey(body.period);
    const client = await this.pool.connect();

    try {
      await client.query('begin');
      await client.query('delete from marketing_metrics where period = $1', [period]);

      for (const item of body.metrics || []) {
        if (!item.channelId) {
          throw new Error('Each marketing row must include channelId');
        }
        await client.query(
          `insert into marketing_metrics (
             period, channel_id, channel_name, spend, leads, orders, revenue, impressions, clicks, sessions
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            period,
            String(item.channelId),
            item.channelName || String(item.channelId),
            Number(item.spend || 0),
            Number(item.leads || 0),
            Number(item.orders || 0),
            Number(item.revenue || 0),
            Number(item.impressions || 0),
            Number(item.clicks || 0),
            Number(item.sessions || 0)
          ]
        );
      }

      await client.query('commit');

      return {
        period,
        count: Array.isArray(body.metrics) ? body.metrics.length : 0
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = {
  PostgresStore
};
