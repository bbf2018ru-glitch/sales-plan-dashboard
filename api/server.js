const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadProjectEnv } = require('./lib/load-env');
const {
  aggregateDashboard,
  aggregateMarketing,
  buildMarketingAnalysis,
  listPeriods,
  monthKey,
  storeDetails
} = require('./lib/analytics');
const { createStore } = require('./storage');

loadProjectEnv();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.INGEST_API_KEY || '85307b26064e3764b0b19ce3223353057b0fe754b31f0f3a';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');
const SAMPLE_DB_PATH = path.join(__dirname, '..', 'data', 'sample-db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const WEB_DIR = path.join(__dirname, '..', 'web');

const store = createStore({
  databaseUrl: DATABASE_URL,
  dbPath: DB_PATH,
  sampleDbPath: SAMPLE_DB_PATH
});

const clients = new Set();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
  });
  res.end(JSON.stringify(payload));
}

function sendEvent(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function requireApiKey(req, res) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    sendJson(res, 401, { error: 'Invalid API key' });
    return false;
  }
  return true;
}

function serveStatic(res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(WEB_DIR, safePath));
  if (!filePath.startsWith(WEB_DIR)) {
    notFound(res);
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(WEB_DIR, 'index.html'), (fallbackError, fallbackContent) => {
        if (fallbackError) {
          notFound(res);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallbackContent);
      });
      return;
    }

    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathname = parsedUrl.pathname || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
    });
    res.end();
    return;
  }

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      const db = await store.getDb();
      const ingestRuns = await store.listIngestRuns(1);
      sendJson(res, 200, {
        status: 'ok',
        storage: DATABASE_URL ? 'postgres' : 'json',
        periods: listPeriods(db),
        stores: db.stores.length,
        products: db.products.length,
        marketingRows: db.marketing.length,
        lastIngestRun: ingestRuns[0] || null
      });
      return;
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write('\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (pathname === '/api/dashboard/summary' && req.method === 'GET') {
      const db = await store.getDb();
      const period = monthKey(parsedUrl.searchParams.get('period'));
      sendJson(res, 200, aggregateDashboard(db, period));
      return;
    }

    if (pathname === '/api/dashboard/store' && req.method === 'GET') {
      const db = await store.getDb();
      const period = monthKey(parsedUrl.searchParams.get('period'));
      const storeId = String(parsedUrl.searchParams.get('storeId') || '');
      if (!storeId) {
        sendJson(res, 400, { error: 'storeId is required' });
        return;
      }
      sendJson(res, 200, storeDetails(db, period, storeId));
      return;
    }

    if (pathname === '/api/dashboard/marketing' && req.method === 'GET') {
      const db = await store.getDb();
      const period = monthKey(parsedUrl.searchParams.get('period'));
      sendJson(res, 200, aggregateMarketing(db, period));
      return;
    }

    if (pathname === '/api/analysis/marketing' && req.method === 'POST') {
      const body = await parseBody(req);
      const db = await store.getDb();
      const period = monthKey(body.period || parsedUrl.searchParams.get('period'));
      sendJson(res, 200, buildMarketingAnalysis(db, period));
      return;
    }

    if (pathname === '/api/metadata' && req.method === 'GET') {
      const db = await store.getDb();
      sendJson(res, 200, {
        periods: listPeriods(db),
        stores: db.stores,
        products: db.products
      });
      return;
    }

    if (pathname === '/api/ingest/runs' && req.method === 'GET') {
      const limit = Number(parsedUrl.searchParams.get('limit') || 20);
      const runs = await store.listIngestRuns(Math.min(Math.max(limit, 1), 100));
      sendJson(res, 200, { runs });
      return;
    }

    if (pathname === '/api/ingest/plans' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      const body = await parseBody(req);
      const { period, count } = await store.replacePlans(body);
      const db = await store.getDb();
      const summary = aggregateDashboard(db, period);
      sendEvent('plans_updated', { period, totals: summary.totals });
      sendJson(res, 200, {
        ok: true,
        period,
        plansCount: count
      });
      return;
    }

    if (pathname === '/api/ingest/sales' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      const body = await parseBody(req);
      const { period, count } = await store.appendSales(body);
      const db = await store.getDb();
      const summary = aggregateDashboard(db, period);
      sendEvent('sales_updated', { period, totals: summary.totals });
      sendJson(res, 200, {
        ok: true,
        period,
        salesCount: count
      });
      return;
    }

    if (pathname === '/api/ingest/marketing' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      const body = await parseBody(req);
      const { period, count } = await store.replaceMarketing(body);
      const db = await store.getDb();
      const marketing = aggregateMarketing(db, period);
      sendEvent('marketing_updated', { period, totals: marketing.totals });
      sendJson(res, 200, {
        ok: true,
        period,
        metricsCount: count
      });
      return;
    }

    if (pathname === '/api/ingest/upp' && req.method === 'POST') {
      if (!requireApiKey(req, res)) return;
      const body = await parseBody(req);
      try {
        const run = await store.ingestUppPayload(body);
        const db = await store.getDb();
        const summary = aggregateDashboard(db, run.period);
        const marketing = aggregateMarketing(db, run.period);
        sendEvent('plans_updated', { period: run.period, totals: summary.totals });
        sendEvent('sales_updated', { period: run.period, totals: summary.totals });
        sendEvent('marketing_updated', { period: run.period, totals: marketing.totals });
        sendJson(res, 200, {
          ok: true,
          run
        });
      } catch (error) {
        const failedRun = await store.recordIngestFailure(body, error);
        sendJson(res, 500, {
          error: error.message || 'UPP import failed',
          run: failedRun
        });
      }
      return;
    }

    serveStatic(res, pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
});

server.listen(PORT, async () => {
  await store.init();
  console.log(`Sales Plan Dashboard running at http://localhost:${PORT}`);
  console.log(`Storage: ${DATABASE_URL ? 'PostgreSQL' : 'JSON file'}`);
});
