const fs = require('fs');
const path = require('path');

const {
  normalizeDb,
  replacePlans,
  appendSales,
  replaceMarketing
} = require('../lib/analytics');

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
}

module.exports = {
  JsonStore
};
