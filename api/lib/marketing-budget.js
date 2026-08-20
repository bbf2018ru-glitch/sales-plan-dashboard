// План / утверждение / оплата маркетингового бюджета.
//
// План: публичная Google Sheets Маши с помесячными листами.
// Факт: Документ.ИА_ЗаказНаПриобретение (только маркетинговые фонды отделения
// продаж и продвижения). Сумма «одобрено» берётся из ПОСЛЕДНЕГО решения табличной
// части Документ.ИА_ФинансовоеПланирование.ЗаказыНаПриобретение. Заявки, которые
// ещё ждут ФП, показываются отдельно и не подменяют факт.
// Оплачено: движения денег за месяц по всем явно маркетинговым статьям 1С,
// с детализацией до платежа, контрагента и назначения.

const http = require('http');
const https = require('https');
const XLSX = require('xlsx');
const upp = require('./upp-client');

const DEFAULT_SHEET_ID = '1I2QlY4LbyXxjvGgtwmeJrZocbbMnhmaDdVDKx9B1F5A';
const PROMOTION_DEPARTMENT = '2 Отделение продаж и продвижения';
const sheetCache = upp.makeCache(60 * 60 * 1000, 'marketing-budget-sheet');
const resultCache = upp.makeCache(15 * 60 * 1000, 'marketing-budget');

const MONTHS = [
  '', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];

const CATEGORIES = [
  { key: 'internet', name: 'Интернет-реклама' },
  { key: 'sms', name: 'SMS-рассылки' },
  { key: 'print', name: 'Печать и вывески' },
  { key: 'offline', name: 'Офлайн-реклама' },
  { key: 'content', name: 'Блогеры и контент' },
  { key: 'loyalty', name: 'UDS и программы' },
  { key: 'other', name: 'Прочее продвижение' }
];

const MARKETING_FUND_RE = /интернет\s*реклам|смс\s*рассыл|фонд\s*накопления\s*продвиж|офлайн\s*реклам|печатн.*реклам|размещен.*вывес|оформлен.*тт|\buds\b|юдс/i;

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let s = String(value || '').replace(/[₽рР\s\u00a0\u202f]/g, '').replace(/[^0-9,.-]/g, '');
  if (!s) return 0;
  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  if (commas > 1 || (commas === 1 && /^-?\d+,\d{3}$/.test(s))) s = s.replace(/,/g, '');
  else if (commas === 1 && dots === 0) s = s.replace(',', '.');
  if (dots > 1 || (dots === 1 && /^-?\d+\.\d{3}$/.test(s))) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function bounds(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) throw new Error('Некорректный период бюджета');
  const y = Number(m[1]), month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error('Некорректный месяц бюджета');
  return { y, m: month, ny: month === 12 ? y + 1 : y, nm: month === 12 ? 1 : month + 1 };
}

function classifyText(value, fund) {
  const s = normalize(`${fund || ''} ${value || ''}`);
  if (/смс|sms/.test(s)) return 'sms';
  if (/\buds\b|юдс|лояльност/.test(s)) return 'loyalty';
  if (/блогер|амбассадор|копирайт|актер|видео|песн|контент|смм|smm|соц сет/.test(s)) return 'content';
  if (/печат|листов|вывес|баннер|банер|оклей|расклей|стойк|стикер|оформлен.*тт/.test(s)) return 'print';
  if (/таплинк/.test(s)) return 'internet';
  if (/лифт|кино|экран|телевид|\bтв\b|транспорт|трамва|автобус|наружн|музык|фасад/.test(s)) return 'offline';
  if (/интернет|сео|seo|контекст|яндекс|2гис|ретарг|калибр|авито|рейтинг|сайт/.test(s)) return 'internet';
  if (/фонд накопления продвиж|офлайн реклам/.test(s)) return 'offline';
  return 'other';
}

function fetchBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, { headers: { 'User-Agent': 'Maria-Sales-Dashboard/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(fetchBuffer(new URL(res.headers.location, target).toString(), redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Google Sheets вернул HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) req.destroy(new Error('Файл бюджета слишком большой'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(30000, () => req.destroy(new Error('Таймаут Google Sheets')));
    req.on('error', reject);
  });
}

function headerPeriod(rows) {
  for (const row of rows.slice(0, 12)) {
    const text = row.map((v) => String(v || '')).join(' ');
    const year = /(20\d{2})/.exec(text);
    const month = MONTHS.findIndex((name, i) => i > 0 && new RegExp(name, 'i').test(text));
    if (year && month > 0) return `${year[1]}-${String(month).padStart(2, '0')}`;
  }
  return null;
}

