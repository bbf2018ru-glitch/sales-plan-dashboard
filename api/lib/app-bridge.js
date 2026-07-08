// Мост для maria-app: «верифицированный телефон → бонусы и последние покупки из 1С».
// Зачем здесь: 1С пускает только IP из whitelist (этот VDS в нём есть, Hostinger-бот — нет),
// а PHP-шлюзы сайта maria-irk.ru снесены. Бот дергает этот эндпоинт со своим токеном,
// телефон валидируется НА СТОРОНЕ БОТА (криптографическая верификация TG :contact) —
// сюда приходит уже доверенный номер.
const { callQuery, parseRu } = require('./upp-client');

// «79021706823» → «+7 (902) 170-68-23» — формат хранения КонтактныйТелефон в УПП Маши.
function to1cPhone(digits) {
  const d = String(digits).replace(/\D/g, '').replace(/^8(\d{10})$/, '7$1');
  if (!/^7\d{10}$/.test(d)) return null;
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`;
}

function parseRuDateTime(s) {
  const m = String(s).match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}${m[4] ? `T${m[4]}:${m[5]}:00` : ''}`;
}

async function getLkByPhone(rawPhone) {
  const phone = to1cPhone(rawPhone);
  if (!phone) return { ok: false, error: 'bad_phone' };

  const [bal, purch] = await Promise.all([
    callQuery(
      `ВЫБРАТЬ Т.БонуснаяКарта.Код КАК Код, Т.СуммаОстаток КАК Баллы ` +
      `ИЗ РегистрНакопления.Бонусы.Остатки КАК Т ` +
      `ГДЕ Т.БонуснаяКарта.КонтактныйТелефон = "${phone}"`
    ),
    callQuery(
      `ВЫБРАТЬ ПЕРВЫЕ 10 Ч.Дата КАК Дата, Ч.СуммаДокумента КАК Сумма, Ч.Склад.Наименование КАК Точка ` +
      `ИЗ Документ.ЧекККМ КАК Ч ` +
      `ГДЕ Ч.Проведен И Ч.ВидОперации = ЗНАЧЕНИЕ(Перечисление.ВидыОперацийЧекККМ.Продажа) ` +
      `И Ч.ДисконтнаяКарта.КонтактныйТелефон = "${phone}" ` +
      `УПОРЯДОЧИТЬ ПО Ч.Дата УБЫВ`
    ).catch(() => ({ rows: [] }))
  ]);

  const balRows = bal.rows || [];
  // Несколько карт на один телефон — суммируем остатки.
  const bonus = balRows.reduce((s, r) => s + parseRu(r['Баллы']), 0);
  const purchases = (purch.rows || []).map((r) => ({
    date: parseRuDateTime(r['Дата']),
    total: parseRu(r['Сумма']),
    store: String(r['Точка'] || '').trim()
  }));

  return {
    ok: true,
    found: balRows.length > 0 || purchases.length > 0,
    bonus: Math.round(bonus * 100) / 100,
    cards: balRows.map((r) => String(r['Код'] || '').trim()),
    purchases
  };
}

module.exports = { getLkByPhone, to1cPhone };
