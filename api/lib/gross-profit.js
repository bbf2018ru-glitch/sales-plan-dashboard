// Валовая и операционная прибыль (из 1С).
//
// Источник: РегистрНакопления.УчётЗатрат, КодОперации = «Списание партий в
// производство оперативно», ВидДвижения = Расход — стоимость материалов (мука,
// сахар, начинки), списанных в производство. Это себестоимость в её отчёте:
// маржа = выручка − материалы (производство централизованное, производство ≈
// продажи). Проверено 08.06.2026: маржа 73.8–74.8%/мес ≈ отчётные 74.6%.
//
// Фильтр по enum-значению (КодыОперацийПартииТоваров.СписаниеПартийВПроизводство-
// Оперативно + ВидДвиженияНакопления.Расход) использует индекс регистра → запрос
// за 12 месяцев выполняется ~1с (без фильтра группировка всего УчётЗатрат ~110с).
//
// Заглушки незакрытого месяца (себестоимость произведённого ещё не рассчитана —
// астрономические значения, июнь давал −106 трлн) отсекаем |Стоимость|<1млрд.
// Решение costed/не-costed (правдоподобность маржи) — на стороне эндпоинта.
//
// Полный ФОТ: проводки проведённых документов «Отражение зарплаты в регл.
// учёте» по затратным счетам 20/25/26/44, кредит 70 (начисления) и 69
// (взносы работодателя). Дебет 70 (НДФЛ/удержания) не прибавляем второй раз.
//
// Прочие операционные затраты: фактически оплаченные статьи регистра
// «Движения денежных средств». Исключаем себестоимость и зарплату (они уже
// учтены выше), внутренние перемещения/депозиты/кредиты/собственников и CAPEX.
// Налоговые платежи показываем отдельно: ЕНС не позволяет надёжно отделить
// НДФЛ, уже входящий в начисленный ФОТ, от налогов бизнеса.

const upp = require('./upp-client');
const cache = upp.makeCache(6 * 60 * 60 * 1000, 'gross-profit'); // 6ч, диск-персистентный

const COST_ACCOUNT_RE = /^(20|25|26|44)/;
const MATERIAL_CASH_RE = /^себестоимость$/i;
const PAYROLL_CASH_RE = /выдача.*заработ|заработн.*плат|аванс.*зарплат/i;
const TAX_CASH_RE = /оплата.*налог|налог.*сбор|страхов.*взнос/i;
const CAPEX_CASH_RE = /приобретение.*оборуд|приобретение.*инвентар|приобретение оргтех|приобретение.*основн|строитель|капитальн|покупка.*автомоб|покупка.*недвиж/i;
const NON_OPERATING_CASH_RE = /размещен.*депозит|внутр.*перемещ|^вн\s*перемещ|снятие|выдача под отчет|кредит.*погаш|учредительск|расходы собственников|личн.*собствен|перевод между|пополнение.*касс/i;

