#!/usr/bin/env node
/*
 * Генератор исторических данных для тренда.
 * Генерирует планы, продажи и маркетинг за 2025 (+ дополняет 2026).
 * Запуск: node scripts/generate-history.js
 */

const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = path.join(__dirname, '..', 'data', 'sample-db.json');
const SEED = 20260128;

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

const PRODUCT_PROFILE = {
  coffee:    { unitPrice: 295,  costShare: 0.30 },
  torty:     { unitPrice: 3450, costShare: 0.50 },
  pirozhnie: { unitPrice: 162,  costShare: 0.30 },
  bento:     { unitPrice: 1000, costShare: 0.50 },
  napitki:   { unitPrice: 220,  costShare: 0.35 },
  dobavki:   { unitPrice: 80,   costShare: 0.25 },
  '_total':  { unitPrice: 450,  costShare: 0.38 }
};

const STORE_PERFORMANCE = {
  'angarsk-18':    1.02, 'dekabr':       0.98, 'deputatskaya': 1.05,
  'konditerskaya': 1.08, 'lermontova':   1.01, 'nizhnyaya':    0.96,
  'premier':       0.78, 'pushkina':     1.03, 'rzhanova':     0.94,
  'sezon':         1.15, 'solnechny':    1.06, 'solnce-dc':    0.93,
  'soyuz':         1.07, 'cimlyanskaya': 1.02, 'energetikov':  0.97,
  'yubileynyy':    1.04, 'yadrintseva':  1.10
};

// Сезонные коэффициенты по месяцам (0.XX = ниже нормы, 1.XX = выше)
// Кондитерская: мартовский пик (8 Марта), декабрьский пик (НГ), летний спад
const SEASON_2025 = {
  '2025-01': 0.82, // после НГ — спад
  '2025-02': 0.90, // 14 февраля, небольшой рост
  '2025-03': 1.15, // 8 Марта — пик тортов
  '2025-04': 0.98,
  '2025-05': 1.05, // майские праздники
  '2025-06': 0.93,
  '2025-07': 0.86, // летний спад, отпуска
  '2025-08': 0.89,
  '2025-09': 1.00, // сентябрь — возврат активности
  '2025-10': 1.03,
  '2025-11': 1.07, // корпоративный сезон
  '2025-12': 1.28  // Новый год — пик
};

const SEASON_2026 = {
  '2026-01': 0.88,
  '2026-02': 0.95,
  '2026-03': 1.06,
  '2026-04': 1.02
};

// Последний день каждого месяца
const LAST_DAY = {
  '01': '31', '02': '28', '03': '31', '04': '30',
  '05': '31', '06': '30', '07': '31', '08': '31',
  '09': '30', '10': '31', '11': '30', '12': '31'
};

// 2025 рос относительно 2024, а 2026 ~8% выше 2025
const YOY_GROWTH = 0.908; // базовые планы 2025 = планы 2026-апрель * этот коэф

function generatePlans2025(basePlans) {
  // базовые планы берём из 2026-04 (самые свежие), корректируем на сезон
  const base2026Apr = basePlans.filter(p => p.period === '2026-04');
  const aprilSeason = SEASON_2026['2026-04'];
  const newPlans = [];
  for (const [period, season] of Object.entries(SEASON_2025)) {
    for (const bp of base2026Apr) {
      const amount = Math.round(bp.amount * YOY_GROWTH * (season / aprilSeason) * (1 + between(-0.04, 0.04)));
      newPlans.push({
        period,
        storeId: bp.storeId,
        productId: bp.productId,
        amount
      });
    }
  }
  return newPlans;
}

function generateSales(plans, seasonMap) {
  const sales = [];
  for (const p of plans) {
    const season = seasonMap[p.period];
    if (season === undefined) continue;
    const profile = PRODUCT_PROFILE[p.productId] || PRODUCT_PROFILE.coffee;
    const storeMul = STORE_PERFORMANCE[p.storeId] ?? 1.0;
    const exec = 0.95 * storeMul * season + between(-0.07, 0.07);
    const amount = Math.round(p.amount * exec);
    const cost = Math.round(amount * (profile.costShare + between(-0.03, 0.03)));
    const quantity = Math.round(amount / profile.unitPrice);
    const mm = p.period.slice(5, 7);
    sales.push({
      period: p.period,
      storeId: p.storeId,
      productId: p.productId,
      amount,
      cost,
      quantity,
      soldAt: `${p.period}-${LAST_DAY[mm]}T18:00:00+08:00`
    });
  }
  return sales;
}