function otherMonthInHeading(text, requestedMonth) {
  const n = normalize(text);
  for (let i = 1; i < MONTHS.length; i += 1) {
    const stem = normalize(MONTHS[i]).slice(0, 5);
    if (i !== requestedMonth && stem && n.includes(stem)) return MONTHS[i];
  }
  return null;
}

function parseSheetRows(rows, period, sheetName) {
  const b = bounds(period);
  const foundPeriod = headerPeriod(rows);
  if (foundPeriod && foundPeriod !== period) {
    return {
      available: false,
      sheetName,
      total: 0,
      declaredTotal: 0,
      items: [],
      warnings: [`Лист «${sheetName}» содержит заголовок за ${foundPeriod}, а выбран ${period}. План не подставлен, чтобы не показать чужой месяц.`]
    };
  }

  let headerRow = rows.findIndex((row) => row.some((v) => /статья\s+затрат/i.test(String(v || ''))));
  if (headerRow < 0) headerRow = 3;
  let section = '';
  let skipForeignMonthSection = false;
  let declaredTotal = 0;
  const items = [];

  for (let i = headerRow + 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const colA = String(row[0] || '').trim();
    const article = String(row[1] || '').trim();
    const amount = parseMoney(row[2]);
    const comment = String(row[3] || '').trim();
    if (!colA && !article && !amount && !comment) continue;

    if (!article && amount > 0 && !declaredTotal) {
      declaredTotal = amount;
      continue;
    }

    if (amount <= 0 && (colA || article)) {
      const heading = article || colA;
      const foreignMonth = otherMonthInHeading(heading, b.m);
      if (foreignMonth && /оплат|подряд|бюджет|расход/i.test(normalize(heading))) {
        skipForeignMonthSection = true;
        section = heading;
        continue;
      }
      skipForeignMonthSection = false;
      section = heading;
      continue;
    }

    if (skipForeignMonthSection || amount <= 0 || !article || /^(итого|всего)/i.test(article)) continue;
    items.push({
      row: i + 1,
      section,
      name: article,
      amount: Math.round(amount * 100) / 100,
      comment,
      category: classifyText(`${section} ${article} ${comment}`)
    });
  }

  const total = Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  const warnings = [];
  if (declaredTotal > 0 && Math.abs(total - declaredTotal) >= 1) {
    warnings.push(`Сумма строк ${Math.round(total).toLocaleString('ru-RU')} ₽ не совпадает с итогом в шапке ${Math.round(declaredTotal).toLocaleString('ru-RU')} ₽. В план взята сумма строк.`);
  }
  return { available: true, sheetName, total, declaredTotal, items, warnings };
}

