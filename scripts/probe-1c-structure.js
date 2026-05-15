#!/usr/bin/env node
// Полное обследование структуры 1С Маши через прокси-endpoint /api/admin/probe-1c.
// Тянет состав полей всех ключевых объектов + sample строк живых регистров.
// Результат → C:/Users/user/.claude/projects/C--Users-user/memory/projects/sales-dashboard/reference_upp_structure.md
//
// Используем только endpoint'ы которые гарантированно работают:
//   /meta              — список всех объектов конфигурации
//   /object?kind&name  — состав полей объекта (без значений)
//   /register?name     — обороты регистра (лимит 999 — баг BSL с разделителем тысяч)

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DASH_URL = process.env.DASH_URL || 'http://186.246.14.117';
const TOKEN = process.env.DASH_TOKEN || '8694d65d-b857-491f-9b3b-8c7285fe0340';
const OUT = process.env.OUT_FILE || 'C:/Users/user/.claude/projects/C--Users-user/memory/projects/sales-dashboard/reference_upp_structure.md';

// Объекты, в которых уверены что нам нужны для аналитики. Можно расширять.
const TARGETS = [
  // Справочники
  ['Справочник', 'Номенклатура'],
  ['Справочник', 'Склады'],
  ['Справочник', 'Контрагенты'],
  ['Справочник', 'ИнформационныеКарты'],
  ['Справочник', 'БонусныеКарты'],
  ['Справочник', 'Сотрудники'],
  ['Справочник', 'ВидыНоменклатуры'],
  ['Справочник', 'НоменклатурныеГруппы'],
  ['Справочник', 'КлассификаторЕдиницИзмерения'],
  ['Справочник', 'ЕдиницыИзмерения'],
  ['Справочник', 'Акции'],
  ['Справочник', 'ВидыСкидок'],

  // Документы
  ['Документ', 'ЧекККМ'],
  ['Документ', 'ЧекККМКоррекции'],
  ['Документ', 'РеализацияТоваровУслуг'],
  ['Документ', 'ОтчетОРозничныхПродажах'],
  ['Документ', 'ВыпускПродукции'],
  ['Документ', 'ЗаказПокупателя'],

  // Регистры накопления (sample данных снимаем отдельно)
  ['РегистрНакопления', 'Продажи'],
  ['РегистрНакопления', 'ПродажиСебестоимость'],
  ['РегистрНакопления', 'Бонусы'],
  ['РегистрНакопления', 'ВыпускПродукции'],
  ['РегистрНакопления', 'ПродажиПоДисконтнымКартам'],
  ['РегистрНакопления', 'ПредоставленныеСкидки'],
  ['РегистрНакопления', 'ТоварыВРознице'],
  ['РегистрНакопления', 'ПартииТоваровНаСкладах'],

  // Регистры сведений
  ['РегистрСведений', 'Акции'],
  ['РегистрСведений', 'СкидкиНоменклатурыНатуральные'],
  ['РегистрСведений', 'СкидкиНаценкиНоменклатуры'],
  ['РегистрСведений', 'АкцияСчастливыйЧек']
];

// Регистры, для которых ещё снимаем sample
const REGISTERS_WITH_SAMPLE = [
  'Продажи', 'ПродажиСебестоимость', 'Бонусы', 'ВыпускПродукции',
  'ПредоставленныеСкидки', 'ПродажиПоДисконтнымКартам',
  'СкидкиНоменклатурыНатуральные', 'Акции', 'АкцияСчастливыйЧек'
];

