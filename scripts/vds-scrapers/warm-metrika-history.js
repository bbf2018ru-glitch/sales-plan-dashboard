// Прогон скрейпа Метрики по 17 месяцам (с янв пред.года по текущий).
// Запускается на VDS вручную или по cron (раз в неделю).
const { spawn } = require('child_process');

function* months() {
  const t = new Date();
  const ey = t.getUTCFullYear();
  const em = t.getUTCMonth() + 1;
  // Стартуем с янв предыдущего года
  for (let yy = ey - 1; yy <= ey; yy++) {
    const lastM = yy === ey ? em : 12;
    for (let mm = 1; mm <= lastM; mm++) {
      yield `${yy}-${String(mm).padStart(2, '0')}`;
    }
  }
}

(async () => {
  const list = Array.from(months());
  console.log('[warm-metrika] start', list.length, 'months');
  let ok = 0, fail = 0;
  for (const ym of list) {
    await new Promise(resolve => {
      const c = spawn('node', ['/opt/2gis-scraper/scrape-metrika.js'], {
        env: { ...process.env, METRIKA_PERIOD: ym },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let buf = '';
      c.stdout.on('data', d => buf += d);
      c.stderr.on('data', d => buf += d);
      c.on('close', code => {
        if (code === 0 && /"ok":true/.test(buf) && !/sessionExpired":true/.test(buf)) { ok++; console.log('  ✓', ym, (buf.match(/"totalVisits":(\d+)/) || [, '?'])[1], 'visits'); }
        else { fail++; console.log('  ✗', ym, buf.slice(0, 200)); }
        resolve();
      });
    });
    // не бомбардируем Метрику
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('[warm-metrika] done: ok=' + ok + ' fail=' + fail);
})();