function generateMarketing(periods, periodMulMap) {
  const channels = [
    { id: 'yandex-direct',  name: 'Яндекс Директ',   baseSpend: 75000, conv: 0.026, cpm: 180, ctr: 0.024 },
    { id: 'vk-ads',         name: 'VK Реклама',       baseSpend: 45000, conv: 0.018, cpm: 95,  ctr: 0.018 },
    { id: 'telegram-ads',   name: 'Telegram Ads',     baseSpend: 28000, conv: 0.022, cpm: 220, ctr: 0.030 },
    { id: '2gis-promo',     name: '2ГИС Промо',       baseSpend: 18000, conv: 0.045, cpm: 60,  ctr: 0.012 }
  ];
  const result = [];
  for (const period of periods) {
    const mul = periodMulMap[period] ?? 1.0;
    for (const ch of channels) {
      const m = mul * (1 + between(-0.08, 0.08));
      const spend = Math.round(ch.baseSpend * m);
      const impressions = Math.round((spend / ch.cpm) * 1000);
      const clicks = Math.round(impressions * ch.ctr * (1 + between(-0.1, 0.1)));
      const sessions = Math.round(clicks * (0.82 + between(-0.05, 0.05)));
      const leads = Math.round(sessions * ch.conv * 4 * (1 + between(-0.15, 0.15)));
      const orders = Math.round(leads * (0.26 + between(-0.05, 0.05)));
      const avgCheck = ch.id === '2gis-promo' ? 1450 : ch.id === 'telegram-ads' ? 1850 : 2200;
      const revenue = Math.round(orders * avgCheck * (1 + between(-0.1, 0.1)));
      result.push({
        period, channelId: ch.id, channelName: ch.name,
        spend, leads, orders, revenue, impressions, clicks, sessions
      });
    }
  }
  return result;
}

function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

  // --- Планы 2025 ---
  const existingPlanKeys = new Set(db.plans.map(p => `${p.period}|${p.storeId}|${p.productId}`));
  const newPlans = generatePlans2025(db.plans).filter(
    p => !existingPlanKeys.has(`${p.period}|${p.storeId}|${p.productId}`)
  );
  db.plans = [...newPlans, ...db.plans].sort((a, b) => a.period.localeCompare(b.period));

  // --- Продажи 2025 + 2026 ---
  const allPlans = db.plans;
  const seasonAll = { ...SEASON_2025, ...SEASON_2026 };
  const existingSalesKeys = new Set(db.sales.map(s => `${s.period}|${s.storeId}|${s.productId}`));
  const newSales = generateSales(allPlans, seasonAll).filter(
    s => !existingSalesKeys.has(`${s.period}|${s.storeId}|${s.productId}`)
  );
  db.sales = [...db.sales, ...newSales].sort((a, b) => a.period.localeCompare(b.period));

  // --- Маркетинг 2025 + 2026 ---
  // маркетинговые бюджеты 2025 чуть ниже (компания только наращивала диджитал)
  const marketingMul = {};
  for (const [p, s] of Object.entries(SEASON_2025)) marketingMul[p] = s * 0.78;
  for (const [p, s] of Object.entries(SEASON_2026)) marketingMul[p] = s * 1.0;

  const allPeriods = [...Object.keys(SEASON_2025), ...Object.keys(SEASON_2026)].sort();
  db.marketing = generateMarketing(allPeriods, marketingMul);

  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n', 'utf8');

  // --- Сводка ---
  const plansByPeriod = {};
  const salesByPeriod = {};
  for (const p of db.plans) plansByPeriod[p.period] = (plansByPeriod[p.period] || 0) + p.amount;
  for (const s of db.sales) salesByPeriod[s.period] = (salesByPeriod[s.period] || 0) + s.amount;

  console.log('\n=== Итог генерации ===');
  console.log(`Планов всего: ${db.plans.length} | Продаж: ${db.sales.length} | Маркетинг: ${db.marketing.length}`);
  console.log('\nПериод       | План, руб       | Факт, руб       | %');
  console.log('-------------|-----------------|-----------------|-----');
  for (const period of allPeriods) {
    const plan = plansByPeriod[period] || 0;
    const fact = salesByPeriod[period] || 0;
    const pct = plan ? ((fact / plan) * 100).toFixed(1) : '—';
    console.log(`${period}  | ${String(plan).padStart(15)} | ${String(fact).padStart(15)} | ${pct}%`);
  }
}

main();
