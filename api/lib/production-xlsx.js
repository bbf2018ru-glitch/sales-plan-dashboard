// Серверная генерация дневного плана выпуска в .xlsx (SheetJS) из результата getPlan().
// Авто-колонки из 1С + формулы Остаток-прогноз/ИТОГО/Задание; ручные (Вычерки/Довозы/
// Выходные) — пустые, Маша дозаполняет. Колонки 1:1 с веб-таблицей и листом Маши.
const XLSX = require('xlsx');

const HDR = ['Наименование', 'ГП', 'Запас', 'Контейнер', 'Вычерки', 'Довозы', 'Сайт завтра',
  'Отгрузка завтра', 'Остаток-прогноз', 'Послезавтра', 'Сайт послезавтра', 'Выходные', 'ИТОГО', 'Задание'];
// буквы колонок A..N
const COL = HDR.map((_, i) => XLSX.utils.encode_col(i));

function v(x) { return (x == null || x === 0) ? null : x; }

function buildXlsx(plan) {
  const aoa = [];
  aoa.push(['План выпуска кондитерки · ' + plan.date + ' (' + plan.weekday + ') · послезавтра ' + plan.nextWeekday]);
  aoa.push(HDR);
  const dataRowsExcel = []; // 1-based Excel-номера строк с данными (для формул)
  (plan.ceh || []).forEach(function (c) {
    aoa.push(['▓ ' + c.name + '  ·  к выпуску ' + Math.round(c.task) + ' шт (' + c.deficit + ' поз.)']);
    (c.items || []).forEach(function (it) {
      // A..H значения; E,F пусто (ручные); I,J,K..; L пусто; M,N — формулы
      aoa.push([
        it.name, v(it.gp), v(it.zap), v(it.kont), null, null, v(it.siteL),
        v(it.ship), null, v(it.shipNext), v(it.siteP), null, null, null
      ]);
      dataRowsExcel.push({ er: aoa.length, N: it.N, R: it.R, task: it.task }); // строка (1-based) + кэш-значения
    });
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // формулы (+ кэш-значение v, иначе SheetJS дропает формулу без v)
  dataRowsExcel.forEach(function (d) {
    const er = d.er;
    ws['I' + er] = { t: 'n', v: d.N, f: `B${er}+D${er}+C${er}+E${er}-G${er}-F${er}-H${er}` };
    ws['M' + er] = { t: 'n', v: d.R, f: `I${er}-J${er}-L${er}-K${er}` };
    ws['N' + er] = (d.task > 0)
      ? { t: 'n', v: d.task, f: `IF(M${er}<0,ROUNDUP(-M${er},0),"")` }
      : { t: 's', v: '', f: `IF(M${er}<0,ROUNDUP(-M${er},0),"")` };
  });
  ws['!cols'] = [{ wch: 34 }, { wch: 7 }, { wch: 7 }, { wch: 9 }, { wch: 8 }, { wch: 7 }, { wch: 9 },
    { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 9 }, { wch: 8 }, { wch: 9 }];
  ws['!freeze'] = { xSplit: 0, ySplit: 2 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'План ' + plan.date);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildXlsx };
