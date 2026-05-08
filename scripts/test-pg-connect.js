const { Client } = require('pg');
const url = process.env.NEW_DATABASE_URL;
(async () => {
  const tries = [
    { name: 'ssl:true', opts: { connectionString: url, ssl: true } },
    { name: 'ssl:false', opts: { connectionString: url, ssl: false } },
    { name: 'ssl:rejectUnauth-false', opts: { connectionString: url, ssl: { rejectUnauthorized: false } } },
    { name: 'no-ssl', opts: { connectionString: url + '?sslmode=disable' } }
  ];
  for (const t of tries) {
    try {
      const c = new Client(t.opts);
      await c.connect();
      const r = await c.query('SELECT version()');
      console.log('✓', t.name, '·', r.rows[0].version.substring(0, 50));
      await c.end();
      return;
    } catch (e) {
      console.log('×', t.name, '·', e.message.substring(0, 80));
    }
  }
})();
