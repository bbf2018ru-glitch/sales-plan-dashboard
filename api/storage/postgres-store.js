const fs = require('fs');
const path = require('path');

const { normalizeDb, monthKey } = require('../lib/analytics');
const { normalizeUppPayload, validateNormalizedUppPayload } = require('../lib/upp');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'sql', 'init.sql');
const SAMPLE_PATH = path.join(__dirname, '..', '..', 'data', 'sample-db.json');

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

    // Seed sample data on first run (when no stores exist)
    const existing = await this.pool.query('select count(*)::int as cnt from stores');
    if (existing.rows[0].cnt === 0) {
      try {
        const sample = JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'));
        await this._seedSample(sample);
      } catch (_) { /* non-fatal: seed failure should not break startup */ }
    }
  }

  async _seedSample(sample) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const s of (sample.stores || [])) {
        await client.query(
          `insert into stores (id, name, region) values ($1, $2, $3) on conflict (id) do nothing`,
          [s.id, s.name, s.region || '']
        );
      }
      for (const p of (sample.products || [])) {
        await client.query(
          `insert into products (id, name, category) values ($1, $2, $3) on conflict (id) do nothing`,
          [p.id, p.name, p.category || '']
        );
      }
      for (const r of (sample.plans || [])) {
        await client.query(
          `insert into plans (period, store_id, product_id, amount) values ($1, $2, $3, $4) on conflict (period, store_id, product_id) do nothing`,
          [r.period, r.storeId, r.productId, r.amount || 0]
        );
      }
      for (const r of (sample.sales || [])) {
        await client.query(
          `insert into sales (period, store_id, product_id, amount, cost, quantity, sold_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [r.period, r.storeId, r.productId, r.amount || 0, r.cost || 0, r.quantity || 0, r.soldAt || new Date().toISOString()]
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
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

  async ingestUppPayload(payload) {
    await this.init();
    const normalized = normalizeUppPayload(payload);
    validateNormalizedUppPayload(normalized);
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      const duplicateCheck = await client.query(
        `select id, status from ingest_runs
         where package_id = $1 or payload_hash = $2
         order by created_at desc
         limit 1`,
        [normalized.packageId, normalized.payloadHash]
      );

      if (duplicateCheck.rows[0]) {
        const duplicateRun = await client.query(
          `insert into ingest_runs (
             package_id, payload_hash, source_system, source_object, period, status, stats_json
           ) values ($1, $2, $3, $4, $5, $6, $7)
           returning id, package_id as "packageId", payload_hash as "payloadHash", source_system as "sourceSystem",
                     source_object as "sourceObject", period, status, stats_json as stats, created_at as "createdAt"`,
          [
            normalized.packageId,
            normalized.payloadHash,
            normalized.sourceSystem,
            normalized.sourceObject,
            normalized.period,
            'duplicate',
            JSON.stringify(normalized.stats)
          ]
        );
        await client.query('commit');
        return duplicateRun.rows[0];
      }

      await client.query(
        `insert into raw_upp_payloads (package_id, payload_hash, source_system, source_object, period, payload_json)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          normalized.packageId,
          normalized.payloadHash,
          normalized.sourceSystem,
          normalized.sourceObject,
          normalized.period,
          JSON.stringify(normalized.raw)
        ]
      );

      for (const store of normalized.stores) {
        await client.query(
          `insert into stores (id, name, region)
           values ($1, $2, $3)
           on conflict (id) do update set
             name = excluded.name,
             region = excluded.region`,
          [store.id, store.name, store.region || '']
        );
      }

      for (const product of normalized.products) {
        await client.query(
          `insert into products (id, name, category)
           values ($1, $2, $3)
           on conflict (id) do update set
             name = excluded.name,
             category = excluded.category`,
          [product.id, product.name, product.category || '']
        );
      }

      await client.query('delete from plans where period = $1', [normalized.period]);
      for (const item of normalized.plans) {
        if (!item.storeId || !item.productId) continue;
        await client.query(
          `insert into plans (period, store_id, product_id, amount)
           values ($1, $2, $3, $4)`,
          [normalized.period, item.storeId, item.productId, item.amount]
        );
      }

      await client.query('delete from sales where period = $1', [normalized.period]);
      for (const item of normalized.sales) {
        if (!item.storeId || !item.productId) continue;
        await client.query(
          `insert into sales (period, store_id, product_id, amount, cost, quantity, sold_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [normalized.period, item.storeId, item.productId, item.amount, item.cost || 0, item.quantity || 0, item.soldAt]
        );
      }

      await client.query('delete from marketing_metrics where period = $1', [normalized.period]);
      for (const item of normalized.metrics) {
        if (!item.channelId) continue;
        await client.query(
          `insert into marketing_metrics (
             period, channel_id, channel_name, spend, leads, orders, revenue, impressions, clicks, sessions
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            normalized.period,
            item.channelId,
            item.channelName,
            item.spend || 0,
            item.leads || 0,
            item.orders || 0,
            item.revenue || 0,
            item.impressions || 0,
            item.clicks || 0,
            item.sessions || 0
          ]
        );
      }

      const run = await client.query(
        `insert into ingest_runs (
           package_id, payload_hash, source_system, source_object, period, status, stats_json
         ) values ($1, $2, $3, $4, $5, $6, $7)
         returning id, package_id as "packageId", payload_hash as "payloadHash", source_system as "sourceSystem",
                   source_object as "sourceObject", period, status, stats_json as stats, created_at as "createdAt"`,
        [
          normalized.packageId,
          normalized.payloadHash,
          normalized.sourceSystem,
          normalized.sourceObject,
          normalized.period,
          'success',
          JSON.stringify(normalized.stats)
        ]
      );

      await client.query('commit');
      return run.rows[0];
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async listIngestRuns(limit = 20) {
    await this.init();
    const result = await this.pool.query(
      `select id, package_id as "packageId", payload_hash as "payloadHash", source_system as "sourceSystem",
              source_object as "sourceObject", period, status, stats_json as stats, error_text as error, created_at as "createdAt"
       from ingest_runs
       order by created_at desc
       limit $1`,
      [limit]
    );
    return result.rows;
  }

  async getComments(period) {
    await this.init();
    const q = period
      ? `select id::text, period, text, author, created_at as "createdAt"
         from comments where period = $1 order by created_at desc`
      : `select id::text, period, text, author, created_at as "createdAt"
         from comments order by created_at desc`;
    const result = await this.pool.query(q, period ? [period] : []);
    return result.rows;
  }

  async addComment(period, text, author) {
    await this.init();
    const result = await this.pool.query(
      `insert into comments (period, text, author) values ($1, $2, $3)
       returning id::text, period, text, author, created_at as "createdAt"`,
      [String(period), String(text).slice(0, 2000), String(author || 'Менеджер').slice(0, 100)]
    );
    return result.rows[0];
  }

  async deleteComment(id) {
    await this.init();
    const result = await this.pool.query('delete from comments where id::text = $1', [id]);
    return (result.rowCount || 0) > 0;
  }

  async editPlanItem(period, storeId, productId, amount) {
    await this.init();
    await this.pool.query(
      `insert into plans (period, store_id, product_id, amount)
       values ($1, $2, $3, $4)
       on conflict (period, store_id, product_id) do update set amount = excluded.amount`,
      [period, storeId, productId, Number(amount)]
    );
    return { period, storeId, productId, amount: Number(amount) };
  }

  async recordIngestFailure(payload, error) {
    await this.init();
    const normalized = normalizeUppPayload(payload || {});
    const result = await this.pool.query(
      `insert into ingest_runs (
         package_id, payload_hash, source_system, source_object, period, status, stats_json, error_text
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, package_id as "packageId", payload_hash as "payloadHash", source_system as "sourceSystem",
                 source_object as "sourceObject", period, status, stats_json as stats, error_text as error, created_at as "createdAt"`,
      [
        normalized.packageId,
        normalized.payloadHash,
        normalized.sourceSystem,
        normalized.sourceObject,
        normalized.period,
        'failed',
        JSON.stringify(normalized.stats),
        error.message || String(error)
      ]
    );
    return result.rows[0];
  }
}

module.exports = {
  PostgresStore
};