async function getSheetPlan(period) {
  const b = bounds(period);
  const sheetName = MONTHS[b.m];
  return sheetCache.wrap(`sheet-v1:${period}`, async () => {
    const id = process.env.MKT_BUDGET_SHEET_ID || DEFAULT_SHEET_ID;
    const buf = await fetchBuffer(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=xlsx`);
    const workbook = XLSX.read(buf, { type: 'buffer' });
    if (!workbook.Sheets[sheetName]) {
      return { available: false, sheetName, total: 0, declaredTotal: 0, items: [], warnings: [`В Google Sheets нет листа «${sheetName}».`] };
    }
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const plan = parseSheetRows(rows, period, sheetName);
    plan.sourceUpdatedAt = new Date().toISOString();
    return plan;
  });
}

function decisionKind(status) {
  const s = normalize(status);
  if (/не одобрен|отказ|отклон|отмен/.test(s)) return 'rejected';
  if (/одобрен/.test(s)) return 'approved';
  return 'pending';
}

async function getOrdersFact(period) {
  const b = bounds(period);
  const from = `ДАТАВРЕМЯ(${b.y},${b.m},1)`;
  const to = `ДАТАВРЕМЯ(${b.ny},${b.nm},1)`;
  const department = PROMOTION_DEPARTMENT.replace(/"/g, '""');

  const ordersQ = 'ВЫБРАТЬ З.Дата КАК Дата, З.Номер КАК Номер,'
    + ' З.Подразделение КАК Подразделение, З.ПодразделениеПредприятия КАК ЦФО,'
    + ' З.Фонд КАК Фонд, З.ПредметЗаказа КАК Предмет, З.Сумма КАК Сумма,'
    + ' З.Статус КАК Статус, З.ДатаОплаты КАК ДатаОплаты, З.Сотрудник КАК Сотрудник'
    + ' ИЗ Документ.ИА_ЗаказНаПриобретение КАК З'
    + ` ГДЕ З.Дата >= ${from} И З.Дата < ${to}`
    + ' И З.Проведен = ИСТИНА'
    + ` И З.Подразделение.Наименование = "${department}"`
    + ' УПОРЯДОЧИТЬ ПО Дата';

  // Один заказ может переходить из недели в неделю. Берём все его строки ФП,
  // а ниже оставляем решение из самого нового документа финансового планирования.
  const decisionsQ = 'ВЫБРАТЬ С.Заказ.Номер КАК Номер,'
    + ' С.Ссылка.Дата КАК ДатаФП, С.Ссылка.Номер КАК НомерФП,'
    + ' С.Статус КАК Статус, С.УтвержденнаяСумма КАК Утверждено'
    + ' ИЗ Документ.ИА_ФинансовоеПланирование.ЗаказыНаПриобретение КАК С'
    + ` ГДЕ С.Заказ.Дата >= ${from} И С.Заказ.Дата < ${to}`
    + ' И С.Заказ.Проведен = ИСТИНА'
    + ` И С.Заказ.Подразделение.Наименование = "${department}"`
    + ' УПОРЯДОЧИТЬ ПО Номер, ДатаФП';

  const [ordersRes, decisionsRes] = await Promise.all([
    upp.callQuery(ordersQ),
    upp.callQuery(decisionsQ)
  ]);

  const latest = new Map();
  for (const row of (decisionsRes.rows || [])) {
    const key = String(row.Номер || '').trim();
    const date = upp.parseRuDate(row.ДатаФП);
    const prev = latest.get(key);
    if (!prev || (date && (!prev.date || date > prev.date))) {
      latest.set(key, {
        date,
        dateText: row.ДатаФП || '',
        fpNumber: String(row.НомерФП || '').trim(),
        status: row.Статус || '',
        approvedAmount: upp.parseRu(row.Утверждено)
      });
    }
  }

  const orders = [];
  for (const row of (ordersRes.rows || [])) {
    const fund = String(row.Фонд || '').trim();
    if (!MARKETING_FUND_RE.test(fund)) continue;
    const number = String(row.Номер || '').trim();
    const requested = Math.round(upp.parseRu(row.Сумма) * 100) / 100;
    const decision = latest.get(number) || null;
    const status = decision ? decision.status : String(row.Статус || '');
    const kind = decisionKind(status);
    const approved = kind === 'approved'
      ? Math.round((decision ? decision.approvedAmount : requested) * 100) / 100
      : 0;
    const pending = kind === 'pending' ? requested : 0;
    const subject = String(row.Предмет || '').trim();
    orders.push({
      number,
      date: row.Дата || '',
      paymentDate: row.ДатаОплаты || '',
      fund,
      subject,
      costCenter: String(row.ЦФО || '').trim(),
      employee: String(row.Сотрудник || '').trim(),
      requested,
      approved,
      pending,
      status,
      statusKind: kind,
      fpNumber: decision ? decision.fpNumber : null,
      fpDate: decision ? decision.dateText : null,
      category: classifyText(subject, fund)
    });
  }

  const sum = (field) => Math.round(orders.reduce((acc, row) => acc + (row[field] || 0), 0) * 100) / 100;
  return {
    orders,
    requested: sum('requested'),
    approved: sum('approved'),
    pending: sum('pending'),
    rejected: Math.round(orders.filter((row) => row.statusKind === 'rejected').reduce((acc, row) => acc + row.requested, 0) * 100) / 100,
    counts: {
      total: orders.length,
      approved: orders.filter((row) => row.statusKind === 'approved').length,
      pending: orders.filter((row) => row.statusKind === 'pending').length,
      rejected: orders.filter((row) => row.statusKind === 'rejected').length
    }
  };
}

function cashDay(value) {
  const s = String(value || '');
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : s.slice(0, 10);
}

// В регистре ДДС один и тот же расход иногда остаётся одновременно как выдача
// наличных (РКО) и как авансовый отчёт. Это не обычные сторно/перераспределения:
// схлопываем только точную положительную пару «день + статья + контрагент + сумма».
// Все отрицательные движения и неточные пары сохраняются без изменений.
function deduplicateCashTransactions(transactions) {
  const groups = new Map();
  transactions.forEach((tx, index) => {
    if (!(tx.amount > 0)) return;
    const key = [
      cashDay(tx.date),
      normalize(tx.article),
      normalize(tx.counterparty),
      Number(tx.amount).toFixed(2)
    ].join('|');
    if (!groups.has(key)) groups.set(key, { rko: [], advance: [] });
    const doc = normalize(tx.document);
    if (/расходн.*кассов.*ордер/.test(doc)) groups.get(key).rko.push(index);
    else if (/авансов.*отчет/.test(doc)) groups.get(key).advance.push(index);
  });

  const excluded = new Set();
  const adjustments = [];
  for (const group of groups.values()) {
    const pairs = Math.min(group.rko.length, group.advance.length);
    for (let i = 0; i < pairs; i += 1) {
      const rkoIndex = group.rko[i];
      const advanceIndex = group.advance[i];
      excluded.add(rkoIndex);
      const rko = transactions[rkoIndex];
      const advance = transactions[advanceIndex];
      adjustments.push({
        kind: 'rko-advance-duplicate',
        date: cashDay(rko.date),
        article: rko.article,
        counterparty: rko.counterparty,
        amount: rko.amount,
        excludedDocument: rko.document,
        keptDocument: advance.document,
        note: 'Точная пара РКО и авансового отчёта учтена один раз.'
      });
    }
  }
  return {
    transactions: transactions.filter((_, index) => !excluded.has(index)),
    adjustments,
    deduplicatedAmount: Math.round(adjustments.reduce((sum, row) => sum + row.amount, 0) * 100) / 100
  };
}

async function getPaidFact(period) {
  const b = bounds(period);
  const cashQ = 'ВЫБРАТЬ Д.Период КАК Дата,'
    + ' Д.СтатьяДвиженияДенежныхСредств.Наименование КАК Статья,'
    + ' Д.Контрагент.Наименование КАК Контрагент, Д.ДокументДвижения КАК Документ,'
    + ' П.НазначениеПлатежа КАК Назначение, Д.СуммаУпр КАК Сумма'
    + ' ИЗ РегистрНакопления.ДвиженияДенежныхСредств КАК Д'
    + ' ЛЕВОЕ СОЕДИНЕНИЕ Документ.ПлатежноеПоручениеИсходящее КАК П'
    + ' ПО Д.ДокументДвижения = П.Ссылка'
    + ` ГДЕ Д.Период >= ДАТАВРЕМЯ(${b.y},${b.m},1)`
    + ` И Д.Период < ДАТАВРЕМЯ(${b.ny},${b.nm},1)`
    + ' И Д.ПриходРасход = ЗНАЧЕНИЕ(Перечисление.ВидыДвиженийПриходРасход.Расход)'
    + ' УПОРЯДОЧИТЬ ПО Дата';
  const cashRes = await upp.callQuery(cashQ, { timeoutMs: 60000 });
  const rawTransactions = [];
  for (const row of (cashRes.rows || [])) {
    const article = String(row.Статья || '').trim();
    if (!MARKETING_FUND_RE.test(normalize(article))) continue;
    const amount = Math.round(upp.parseRu(row.Сумма) * 100) / 100;
    if (!amount) continue;
    rawTransactions.push({
      article,
      category: classifyText(article, article),
      date: row.Дата || '',
      counterparty: String(row.Контрагент || '').trim(),
      document: String(row.Документ || '').trim(),
      purpose: String(row.Назначение || '').replace(/\s+/g, ' ').trim(),
      amount
    });
  }
  const deduped = deduplicateCashTransactions(rawTransactions);
  const byArticle = new Map();
  for (const tx of deduped.transactions) {
    const article = tx.article;
    if (!byArticle.has(article)) {
      byArticle.set(article, {
        name: article,
        category: tx.category,
        amount: 0,
        transactions: []
      });
    }
    const item = byArticle.get(article);
    item.amount += tx.amount;
    item.transactions.push({
      date: tx.date,
      counterparty: tx.counterparty,
      document: tx.document,
      purpose: tx.purpose,
      amount: tx.amount
    });
  }
  const articles = Array.from(byArticle.values()).map((article) => {
    article.amount = Math.round(article.amount * 100) / 100;
    article.transactions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return article;
  }).sort((a, b) => b.amount - a.amount);
  return {
    available: true,
    total: Math.round(articles.reduce((sum, article) => sum + article.amount, 0) * 100) / 100,
    articles,
    // «Движение» точнее слова «платёж»: здесь есть РКО, авансовые отчёты и сторно.
    movements: deduped.transactions.length,
    rawMovements: rawTransactions.length,
    documents: new Set(deduped.transactions.map((tx) => tx.document).filter(Boolean)).size,
    transactions: deduped.transactions.length,
    deduplicatedAmount: deduped.deduplicatedAmount,
    adjustments: deduped.adjustments
  };
}

function buildCategories(plan, fact, paid) {
  const map = new Map(CATEGORIES.map((category) => [category.key, {
    key: category.key,
    name: category.name,
    plan: 0,
    approved: 0,
    pending: 0,
    requested: 0,
    paid: 0,
    planItems: 0,
    orders: 0,
    payments: 0
  }]));
  for (const item of (plan.items || [])) {
    const row = map.get(item.category) || map.get('other');
    row.plan += item.amount;
    row.planItems += 1;
  }
  for (const order of (fact.orders || [])) {
    const row = map.get(order.category) || map.get('other');
    row.approved += order.approved;
    row.pending += order.pending;
    row.requested += order.requested;
    row.orders += 1;
  }
  for (const article of (paid.articles || [])) {
    const row = map.get(article.category) || map.get('other');
    row.paid += article.amount;
    row.payments += (article.transactions || []).length;
  }
  return Array.from(map.values()).map((row) => {
    for (const field of ['plan', 'approved', 'pending', 'requested', 'paid']) row[field] = Math.round(row[field] * 100) / 100;
    row.committed = Math.round((row.approved + row.pending) * 100) / 100;
    row.remaining = Math.round((row.plan - row.committed) * 100) / 100;
    row.executionPct = row.plan > 0 ? Math.round(row.approved / row.plan * 1000) / 10 : null;
    row.remainingPaid = Math.round((row.plan - row.paid) * 100) / 100;
    row.paidPct = row.plan > 0 ? Math.round(row.paid / row.plan * 1000) / 10 : null;
    return row;
  }).filter((row) => row.plan || row.orders || row.payments);
}

async function compute(period) {
  const [planResult, factResult, paidResult] = await Promise.allSettled([
    getSheetPlan(period),
    getOrdersFact(period),
    getPaidFact(period)
  ]);
  const plan = planResult.status === 'fulfilled'
    ? planResult.value
    : { available: false, total: 0, declaredTotal: 0, items: [], warnings: [`Google Sheets недоступен: ${planResult.reason.message}`] };
  const fact = factResult.status === 'fulfilled'
    ? factResult.value
    : { available: false, approved: 0, pending: 0, requested: 0, rejected: 0, orders: [], counts: { total: 0, approved: 0, pending: 0, rejected: 0 }, error: factResult.reason.message };
  if (fact.available === undefined) fact.available = true;
  const paid = paidResult.status === 'fulfilled'
    ? paidResult.value
    : { available: false, total: 0, articles: [], movements: 0, rawMovements: 0, documents: 0, transactions: 0, adjustments: [], deduplicatedAmount: 0, error: paidResult.reason.message };

  const committed = Math.round((fact.approved + fact.pending) * 100) / 100;
  const remainingApproved = Math.round((plan.total - fact.approved) * 100) / 100;
  const remainingCommitted = Math.round((plan.total - committed) * 100) / 100;
  return {
    period,
    plan,
    fact,
    paid,
    categories: buildCategories(plan, fact, paid),
    totals: {
      plan: plan.total,
      approved: fact.approved,
      pending: fact.pending,
      paid: paid.total,
      committed,
      remainingApproved,
      remainingCommitted,
      remainingPaid: Math.round((plan.total - paid.total) * 100) / 100,
      executionPct: plan.total > 0 ? Math.round(fact.approved / plan.total * 1000) / 10 : null,
      committedPct: plan.total > 0 ? Math.round(committed / plan.total * 1000) / 10 : null,
      paidPct: plan.total > 0 ? Math.round(paid.total / plan.total * 1000) / 10 : null
    },
    note: 'План — сумма строк выбранного листа Google Sheets. «Утверждено» — последнее решение ФП по маркетинговым заказам. «Оплачено» — фактические расходы по всем маркетинговым статьям движения денег в 1С за выбранный месяц. Точные пары РКО и авансового отчёта учитываются один раз.',
    refreshedAt: new Date().toISOString()
  };
}

function getMarketingBudget(period) {
  const p = period || upp.nowYM();
  return resultCache.wrap(`marketing-budget-v3:${p}`, () => compute(p));
}

module.exports = {
  getMarketingBudget,
  // Чистые функции оставлены доступными для регрессионных проверок парсинга.
  parseMoney,
  parseSheetRows,
  classifyText,
  deduplicateCashTransactions
};
