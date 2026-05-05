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
          `insert into stores (id, name, region, source) values ($1, $2, $3, $4) on conflict (id) do nothing`,
          [s.id, s.name, s.region || '', s.source || '']
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
          `insert into sales (period, store_id, product_id, amount, cost, gross_profit, quantity, sold_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [r.period, r.storeId, r.productId, r.amount || 0, r.cost || 0, r.grossProfit || 0, r.quantity || 0, r.soldAt || new Date().toISOString()]
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

    const [stores, products, plans, sales, users, userStores] = await Promise.all([
      this.pool.query('select id, name, region, source from stores order by name'),
      this.pool.query('select id, name, category from products order by name'),
      this.pool.query('select period, store_id as "storeId", product_id as "productId", amount from plans'),
      this.pool.query('select period, store_id as "storeId", product_id as "productId", amount, cost, gross_profit as "grossProfit", quantity, sold_at as "soldAt" from sales'),
      this.pool.query('select id, name, role, token from users').catch(() => ({ rows: [] })),
      this.pool.query('select user_id as "userId", store_id as "storeId" from user_stores').catch(() => ({ rows: [] }))
    ]);

    const userStoreMap = new Map();
    for (const row of userStores.rows) {
      if (!userStoreMap.has(row.userId)) userStoreMap.set(row.userId, []);
      userStoreMap.get(row.userId).push(row.storeId);
    }

    return normalizeDb({
      stores: stores.rows,
      products: products.rows,
      plans: plans.rows,
      sales: sales.rows,
      users: users.rows.map((u) => ({ ...u, stores: userStoreMap.get(u.id) || [] }))
    });
  }

  async listUsers() {
    const db = await this.getDb();
    return db.users || [];
  }

  async getUserByToken(token) {
    if (!token) return null;
    await this.init();
    const result = await this.pool.query('select id, name, role, token from users where token = $1', [token]);
    if (!result.rows.length) return null;
    const user = result.rows[0];
    const stores = await this.pool.query('select store_id from user_stores where user_id = $1', [user.id]);
    return { ...user, stores: stores.rows.map((r) => r.store_id) };
  }

  async upsertUser(user) {
    await this.init();
    const crypto = require('crypto');
    const record = {
      id: String(user.id),
      name: String(user.name || user.id),
      role: user.role === 'admin' ? 'admin' : 'manager',
      token: String(user.token || crypto.randomUUID()),
      stores: Array.isArray(user.stores) ? user.stores.map(String) : []
    };
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into users (id, name, role, token) values ($1, $2, $3, $4)
         on conflict (id) do update set name = excluded.name, role = excluded.role, token = excluded.token`,
        [record.id, record.name, record.role, record.token]
      );
      await client.query('delete from user_stores where user_id = $1', [record.id]);
      for (const sid of record.stores) {
        await client.query('insert into user_stores (user_id, store_id) values ($1, $2)', [record.id, sid]);
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    return record;
  }

  async deleteUser(id) {
    await this.init();
    const result = await this.pool.query('delete from users where id = $1', [id]);
    return result.rowCount > 0;
  }

  async replacePlans(body) {
    await this.init();
    const period = monthKey(body.period);
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      for (const store of Array.isArray(body.stores) ? body.stores : []) {
        await client.query(
          `insert into stores (id, name, region, source)
           values ($1, $2, $3, $4)
           on conflict (id) do update set
             name = excluded.name,
             region = excluded.region,
             source = case when excluded.source = '' then stores.source else excluded.source end`,
          [String(store.id), store.name || String(store.id), store.region || '', store.source || '']
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
          `insert into stores (id, name, region, source)
           values ($1, $2, $3, $4)
           on conflict (id) do update set
             name = excluded.name,
             region = excluded.region,
             source = case when excluded.source = '' then stores.source else excluded.source end`,
          [String(store.id), store.name || String(store.id), store.region || '', store.source || '']
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
          `insert into sales (period, store_id, product_id, amount, cost, gross_profit, quantity, sold_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            period,
            String(item.storeId),
            String(item.productId),
            Number(item.amount || 0),
            Number(item.cost || 0),
            Number(item.grossProfit || 0),
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
          `insert into stores (id, name, region, source)
           values ($1, $2, $3, $4)
           on conflict (id) do update set
             name = excluded.name,
             region = excluded.region,
             source = case when excluded.source = '' then stores.source else excluded.source end`,
          [store.id, store.name, store.region || '', store.source || '']
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
          `insert into sales (period, store_id, product_id, amount, cost, gross_profit, quantity, sold_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [normalized.period, item.storeId, item.productId, item.amount, item.cost || 0, item.grossProfit || 0, item.quantity || 0, item.soldAt]
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

  // ── 1С Diagnostic ──────────────────────────────────────────────────────────
  async saveUppDiagnostic({ configName, configVersion, payload }) {
    await this.init();
    const json = JSON.stringify(payload);
    const sizeBytes = Buffer.byteLength(json, 'utf8');
    const result = await this.pool.query(
      `insert into upp_diagnostic (config_name, config_version, size_bytes, payload)
       values ($1, $2, $3, $4::jsonb)
       returning id, received_at as "receivedAt", size_bytes as "sizeBytes"`,
      [configName || '', configVersion || '', sizeBytes, json]
    );
    // Trim — храним последние 10 снимков, более старые удаляем
    await this.pool.query(`
      delete from upp_diagnostic
      where id not in (select id from upp_diagnostic order by received_at desc limit 10)
    `);
    return result.rows[0];
  }

  async getLatestUppDiagnostic() {
    await this.init();
    const r = await this.pool.query(
      `select id, received_at as "receivedAt", config_name as "configName",
              config_version as "configVersion", size_bytes as "sizeBytes", payload
       from upp_diagnostic order by received_at desc limit 1`
    );
    return r.rows[0] || null;
  }

  async listUppDiagnostics() {
    await this.init();
    const r = await this.pool.query(
      `select id, received_at as "receivedAt", config_name as "configName",
              config_version as "configVersion", size_bytes as "sizeBytes"
       from upp_diagnostic order by received_at desc`
    );
    return r.rows;
  }
}

module.exports = {
  PostgresStore
};
