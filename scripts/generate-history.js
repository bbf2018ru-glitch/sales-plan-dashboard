#!/usr/bin/env node
/*
 * Генератор исторических данных для тренда.
 * Берёт планы за 2026-01..03 из data/sample-db.json и генерирует sales + marketing.
 * Запуск: node scripts/generate-history.js
 */

const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = path.join(__dirname, '..', 'data', 'sample-db.json');
const SEED = 20260128;

// детерминированный PRNG (mulberry32)
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const between = (lo, hi) => lo + (hi - lo) * rand();

// средняя цена и доля себестоимости по категориям (выведено из sales 2026-04)
const PRODUCT_PROFILE = {
  coffee:    { unitPrice: 295,  costShare: 0.30 },
  torty:     { unitPrice: 3450, costShare: 0.50 },
  pirozhnie: { unitPrice: 162,  costShare: 0.30 },
  bento:     { unitPrice: 1000, costShare: 0.50 },
  napitki:   { unitPrice: 220,  costShare: 0.35 },
  dobavki:   { unitPrice: 80,   costShare: 0.25 }
};

// мультипликаторы выполнения плана по точкам — стабильный «характер» точки
const STORE_PERFORMANCE = {
  'angarsk-18':    1.02, 'dekabr':       0.98, 'deputatskaya': 1.05,
  'konditerskaya': 1.08, 'lermontova':   1.01, 'nizhnyaya':    0.96,
  'premier':       0.78, 'pushkina':     1.03, 'rzhanova':     0.94,
  'sezon':         1.15, 'solnechny':    1.06, 'solnce-dc':    0.93,
  'soyuz':         1.07, 'cimlyanskaya': 1.02, 'energetikov':  0.97,
  'yubileynyy':    1.04, 'yadrintseva':  1.10
};

// сезонный коэффициент по месяцу (2026-01 — после праздников провал, март — 8 марта рост)
const SEASON = {
  '2026-01': 0.88,
  '2026-02': 0.95,
  '2026-03': 1.06
};

// последний день месяца для soldAt
const LAST_DAY = { '2026-01': '31', '2026-02': '28', '2026-03': '31' };

function generateSales(plans) {
  const targets = plans.filter(p => SEASON[p.period] !== undefined);
  return targets.map(p => {
    const profile = PRODUCT_PROFILE[p.productId] || PRODUCT_PROFILE.coffee;
    const storeMul = STORE_PERFORMANCE[p.storeId] ?? 1.0;
    const seasonMul = SEASON[p.period];
    // % выполнения = база 0.95 * характер_точки * сезон + шум ±7%
    const exec = 0.95 * storeMul * seasonMul + between(-0.07, 0.07);
    const amount = Math.round(p.amount * exec);
    const cost = Math.round(amount * (profile.costShare + between(-0.03, 0.03)));
    const quantity = Math.round(amount / profile.unitPrice);
    return {
      period: p.period,
      storeId: p.storeId,
      productId: p.productId,
      amount,
      cost,
      quantity,
      soldAt: `${p.period}-${LAST_DAY[p.period]}T18:00:00+08:00`
    };
  });
}

// маркетинг: 4 канала за каждый период, бюджеты растут к апрелю
function generateMarketing() {
  const periods = ['2026-01', '2026-02', '2026-03', '2026-04'];
  const channels = [
    { id: 'yandex-direct',  name: 'Яндекс Директ',   baseSpend: 75000, conv: 0.026, cpm: 180, ctr: 0.024 },
    { id: 'vk-ads',         name: 'VK Реклама',       baseSpend: 45000, conv: 0.018, cpm: 95,  ctr: 0.018 },
    { id: 'telegram-ads',   name: 'Telegram Ads',     baseSpend: 28000, conv: 0.022, cpm: 220, ctr: 0.030 },
    { id: '2gis-promo',     name: '2ГИС Промо',       baseSpend: 18000, conv: 0.045, cpm: 60,  ctr: 0.012 }
  ];
  const periodMul = { '2026-01': 0.75, '2026-02': 0.85, '2026-03': 0.95, '2026-04': 1.05 };
  const result = [];
  for (const period of periods) {
    for (const ch of channels) {
      const mul = periodMul[period] * (1 + between(-0.08, 0.08));
      const spend = Math.round(ch.baseSpend * mul);
      const impressions = Math.round((spend / ch.cpm) * 1000);
      const clicks = Math.round(impressions * ch.ctr * (1 + between(-0.1, 0.1)));
      const sessions = Math.round(clicks * (0.82 + between(-0.05, 0.05)));
      const leads = Math.round(sessions * ch.conv * 4 * (1 + between(-0.15, 0.15)));
      const orders = Math.round(leads * (0.26 + between(-0.05, 0.05)));
      const avgCheck = ch.id === '2gis-promo' ? 1450 : ch.id === 'telegram-ads' ? 1850 : 2200;
      const revenue = Math.round(orders * avgCheck * (1 + between(-0.1, 0.1)));
      result.push({
        period,
        channelId: ch.id,
        channelName: ch.name,
        spend, leads, orders, revenue,
        impressions, clicks, sessions
      });
    }
  }
  return result;
}

function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const newSales = generateSales(db.plans);
  const existingSalesKeys = new Set(
    db.sales.map(s => `${s.period}|${s.storeId}|${s.productId}`)
  );
  const filteredNew = newSales.filter(
    s => !existingSalesKeys.has(`${s.period}|${s.storeId}|${s.productId}`)
  );
  db.sales = [...db.sales, ...filteredNew];
  db.marketing = generateMarketing();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n', 'utf8');
  console.log(`Добавлено ${filteredNew.length} sales-записей за исторические периоды`);
  console.log(`Сгенерировано ${db.marketing.length} marketing-записей за 4 периода`);
  // сводка
  const summary = {};
  for (const s of db.sales) {
    summary[s.period] = (summary[s.period] || 0) + s.amount;
  }
  console.log('Факт по периодам:', summary);
}

main();
