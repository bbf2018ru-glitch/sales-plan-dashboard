// История Я.Директа помесячно (кабинет porg-mcw4s7ni). Открывает отчёт, для каждого
// месяца 2026 (Янв..текущий) выставляет диапазон в календаре, читает строку «Итого».
// Пишет /opt/marketing-data/direct-history.json. ВАЖНО: диапазон в отчёте сохраняется
// серверно — поэтому идём по возрастанию и заканчиваем на текущем месяце (состояние
// остаётся корректным для daily-скрейпера).
//
// ФИКС 2026-06-08: раньше при неудачной перерисовке грида (waitForFunction.catch)
// скрипт молча читал УСТАРЕВШИЕ данные предыдущего месяца → апрель=май дубль.
// Теперь setMonth возвращает признак успеха (клики по дням + подтверждение месяца),
// плюс анти-устаревание: итог, совпавший с предыдущим месяцем, считается несвежим.
const { chromium } = require('/opt/2gis-scraper/node_modules/playwright');
const fs = require('fs');
const OUT = '/opt/marketing-data/direct-history.json';
// Без &state=NNN: сохранённый отчёт state=4362658 умер 06.2026 («Не удалось открыть отчёт»).
// Период всё равно выставляется календарём помесячно, дефолтный период не важен.
const REPORT = 'https://direct.yandex.ru/dna/reports/library/performance-campaigns/?ulogin=porg-mcw4s7ni';
const STATE_FILE = '/opt/2gis-scraper/yandex-state.json';

