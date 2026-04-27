const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  normalizeDb,
  replacePlans,
  appendSales,
  replaceMarketing
} = require('../lib/analytics');
const { normalizeUppPayload, validateNormalizedUppPayload } = require('../lib/upp');

class JsonStore {
  constructor(options) {
    this.dbPath = options.dbPath;
    this.sampleDbPath = options.sampleDbPath;
  }

  async init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.dbPath)) {
      fs.copyFileSync(this.sampleDbPath, this.dbPath);
    }
  }

  async getDb() {
    await this.init();
    return normalizeDb(JSON.parse(fs.readFileSync(this.dbPath, 'utf8')));
  }

  async saveDb(db) {
    await this.init();
    fs.writeFileSync(this.dbPath, JSON.stringify(normalizeDb(db), null, 2));
  }

  async replacePlans(body) {
    const db = await this.getDb();
    const period = replacePlans(db, body);
    await this.saveDb(db);
    return {
      period,
      count: db.plans.filter((item) => item.period === period).length
    };
  }

  async appendSales(body) {
    const db = await this.getDb();
    if (body.replace) {
      db.sales = db.sales.filter((item) => item.period !== body.period);
    }
    const period = appendSales(db, body);
    await this.saveDb(db);
    return {
      period,
      count: db.sales.filter((item) => item.period === period).length
    };
  }

  async replaceMarketing(body) {
    const db = await this.getDb();
    const period = replaceMarketing(db, body);
    await this.saveDb(db);
    return {
      period,
      count: db.marketing.filter((item) => item.period === period).length
    };
  }

  async ingestUppPayload(payload) {
    const normalized = normalizeUppPayload(payload);
    validateNormalizedUppPayload(normalized);
    const db = await this.getDb();
    const duplicated = db.ingestRuns.find(
      (item) => item.packageId === normalized.packageId || item.payloadHash === normalized.payloadHash
    );

    const runId = crypto.randomUUID();

    if (duplicated) {
      const duplicateRun = {
        id: runId,
        packageId: normalized.packageId,
        payloadHash: normalized.payloadHash,
        sourceSystem: normalized.sourceSystem,
        sourceObject: normalized.sourceObject,
        period: normalized.period,
        status: 'duplicate',
        stats: normalized.stats,
        createdAt: new Date().toISOString()
      };
      db.ingestRuns.unshift(duplicateRun);
      await this.saveDb(db);
      return duplicateRun;
    }

    replacePlans(db, {
      period: normalized.period,
      stores: normalized.stores,
      products: normalized.products,
      plans: normalized.plans
    });

    db.sales = db.sales.filter((item) => item.period !== normalized.period);
    appendSales(db, {
      period: normalized.period,
      stores: normalized.stores,
      products: normalized.products,
      sales: normalized.sales,
      replace: true
    });

    replaceMarketing(db, {
      period: normalized.period,
      metrics: normalized.metrics
    });

    db.rawUppPayloads.unshift({
      id: runId,
      packageId: normalized.packageId,
      period: normalized.period,
      sourceSystem: normalized.sourceSystem,
      sourceObject: normalized.sourceObject,
      payload: normalized.raw,
      createdAt: new Date().toISOString()
    });

    const run = {
      id: runId,
      packageId: normalized.packageId,
      payloadHash: normalized.payloadHash,
      sourceSystem: normalized.sourceSystem,
      sourceObject: normalized.sourceObject,
      period: normalized.period,
      status: 'success',
      stats: normalized.stats,
      createdAt: new Date().toISOString()
    };

    db.ingestRuns.unshift(run);
    await this.saveDb(db);
    return run;
  }

  async listIngestRuns(limit = 20) {
    const db = await this.getDb();
    return db.ingestRuns.slice(0, limit);
  }

  async getComments(period) {
    const db = await this.getDb();
    const all = db.comments || [];
    return period ? all.filter(c => c.period === period) : all;
  }

  async addComment(period, text, author) {
    const db = await this.getDb();
    if (!Array.isArray(db.comments)) db.comments = [];
    const comment = {
      id: crypto.randomUUID(),
      period: String(period),
      text: String(text).slice(0, 2000),
      author: String(author || 'Менеджер').slice(0, 100),
      createdAt: new Date().toISOString()
    };
    db.comments.unshift(comment);
    await this.saveDb(db);
    return comment;
  }

  async deleteComment(id) {
    const db = await this.getDb();
    const before = (db.comments || []).length;
    db.comments = (db.comments || []).filter(c => c.id !== id);
    const deleted = before !== (db.comments || []).length;
    if (deleted) await this.saveDb(db);
    return deleted;
  }

  async editPlanItem(period, storeId, productId, amount) {
    const db = await this.getDb();
    const idx = db.plans.findIndex(
      p => p.period === period && p.storeId === storeId && p.productId === productId
    );
    if (idx >= 0) {
      db.plans[idx].amount = Number(amount);
    } else {
      db.plans.push({ period, storeId: String(storeId), productId: String(productId), amount: Number(amount) });
    }
    await this.saveDb(db);
    return { period, storeId, productId, amount: Number(amount) };
  }

  async recordIngestFailure(payload, error) {
    const db = await this.getDb();
    const normalized = normalizeUppPayload(payload || {});
    const run = {
      id: crypto.randomUUID(),
      packageId: normalized.packageId,
      payloadHash: normalized.payloadHash,
      sourceSystem: normalized.sourceSystem,
      sourceObject: normalized.sourceObject,
      period: normalized.period,
      status: 'failed',
      stats: normalized.stats,
      error: error.message || String(error),
      createdAt: new Date().toISOString()
    };

    db.ingestRuns.unshift(run);
    await this.saveDb(db);
    return run;
  }
}

module.exports = {
  JsonStore
};
