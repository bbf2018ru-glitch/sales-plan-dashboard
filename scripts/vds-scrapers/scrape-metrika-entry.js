// Переходы по SMS-ссылкам: Метрика (визиты /for_clients/?clckid=) + резолв clck.ru/код→clckid
// реальным браузером (сервер ловит капчу, браузер — нет). Пишет sms-clicks.json:
//   { byClckid:{id:визиты}, byCode:{код:визиты}, codeToClckid:{код:id}, period, total }.
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const OUT = '/opt/marketing-data/sms-clicks.json';
const COUNTER = '43949414';
const AUTH = 'Basic ' + Buffer.from('web:web').toString('base64');
function parseN(s){ const n=parseInt(String(s||'').replace(/[\s ]/g,''),10); return isFinite(n)?n:0; }

// Тексты маркетинг-рассылок за 45 дней из 1С (для извлечения clck-кодов).
function smsTexts(){
  const d=new Date(Date.now()-45*86400000);
  const q='ВЫБРАТЬ РАЗЛИЧНЫЕ ВЫРАЗИТЬ(П.ТекстПисьма КАК СТРОКА(300)) КАК Текст ИЗ Документ.SMSСообщение КАК П'
    +` ГДЕ П.Дата >= ДАТАВРЕМЯ(${d.getFullYear()},${d.getMonth()+1},${d.getDate()})`;
  const body=Buffer.from(q,'utf8');
  return new Promise((resolve)=>{
    const req=http.request({hostname:'89.108.119.147',path:'/f_base_2023/hs/dashboard/query_post',method:'POST',
      headers:{Authorization:AUTH,'Content-Type':'text/plain; charset=utf-8','Content-Length':body.length},timeout:60000},
      (res)=>{let s='';res.on('data',c=>s+=c);res.on('end',()=>{try{resolve(JSON.parse(s).rows||[]);}catch(e){resolve([]);}});});
    req.on('error',()=>resolve([])); req.on('timeout',()=>{req.destroy();resolve([]);});
    req.write(body); req.end();
  });
}

(async () => {
  const out = { scrapedAt:new Date().toISOString(), source:'metrika-entry-clckid', counter:COUNTER, byClckid:{}, byCode:{}, codeToClckid:{}, codeToUrl:{} };
  const b = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--lang=ru-RU'] });
  const ctx = await b.newContext({ storageState:'/opt/2gis-scraper/yandex-state.json', locale:'ru-RU', viewport:{width:1600,height:2000},
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' });
  const p = await ctx.newPage();
  try { await p.goto('https://metrika.yandex.ru/list',{waitUntil:'domcontentloaded',timeout:45000}); await p.waitForTimeout(4000); } catch(e){ out.prewarmError=e.message; }
  if (/passport\.yandex/.test(p.url())) { out.sessionExpired=true; fs.writeFileSync(OUT,JSON.stringify(out,null,2)); console.log('SESSION EXPIRED'); await b.close(); return; }

  // 1) Метрика: страницы входа → byClckid
  const URL='https://metrika.yandex.ru/stat/new?id='+COUNTER+'&period=month&group=day'
    +'&selectedDimensionKeys='+encodeURIComponent('[["ym:s:startURLPathFull"]]')
    +'&tableMetrics='+encodeURIComponent('[["ym:s:users"],["ym:s:visits"]]')
    +'&view=Linear&chartView=Line&table=visits&attr=%7B%22attributionId%22%3A%22LastSign%22%2C%22isCrossDevice%22%3Atrue%7D'
    +'&sortBy=-ym%3As%3Avisits&showTotal=true&isMinSamplingEnabled=false&currency=RUB&metricValueMode=Absolute&screenMode=Default';
  try { await p.goto(URL,{waitUntil:'domcontentloaded',timeout:60000}); } catch(e){ out.error='goto:'+e.message; }
  try { await p.waitForFunction(()=>{const t=(document.body&&document.body.innerText)||'';return /Итого и средние|Нет данных/i.test(t)&&t.length>700;},{timeout:55000}); } catch(_){ out.gridTimeout=true; }
  for(let i=0;i<8;i++){ await p.evaluate(()=>window.scrollBy(0,700)).catch(()=>{}); await p.waitForTimeout(400); }
  await p.waitForTimeout(1500);
  const body=(await p.evaluate(()=>document.body?document.body.innerText:''))||'';
  out.period=(body.match(/\d{1,2}\s+\S+\s+—\s+\d{1,2}\s+\S+/)||[null])[0];
  const lines=body.split('\n').map(s=>s.trim()).filter(Boolean);
  const isPct=s=>/^\d[\d\s ,]*%$/.test(String(s||'').trim());
  // Берём ТОЛЬКО строку таблицы (после значения идёт процент) → без задвоения с графиком.
  // Метрики: 1-я = Посетители (люди), 2-я = Визиты. Overwrite по clckid (не суммируем).
  for(let i=0;i<lines.length;i++){
    const m=/clckid=([a-z0-9]+)/i.exec(lines[i]);
    if(m && isPct(lines[i+2])){
      const users=parseN(lines[i+1]), visits=parseN(lines[i+3]);
      if(users>0||visits>0) out.byClckid[m[1]]={users, visits};
    }
  }
  out.totalUsers=Object.keys(out.byClckid).reduce((s,k)=>s+(out.byClckid[k].users||0),0);

  // 2) Коды clck.ru из текстов 1С → резолв браузером → clckid → клики
  const rows = await smsTexts();
  const codes = new Set();
  rows.forEach(r=>{ const mm=String(r.Текст||'').match(/clck\.ru\/([a-z0-9]+)/ig)||[]; mm.forEach(x=>{ const c=x.split('/')[1]; if(c) codes.add(c); }); });
  out.codesFound = codes.size;
  for (const code of codes) {
    try {
      await p.goto('https://clck.ru/'+code, { waitUntil:'domcontentloaded', timeout:25000 });
      await p.waitForTimeout(3500);
      const fin=p.url();
      // Путь назначения: явно ловим /for_clients/ (Сладкий чек), иначе — путь из URL.
      out.codeToUrl[code] = /for_clients/i.test(fin) ? '/for_clients/' : ((fin.match(/https?:\/\/[^\/]+(\/[^?#]*)/)||[null,''])[1]);
      const m=/clckid=([a-z0-9]+)/i.exec(fin);
      if (m) { out.codeToClckid[code]=m[1]; const cc=out.byClckid[m[1]]; out.byCode[code]=cc?(cc.users||0):0; out.byCodeVisits=out.byCodeVisits||{}; out.byCodeVisits[code]=cc?(cc.visits||0):0; }
    } catch(_){}
  }

  fs.writeFileSync(OUT, JSON.stringify(out,null,2));
  console.log(JSON.stringify({ totalUsers:out.totalUsers, clckids:Object.keys(out.byClckid).length, codesFound:out.codesFound, byCode:out.byCode, byCodeVisits:out.byCodeVisits, period:out.period }, null, 2));
  await b.close();
})().catch(e=>console.log('ERR', e.message));
