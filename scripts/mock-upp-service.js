// Заглушка HTTP-сервиса 1С УПП для локального тестирования pull-режима.
// Запуск: node scripts/mock-upp-service.js [port]
const http = require('node:http');

const PORT = Number(process.argv[2] || 8765);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const period = url.searchParams.get('period') || '2026-04';
  const pkg = {
    sourceSystem: '1c-upp',
    sourceObject: 'pull_mock',
    packageId: `mock-${period}-${Date.now()}`,
    period,
    stores: [
      { id: 'mock-store', name: 'Тестовая точка УПП-pull', region: 'Иркутск' }
    ],
    products: [
      { id: 'mock-product', name: 'Тестовый кофе', category: 'Кофе' }
    ],
    plans: [
      { storeId: 'mock-store', productId: 'mock-product', amount: 100000 }
    ],
    sales: [
      {
        storeId: 'mock-store',
        productId: 'mock-product',
        amount: 91500,
        cost: 27000,
        quantity: 310,
        soldAt: `${period}-15T12:00:00+08:00`
      }
    ],
    marketingMetrics: []
  };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(pkg));
});

server.listen(PORT, () => {
  console.log(`Mock UPP service: http://localhost:${PORT}/`);
});