// Самолечение сессии (копия из scrape-direct.js, фикс 2026-07-29): паспорт требует
// «освежить» вход (cause=auth) — кликаем свой аккаунт в списке, пересохраняем state.
async function ensureAuth(p, ctx, out) {
  if (!/passport\.yandex|\/auth\//.test(p.url())) return true;
  const acc = p.locator('text=fabrika.mari').first();
  if (!(await acc.count().catch(() => 0))) { out.sessionExpired = true; return false; }
  await acc.click().catch(() => {});
  await p.waitForTimeout(9000);
  if (/direct\.yandex\.ru/.test(p.url())) {
    try { fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak'); } catch (_) {}
    await ctx.storageState({ path: STATE_FILE });
    out.reloggedIn = true;
    return true;
  }
  out.sessionExpired = true;
  return false;
}
const NOM=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const GEN=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const LAST=[31,28,31,30,31,30,31,31,30,31,30,31];
// Разделитель тысяч у Яндекса — неразрывные/узкие пробелы; нормализуем в обычный пробел.
const NB=new RegExp('['+String.fromCharCode(0xA0,0x202F,0x2009,0x2007)+']','g');
const one=s=>{const m=String(s||'').replace(NB,' ').match(/-?\d[\d ]*(?:[.,]\d+)?/);return m?parseFloat(m[0].replace(/ /g,'').replace(',','.')):null;};
function parseItogo(body){
  const it=body.indexOf('Итого'); if(it<0) return null;
  const tail=body.slice(it,it+400).replace(NB,' ');
  const lineNum=/^\s*-?\d[\d ]*(?:[.,]\d+)?\s*(?:₽|%)?\s*$/;
  const nums=tail.split('\n').map(s=>s.trim()).filter(s=>lineNum.test(s)).slice(0,6);
  if(!nums.length || !/₽/.test(nums[0])) return null; // первый столбец Итого — расход с ₽
  const purchases=one(nums[3]);
  return {spend:one(nums[0]),impressions:one(nums[1]),clicks:one(nums[2]),conversions:purchases,purchases,crPct:one(nums[4]),cpa:one(nums[5]),raw:nums};
}
const clickSel=(p,sel)=>p.locator(sel).first().click({force:true,noWaitAfter:true,timeout:5000}).then(()=>true).catch(()=>false);
const NEXT='[data-testid="DateRangeSelect.RangeCalendarWithButton.RangeCalendar.next"]';
const PREV='[data-testid="DateRangeSelect.RangeCalendarWithButton.RangeCalendar.prev"]';
const CALBTN='[data-testid="DateRangeSelect.RangeCalendarWithButton.Calendar"]';
const monthsVisible=p=>p.evaluate(()=>[...document.querySelectorAll('table.dc-CalendarGrid')].map(t=>t.getAttribute('aria-label')||''));
const isDisabled=(p,sel)=>p.evaluate(s=>{const e=document.querySelector(s);return !e|| e.disabled || /_disabled/.test(e.className);},sel);

// Возвращает true, ТОЛЬКО если диапазон реально переключился на месяц m
// (оба дня кликнулись и грид перерисовался с датами этого месяца).
async function setMonth(p, m, lastDay){
  await p.click(CALBTN,{timeout:8000}); await p.waitForTimeout(800);
  // якорь: листаем вперёд до упора (next disabled) → видны последние месяцы
  let g=0; while(g++<14){ if(await isDisabled(p,NEXT)) break; await clickSel(p,NEXT); await p.waitForTimeout(450); }
  // назад, пока целевой месяц не появится среди видимых таблиц
  let found=false; g=0;
  while(g++<14){ const ms=await monthsVisible(p); if(ms.some(x=>new RegExp('^'+NOM[m]+' 2026','i').test(x.trim()))){ found=true; break; }
    await clickSel(p,PREV); await p.waitForTimeout(450); }
  if(!found){ await p.keyboard.press('Escape').catch(()=>{}); return false; }
  const tbl=`table.dc-CalendarGrid[aria-label*="${NOM[m]} 2026"]`;
  const c1=await clickSel(p,`${tbl} [aria-label*=", 1 ${GEN[m]} 2026 г."]`); await p.waitForTimeout(450);
  const c2=await clickSel(p,`${tbl} [aria-label*=", ${lastDay} ${GEN[m]} 2026 г."]`); await p.waitForTimeout(700);
  await p.keyboard.press('Escape').catch(()=>{});
  if(!c1||!c2) return false;   // клик по дню не прошёл → диапазон не выставлен
  // ждём перерисовку грида под выбранный месяц: строка с датой этого месяца + ₽ возле Итого
  const mm=String(m+1).padStart(2,'0');
  const ok=await p.waitForFunction((mm)=>{
    const t=document.body.innerText||''; const i=t.indexOf('Итого');
    return i>=0 && /\d[\d  ]*[.,]?\d*\s*₽/.test(t.slice(i,i+200)) && new RegExp('\\.'+mm+'\\.2026,').test(t);
  }, mm, {timeout:22000}).then(()=>true).catch(()=>false);
  await p.waitForTimeout(1200);
  return ok;   // false = грид не подтвердил нужный месяц (раньше тут читались устаревшие данные)
}

(async () => {
  const now=new Date(); const curM=now.getMonth(); const curD=now.getDate();
  const out={ scrapedAt:new Date().toISOString(), source:'yandex-direct-history', ulogin:'porg-mcw4s7ni', months:[] };
  const b = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--lang=ru-RU'] });
  const ctx = await b.newContext({ storageState:'/opt/2gis-scraper/yandex-state.json', locale:'ru-RU', viewport:{width:1600,height:1800} });
  const p = await ctx.newPage();
  await p.goto(REPORT,{waitUntil:'domcontentloaded',timeout:45000}).catch(e=>out.error='goto:'+e.message);
  await p.waitForTimeout(5000);
  if(!(await ensureAuth(p,ctx,out))){ fs.writeFileSync(OUT,JSON.stringify(out,null,2)); console.log('SESSION EXPIRED'); await b.close(); return; }
  await p.waitForFunction(()=>/Итого/.test(document.body.innerText||''),{timeout:40000}).catch(()=>out.gridTimeout=true);
  await p.waitForTimeout(2500);

  const keyOf=r=>[r.spend,r.impressions,r.clicks,r.conversions].join('|');
  let prevKey=null;
  for(let m=0; m<=curM; m++){
    const ld = (m===curM) ? curD : LAST[m];
    const ym=`2026-${String(m+1).padStart(2,'0')}`;
    let rec=null, reason='parse';
    for(let attempt=0; attempt<3 && !rec; attempt++){
      const verified = await setMonth(p,m,ld);
      if(!verified){ reason='range-not-applied'; await p.waitForTimeout(1200); continue; }
      const body=(await p.evaluate(()=>document.body.innerText))||'';
      const r=parseItogo(body);
      if(!r){ reason='parse'; continue; }
      // Анти-устаревание: точное совпадение с предыдущим месяцем (до копейки) = грид не
      // обновился (раньше так апрель дублировался в май). Ретраим, не принимаем.
      if(prevKey!==null && keyOf(r)===prevKey){ reason='stale(==prev)'; console.log(ym,'STALE, retry'); await p.waitForTimeout(1500); continue; }
      rec=r;
    }
    if(rec){
      rec.ym=ym; rec.daysCovered=ld;
      rec.cpc = rec.spend&&rec.clicks ? Math.round(rec.spend/rec.clicks*100)/100 : null;
      rec.ctrPct = rec.clicks&&rec.impressions ? Math.round(rec.clicks/rec.impressions*1000)/10 : null;
      out.months.push(rec);
      prevKey=keyOf(rec);
      console.log(ym, JSON.stringify({spend:rec.spend,impr:rec.impressions,clicks:rec.clicks,conv:rec.conversions}));
    } else {
      out.months.push({ym, daysCovered:ld, spend:null, error:reason});
      prevKey=null;   // не блокируем следующий месяц из-за пропущенного
      console.log(ym, 'FAIL:', reason);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(out,null,2));
  console.log('WROTE', OUT, 'months:', out.months.length);
  await b.close();
})().catch(e=>console.log('FATAL', e.message));