function normalize(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function partyKey(value) {
  return normalize(value).replace(/[^a-zа-я0-9]/g, '');
}

function round(value) { return Math.round((value || 0) * 100) / 100; }

function median(values) {
  const a = values.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function classifyCashExpense(article, details = {}) {
  const s = normalize(article);
  if (!s) return 'excluded';
  // Перевод, где организация и контрагент — одно и то же ИП, является выводом
  // предпринимательского дохода/перемещением собственных денег, а не расходом
  // бизнеса. В июле такие переводы были записаны под общей статьёй «Прочие
  // расходы» и ошибочно уменьшали операционную прибыль на 4 005 000 ₽.
  const organization = partyKey(details.organization);
  const counterparty = partyKey(details.counterparty);
  if (organization && counterparty && organization === counterparty) return 'excluded';
  if (MATERIAL_CASH_RE.test(s)) return 'materials';
  if (PAYROLL_CASH_RE.test(s)) return 'payroll';
  if (TAX_CASH_RE.test(s)) return 'taxes';
  if (CAPEX_CASH_RE.test(s)) return 'capex';
  if (NON_OPERATING_CASH_RE.test(s)) return 'excluded';
  return 'operating';
}

function bounds(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { y, m, ny: next[0], nm: next[1] };
}
function monthsBack(period, n) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - (n - 1), 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

async function compute(period) {
  const b = bounds(period);
  const fr = monthsBack(period, 12); // 12 месяцев по выбранный включительно
  const materialsQ = 'ВЫБРАТЬ НАЧАЛОПЕРИОДА(З.Период, МЕСЯЦ) КАК Мес, СУММА(З.Стоимость) КАК Себест'
    + ' ИЗ РегистрНакопления.УчетЗатрат КАК З'
    + ` ГДЕ З.Период >= ДАТАВРЕМЯ(${fr.y},${fr.m},1) И З.Период < ДАТАВРЕМЯ(${b.ny},${b.nm},1)`
    + ' И З.ВидДвижения = ЗНАЧЕНИЕ(ВидДвиженияНакопления.Расход)'
    + ' И З.КодОперации = ЗНАЧЕНИЕ(Перечисление.КодыОперацийПартииТоваров.СписаниеПартийВПроизводствоОперативно)'
    + ' И З.Стоимость < 1000000000 И З.Стоимость > -1000000000'
    + ' СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(З.Период, МЕСЯЦ)';

  const payrollQ = 'ВЫБРАТЬ НАЧАЛОПЕРИОДА(Т.Ссылка.ПериодРегистрации, МЕСЯЦ) КАК Мес,'
    + ' Т.СчетДт КАК СчетДт, Т.СчетКт КАК СчетКт, Т.СубконтоДт1 КАК Подразделение,'
    + ' СУММА(Т.Сумма) КАК Сумма'
    + ' ИЗ Документ.ОтражениеЗарплатыВРеглУчете.ОтражениеВУчете КАК Т'
    + ` ГДЕ Т.Ссылка.ПериодРегистрации >= ДАТАВРЕМЯ(${fr.y},${fr.m},1)`
    + ` И Т.Ссылка.ПериодРегистрации < ДАТАВРЕМЯ(${b.ny},${b.nm},1)`
    + ' И Т.Ссылка.Проведен = ИСТИНА'
    + ' СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(Т.Ссылка.ПериодРегистрации, МЕСЯЦ),'
    + ' Т.СчетДт, Т.СчетКт, Т.СубконтоДт1';

  const cashQ = 'ВЫБРАТЬ НАЧАЛОПЕРИОДА(Д.Период, МЕСЯЦ) КАК Мес,'
    + ' Д.СтатьяДвиженияДенежныхСредств КАК Статья, Д.Организация КАК Организация,'
    + ' Д.Контрагент КАК Контрагент, СУММА(Д.СуммаУпр) КАК Сумма'
    + ' ИЗ РегистрНакопления.ДвиженияДенежныхСредств КАК Д'
    + ` ГДЕ Д.Период >= ДАТАВРЕМЯ(${fr.y},${fr.m},1) И Д.Период < ДАТАВРЕМЯ(${b.ny},${b.nm},1)`
    + ' И Д.ПриходРасход = ЗНАЧЕНИЕ(Перечисление.ВидыДвиженийПриходРасход.Расход)'
    + ' СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(Д.Период, МЕСЯЦ), Д.СтатьяДвиженияДенежныхСредств,'
    + ' Д.Организация, Д.Контрагент';

  const [materialsRes, payrollRes, cashRes] = await Promise.all([
    upp.callQuery(materialsQ, { timeoutMs: 60000 }),
    upp.callQuery(payrollQ, { timeoutMs: 60000 }),
    upp.callQuery(cashQ, { timeoutMs: 60000 })
  ]);
  const ymOf = (s) => { const p = upp.parseRuDate(s); return p ? `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, '0')}` : String(s).slice(0, 7); };

  const cogsByMonth = {};
  for (const row of (materialsRes && materialsRes.rows) || []) {
    cogsByMonth[ymOf(row.Мес)] = Math.round(upp.parseRu(row.Себест));
  }

  const payrollByMonth = {};
  const payrollUnits = {};
  for (const row of (payrollRes && payrollRes.rows) || []) {
    const ym = ymOf(row.Мес);
    const debit = String(row.СчетДт || '').trim();
    const credit = String(row.СчетКт || '').trim();
    if (!COST_ACCOUNT_RE.test(debit) || (!credit.startsWith('70') && !credit.startsWith('69'))) continue;
    if (!payrollByMonth[ym]) payrollByMonth[ym] = { wages: 0, contributions: 0, total: 0, complete: false };
    const amount = upp.parseRu(row.Сумма);
    if (credit.startsWith('70')) payrollByMonth[ym].wages += amount;
    else payrollByMonth[ym].contributions += amount;
    payrollByMonth[ym].total += amount;
    if (credit.startsWith('70')) {
      const unit = String(row.Подразделение || '').trim() || 'Без подразделения';
      if (!payrollUnits[ym]) payrollUnits[ym] = {};
      payrollUnits[ym][unit] = (payrollUnits[ym][unit] || 0) + amount;
    }
  }
  const payrollMonths = Object.keys(payrollByMonth).sort();
  for (let i = 0; i < payrollMonths.length; i += 1) {
    const ym = payrollMonths[i];
    const p = payrollByMonth[ym];
    p.wages = round(p.wages);
    p.contributions = round(p.contributions);
    p.total = round(p.total);
    const prior = payrollMonths.slice(Math.max(0, i - 3), i)
      .map((key) => payrollByMonth[key].total).filter((value) => value > 0);
    const baseline = median(prior);
    p.complete = p.total > 0 && (!baseline || p.total >= baseline * 0.65);
    p.units = Object.entries(payrollUnits[ym] || {})
      .map(([name, amount]) => ({ name, amount: round(amount) }))
      .sort((x, y) => y.amount - x.amount);
  }

  const cashByMonth = {};
  for (const row of (cashRes && cashRes.rows) || []) {
    const ym = ymOf(row.Мес);
    if (!cashByMonth[ym]) cashByMonth[ym] = {
      operating: 0, taxes: 0, capex: 0, excluded: 0,
      materialsPaid: 0, payrollPaid: 0, items: []
    };
    const entry = cashByMonth[ym];
    const article = String(row.Статья || '').trim();
    const amount = upp.parseRu(row.Сумма);
    const kind = classifyCashExpense(article, {
      organization: row.Организация,
      counterparty: row.Контрагент
    });
    if (!(amount > 0)) { entry.excluded += amount; continue; }
    if (kind === 'operating') {
      entry.operating += amount;
      const item = entry.items.find((x) => x.name === article);
      if (item) item.amount = round(item.amount + amount);
      else entry.items.push({ name: article, amount: round(amount) });
    } else if (kind === 'taxes') entry.taxes += amount;
    else if (kind === 'capex') entry.capex += amount;
    else if (kind === 'materials') entry.materialsPaid += amount;
    else if (kind === 'payroll') entry.payrollPaid += amount;
    else entry.excluded += amount;
  }
  for (const entry of Object.values(cashByMonth)) {
    for (const key of ['operating', 'taxes', 'capex', 'excluded', 'materialsPaid', 'payrollPaid']) entry[key] = round(entry[key]);
    entry.items.sort((x, y) => y.amount - x.amount);
  }

  return {
    period,
    cogs: cogsByMonth[period] != null ? cogsByMonth[period] : null,
    cogsByMonth,
    payrollByMonth,
    cashByMonth,
    source: '1С: УчётЗатрат (материалы) + Отражение зарплаты в регл. учёте (весь начисленный ФОТ) + Движения денежных средств (прочие оплаченные операционные затраты)',
    basisNote: 'Прочие затраты показаны по оплате. Налоги, CAPEX, кредиты, депозиты, внутренние переводы и расходы собственников в операционную прибыль не включены; налоговые платежи вынесены отдельно, потому что пополнение ЕНС нельзя надёжно разделить на НДФЛ (уже внутри ФОТ) и налоги бизнеса.',
    refreshedAt: new Date().toISOString()
  };
}

function getGrossProfitCogs(period) {
  const p = period || upp.nowYM();
  // v4 — исключены переводы предпринимательского дохода самому ИП.
  return cache.wrap('gpv4:' + p, () => compute(p));
}

module.exports = { getGrossProfitCogs, classifyCashExpense };
