const crypto = require('crypto');

const { monthKey } = require('./analytics');

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

function asId(...values) {
  const value = firstDefined(...values);
  return value === '' ? '' : String(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildPayloadHash(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function mapStore(item) {
  const id = asId(item.id, item.storeId, item.code);
  return {
    id,
    name: item.name || item.storeName || id,
    region: item.region || item.city || ''
  };
}

function mapProduct(item) {
  const id = asId(item.id, item.productId, item.code, item.sku);
  return {
    id,
    name: item.name || item.productName || id,
    category: item.category || item.group || ''
  };
}

function normalizeUppPayload(payload) {
  const meta = payload.meta || {};
  const period = monthKey(payload.period || meta.period);
  const packageId = String(
    payload.packageId ||
    meta.packageId ||
    meta.exchangeId ||
    meta.documentId ||
    `${period}-${buildPayloadHash(payload).slice(0, 12)}`
  );
  const sourceSystem = payload.sourceSystem || meta.sourceSystem || '1c-upp';
  const sourceObject = payload.sourceObject || meta.sourceObject || 'sales_exchange';
  const stores = (payload.stores || payload.outlets || payload.shopDirectory || []).map(mapStore);
  const products = (payload.products || payload.items || payload.nomenclature || []).map(mapProduct);
  const plans = (payload.plans || payload.planRows || payload.salesPlans || []).map((item) => ({
    storeId: asId(item.storeId, item.store, item.storeCode),
    productId: asId(item.productId, item.product, item.productCode, item.sku),
    amount: Number(item.amount || item.planAmount || item.sum || 0)
  }));
  const sales = (payload.sales || payload.salesRows || payload.realizationRows || []).map((item) => ({
    storeId: asId(item.storeId, item.store, item.storeCode),
    productId: asId(item.productId, item.product, item.productCode, item.sku),
    amount: Number(item.amount || item.saleAmount || item.revenue || item.sum || 0),
    cost: Number(item.cost || item.costAmount || item.purchaseCost || 0),
    quantity: Number(item.quantity || item.qty || 0),
    soldAt: item.soldAt || item.date || item.datetime || new Date().toISOString()
  }));
  const metrics = (payload.marketing || payload.marketingMetrics || payload.campaigns || []).map((item) => ({
    channelId: asId(item.channelId, item.channel, item.source, item.code),
    channelName: item.channelName || item.name || asId(item.channelId, item.channel, item.source, item.code),
    spend: Number(item.spend || item.cost || 0),
    leads: Number(item.leads || 0),
    orders: Number(item.orders || 0),
    revenue: Number(item.revenue || item.amount || 0),
    impressions: Number(item.impressions || 0),
    clicks: Number(item.clicks || 0),
    sessions: Number(item.sessions || 0)
  }));

  return {
    packageId,
    payloadHash: buildPayloadHash(payload),
    sourceSystem,
    sourceObject,
    period,
    stores,
    products,
    plans,
    sales,
    metrics,
    raw: payload,
    stats: {
      stores: stores.length,
      products: products.length,
      plans: plans.length,
      sales: sales.length,
      marketing: metrics.length
    }
  };
}

function validateNormalizedUppPayload(normalized) {
  if (!normalized.period) {
    throw new Error('UPP payload must include period');
  }

  const hasPayloadData =
    normalized.plans.length ||
    normalized.sales.length ||
    normalized.metrics.length;

  if (!hasPayloadData) {
    throw new Error('UPP payload must include at least one of plans, sales or marketingMetrics');
  }

  for (const row of normalized.plans) {
    if (!row.storeId || !row.productId) {
      throw new Error('Each UPP plan row must include storeId and productId');
    }
  }

  for (const row of normalized.sales) {
    if (!row.storeId || !row.productId) {
      throw new Error('Each UPP sales row must include storeId and productId');
    }
  }

  for (const row of normalized.metrics) {
    if (!row.channelId) {
      throw new Error('Each UPP marketing row must include channelId');
    }
  }
}

module.exports = {
  normalizeUppPayload,
  validateNormalizedUppPayload
};