// YYYY-MM прошлого месяца — там должны быть данные
function lastFullMonth() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function call(p) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${DASH_URL}/api/admin/probe-1c?path=${encodeURIComponent(p)}`);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET', headers: { 'X-User-Token': TOKEN, Accept: 'application/json' }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, data: { error: 'non-json', raw: raw.slice(0, 300) } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function probeObject(kind, name) {
  const r = await call(`object?kind=${kind}&name=${name}`);
  return { kind, name, status: r.status, data: r.data };
}

async function probeRegister(name) {
  const ym = lastFullMonth();
  const r = await call(`register?name=${name}&from=${ym}&to=${ym}&limit=5`);
  return { name, ym, status: r.status, data: r.data };
}

function renderObject({ kind, name, status, data }) {
  if (status !== 200 || data.error) {
    return `### ${kind}.${name}\n\n❌ ${status} — ${data.error || 'unknown'}\n\n`;
  }
  const props = data.properties || [];
  if (!props.length) return `### ${kind}.${name}\n\n(нет реквизитов)\n\n`;
  const lines = [`### ${kind}.${name}`, '', '| Группа | Имя | Тип | Синоним |', '|---|---|---|---|'];
  for (const p of props) {
    lines.push(`| ${p.kind} | \`${p.name}\` | ${(p.type || '').replace(/\|/g, '\\|').slice(0, 80)} | ${(p.synonym || '').slice(0, 50)} |`);
  }
  return lines.join('\n') + '\n\n';
}

function renderRegister({ name, ym, status, data }) {
  if (status !== 200 || data.error) {
    return `### РегистрНакопления.${name} (sample ${ym})\n\n❌ ${status} — ${data.error || 'unknown'}\n\n`;
  }
  const rows = data.rows || [];
  if (!rows.length) return `### РегистрНакопления.${name} (sample ${ym})\n\n(нет строк за ${ym})\n\n`;
  const fields = Object.keys(rows[0]);
  const lines = [`### РегистрНакопления.${name} (sample ${ym}, ${rows.length} строк)`, '', '**Поля:** ' + fields.map(f => `\`${f}\``).join(', '), '', '**Пример первой строки:**', '```json', JSON.stringify(rows[0], null, 2), '```', ''];
  return lines.join('\n');
}

async function main() {
  console.log(`Probe → ${DASH_URL}, results → ${OUT}`);
  const date = new Date().toISOString().slice(0, 10);
  let out = `---
name: 1С УПП Маши — структура объектов
description: Реальный состав полей справочников/документов/регистров (через /object и /register). Обновляется скриптом scripts/probe-1c-structure.js.
type: reference
---
**Сгенерировано:** ${date}
**Источник:** ${DASH_URL}/api/admin/probe-1c (proxy к ${process.env.UPP_PULL_URL || 'HTTP-сервис ДашбордПродажАПИ'})

> Это карта реальных полей УПП Маши. Используй её прежде чем писать SQL/BSL запрос — иначе упрёшься в "Поле не найдено".

`;

  out += `## Структура объектов\n\n`;
  for (const [kind, name] of TARGETS) {
    process.stdout.write(`  ${kind}.${name}... `);
    try {
      const r = await probeObject(kind, name);
      out += renderObject(r);
      console.log(r.status === 200 ? `✓ ${(r.data.properties || []).length} полей` : `✗ ${r.status}`);
    } catch (e) {
      out += `### ${kind}.${name}\n\n❌ ${e.message}\n\n`;
      console.log(`✗ ${e.message}`);
    }
  }

  out += `## Sample данных регистров\n\n`;
  for (const name of REGISTERS_WITH_SAMPLE) {
    process.stdout.write(`  register ${name}... `);
    try {
      const r = await probeRegister(name);
      out += renderRegister(r);
      console.log(r.status === 200 ? `✓ ${(r.data.rows || []).length} строк` : `✗ ${r.status}`);
    } catch (e) {
      out += `### РегистрНакопления.${name}\n\n❌ ${e.message}\n\n`;
      console.log(`✗ ${e.message}`);
    }
  }

  fs.writeFileSync(OUT, out, 'utf8');
  console.log(`\nGenerated → ${OUT}`);
  console.log(`Size: ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
}

main().catch(e => { console.error(e); process.exit(1); });
