// Маркетинг: advanced-аналитика — RFM, когорты, зомби, каннибализация, кластеры,
// праздники YoY, история рейтинга 2ГИС. Отдельный файл, чтобы не пересечься
// с активной правкой web/app.js в параллельной сессии.
// Подключается через <script src="marketing-advanced.js?v=N"></script> из index.html.

(function () {
  'use strict';

  // Грузим JSON через тот же helper что используется в app.js — fetch + ловим non-200.
  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.json();
  }

  function fmtMoney(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + ' М';
    if (v >= 1_000) return (v / 1_000).toFixed(0) + ' К';
    return Math.round(v).toLocaleString('ru-RU');
  }
  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return (v * 100).toFixed(1) + ' %';
  }
  function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function currentPeriod() {
    // ЕДИНЫЙ источник периода со страницей: state.period из app.js (глобальный
    // селектор слева). Иначе наши вставки (критерии под рассылками) могли брать
    // другой месяц, чем таблицы app.js → ключи «дата+текст» не совпадали и
    // строки молча не вставлялись. URL/календарь — только фоллбэк.
    try { if (typeof state !== 'undefined' && state.period) return state.period; } catch (_) {}
    const params = new URLSearchParams(location.search);
    return params.get('period') || (() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    })();
  }

  // ─── RFM ────────────────────────────────────────────────────────────────────
  async function loadRfm() {
    const el = document.getElementById('mktRfm');
    if (!el) return;
    el.innerHTML = '<div class="muted" style="font-size:12px;padding:8px">Загрузка…</div>';
    try {
      const to = currentPeriod();
      const from = (() => {
        const [y, m] = to.split('-').map(Number);
        const sm = m - 5;
        const sy = y + Math.floor((sm - 1) / 12);
        const fm = ((sm - 1) % 12 + 12) % 12 + 1;
        return `${sy}-${String(fm).padStart(2, '0')}`;
      })();
      const data = await fetchJson(`/api/marketing/rfm?from=${from}&to=${to}`);
      const segments = data.segments || [];
      if (!segments.length) {
        el.innerHTML = '<div style="color:var(--muted,#64748b);font-size:13px;padding:8px">Нет данных RFM за период.</div>';
        return;
      }
      // Палитра + эмодзи по имени сегмента
      const meta = {
        'VIP':           { emoji: '🏆', color: '#22c55e', desc: 'Часто, много, недавно' },
        'Постоянные':    { emoji: '💚', color: '#3b82f6', desc: 'Регулярные покупки' },
        'Уходящие VIP':  { emoji: '⚠️', color: '#f59e0b', desc: 'Были VIP, последний раз давно' },
        'Спящие':        { emoji: '😴', color: '#a855f7', desc: 'Не покупали последние месяцы' },
        'Прочие':        { emoji: '🟦', color: '#94a3b8', desc: 'Разовые / нерегулярные' },
      };
      const total = data.total || segments.reduce((s, x) => s + (x.count || 0), 0) || 1;
      const ordered = segments.slice().sort((a, b) => (b.monetary || 0) - (a.monetary || 0));
      el.innerHTML =
        `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">` +
        ordered.map(s => {
          const m = meta[s.segment] || { emoji: '🟦', color: '#94a3b8', desc: '' };
          const share = (s.count || 0) / total;
          const monetary = Number(s.monetary) || 0;
          const avg = Number(s.avgMonetary) || 0;
          return `<div style="padding:14px;border:1px solid var(--line,#e2e8f0);border-radius:10px;background:var(--paper,#fff);border-top:3px solid ${m.color}">
            <div style="font-size:24px">${m.emoji}</div>
            <div style="font-weight:600;color:${m.color}">${esc(s.segment)}</div>
            <div style="font-size:28px;font-weight:700;margin:4px 0" title="точно ${(s.count || 0).toLocaleString('ru-RU')} клиентов">${(s.count || 0).toLocaleString('ru-RU')}</div>
            <div style="font-size:12px;color:var(--muted,#64748b)">${fmtPct(share)} клиентов</div>
            <div style="font-size:11px;color:var(--muted,#64748b);margin-top:4px">${esc(m.desc)}</div>
            <div style="font-size:11px;color:var(--muted,#64748b);margin-top:4px" title="точные цифры: средний чек ${Math.round(avg).toLocaleString('ru-RU')} ₽ · общая выручка ${Math.round(monetary).toLocaleString('ru-RU')} ₽">Чек: ${fmtMoney(avg)} ₽ · Выручка ${fmtMoney(monetary)} ₽</div>
          </div>`;
        }).join('') +
        '</div>' +
        `<div style="font-size:11px;color:var(--muted,#64748b);margin-top:10px">Всего клиентов: ${total.toLocaleString('ru-RU')} · Период: ${from} … ${to} (6 мес). Наведи на цифру — точное значение в подсказке.</div>` +
        (data.topVIP && data.topVIP.length ? renderTopVip(data.topVIP) : '');
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red,#ef4444);font-size:13px;padding:8px">Не удалось загрузить RFM: ${esc(e.message)}</div>`;
    }
  }

  function renderTopVip(list) {
    const rows = list.slice(0, 10).map((v, i) => {
      const m = Number(v.monetary) || 0;
      return `<tr>
        <td>${i + 1}</td>
        <td>${esc(v.name || '')}</td>
        <td style="text-align:right" title="${m.toLocaleString('ru-RU')} ₽">${fmtMoney(m)} ₽</td>
        <td style="text-align:right">${(v.frequency || 0).toLocaleString('ru-RU')}</td>
      </tr>`;
    }).join('');
    return `<div style="margin-top:14px">
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">Топ-10 VIP клиентов</div>
      <div class="table-wrap"><table style="width:100%;font-size:13px">
        <thead><tr><th>#</th><th>Клиент</th><th style="text-align:right">Выручка</th><th style="text-align:right" title="Число чеков, не уникальных покупок">Чеков</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div style="font-size:11px;color:var(--muted,#64748b);margin-top:6px">Наведите на сумму — точная цифра в всплывающей подсказке. «Чеков» — число транзакций по карте за период.</div>
    </div>`;
  }

  // ─── Когорты ────────────────────────────────────────────────────────────────
  async function loadCohorts() {
    const el = document.getElementById('mktCohorts');
    if (!el) return;
    el.innerHTML = '<div class="muted" style="font-size:12px;padding:8px">Загрузка…</div>';
    try {
      const data = await fetchJson('/api/marketing/cohort-retention?months=6');
      const cohorts = data.cohorts || [];
      if (!cohorts.length) {
        el.innerHTML = '<div style="color:var(--muted,#64748b);font-size:13px;padding:8px">Нет данных для построения когорт.</div>';
        return;
      }
      // retention в API — массив объектов {offset, count, pct}. offset 0 = тот же месяц (100%).
      // Показываем +1..+6 мес (offset 1..6).
      const maxOffset = Math.max(0, ...cohorts.flatMap(c => (c.retention || []).map(r => r.offset)));
      const offsets = Array.from({ length: maxOffset }, (_, i) => i + 1);
      const head = '<tr><th>Месяц регистрации</th><th style="text-align:right">Новых карт</th>' +
        offsets.map(o => `<th style="text-align:center">+${o} мес</th>`).join('') + '</tr>';
      // Помечаем текущий месяц (последняя когорта) как «неполный» — у него нет
      // ещё ни одного «+1 мес» наблюдения, и пустые ячейки могут читаться как 0%.
      const currentMonth = (() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      })();
      const rows = cohorts.map(c => {
        const firstMonth = c.firstMonth || c.month || '';
        const isCurrent = firstMonth === currentMonth;
        const byOffset = new Map((c.retention || []).map(r => [r.offset, r]));
        const tds = offsets.map(o => {
          const r = byOffset.get(o);
          if (!r || r.pct == null) {
            // Если когорта = текущий месяц, ячейка «+1 мес» ещё не имеет смысла.
            return `<td style="color:var(--muted,#64748b);text-align:center" title="${isCurrent ? 'месяц ещё не закончился' : 'данных нет'}">${isCurrent ? '<span style="font-size:10px;opacity:.6">ожидается</span>' : '—'}</td>`;
          }
          const ratio = Math.max(0, Math.min(1, r.pct / 100));
          const bg = `hsl(${Math.round(120 * ratio)}deg 60% ${88 - ratio * 28}%)`;
          return `<td style="background:${bg};text-align:center;font-weight:600" title="${r.count?.toLocaleString('ru-RU') ?? 0} карт">${r.pct.toFixed(1)}%</td>`;
        }).join('');
        const label = firstMonth + (isCurrent ? ' <span style="font-size:10px;color:var(--amber,#f59e0b)">(не завершён)</span>' : '');
        return `<tr><td>${label}</td><td style="text-align:right">${(c.total || c.size || 0).toLocaleString('ru-RU')}</td>${tds}</tr>`;
      }).join('');
      el.innerHTML = `<div class="table-wrap"><table style="width:100%;font-size:13px"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red,#ef4444);font-size:13px;padding:8px">Не удалось загрузить когорты: ${esc(e.message)}</div>`;
    }
  }

  // ─── Зомби-товары ───────────────────────────────────────────────────────────
  async function loadZombie() {
    const el = document.getElementById('mktZombie');
    if (!el) return;
    el.innerHTML = '<div class="muted" style="font-size:12px;padding:8px">Загрузка…</div>';
    try {
      const data = await fetchJson(`/api/marketing/zombie-products?period=${currentPeriod()}`);
      const items = data.items || data || [];
      if (!items.length) {
        el.innerHTML = '<div style="color:var(--muted,#64748b);font-size:13px;padding:8px">Зомби-товары не найдены — все позиции активны.</div>';
        return;
      }
      const rows = items.slice(0, 25).map((it, i) => `<tr>
        <td>${i + 1}</td>
        <td>${esc(it.name || it.productName)}</td>
        <td style="text-align:right">${fmtMoney(it.curRevenue || it.cur || 0)} ₽</td>
        <td style="text-align:right">${fmtMoney(it.prevRevenue || it.prev || 0)} ₽</td>
        <td style="text-align:right;color:${(it.share || it.ratio || 0) < 0.05 ? 'var(--red,#ef4444)' : 'var(--amber,#f59e0b)'}">${fmtPct(it.share ?? it.ratio ?? 0)}</td>
      </tr>`).join('');
      el.innerHTML = `<table style="width:100%;font-size:13px">
        <thead><tr><th>#</th><th>Товар</th><th>Сейчас</th><th>Раньше</th><th>Доля</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red,#ef4444);font-size:13px;padding:8px">Не удалось загрузить: ${esc(e.message)}</div>`;
    }
  }

  // ─── Каннибализация скидок ──────────────────────────────────────────────────
  async function loadCanniba() {
    const el = document.getElementById('mktCanniba');
    if (!el) return;
    el.innerHTML = '<div class="muted" style="font-size:12px;padding:8px">Загрузка…</div>';
    try {
      const p = currentPeriod();
      const data = await fetchJson(`/api/marketing/discount-cannibalization?from=${p}&to=${p}`);
      const items = data.pairs || data.items || [];
      if (!items.length) {
        el.innerHTML = '<div style="color:var(--muted,#64748b);font-size:13px;padding:8px">Явной каннибализации не выявлено за период.</div>';
        return;
      }
      const rows = items.slice(0, 20).map((p, i) => `<tr>
        <td>${i + 1}</td>
        <td>${esc(p.promo || p.aName)}</td>
        <td>${esc(p.victim || p.bName)}</td>
        <td style="text-align:right;color:var(--red,#ef4444)">${fmtPct(p.impact || p.correlation || 0)}</td>
      </tr>`).join('');
      el.innerHTML = `<table style="width:100%;font-size:13px">
        <thead><tr><th>#</th><th>Акция на</th><th>«Жертва»</th><th>Импакт</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red,#ef4444);font-size:13px;padding:8px">Не удалось загрузить: ${esc(e.message)}</div>`;
    }
  }

  // ─── Кластеры точек ─────────────────────────────────────────────────────────
  async function loadClusters() {
    const el = document.getElementById('mktClusters');
    if (!el) return;
    el.innerHTML = '<div class="muted" style="font-size:12px;padding:8px">Загрузка…</div>';
    try {
      const data = await fetchJson(`/api/marketing/store-clusters?period=${currentPeriod()}`);
      const clusters = data.clusters || [];
      if (!clusters.length) {
        el.innerHTML = '<div style="color:var(--muted,#64748b);font-size:13px;padding:8px">Нет данных для кластеризации.</div>';
        return;
      }
      const toneColors = { good: '#22c55e', warn: '#f59e0b', bad: '#ef4444', neutral: '#3b82f6' };
      el.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px">' +
        clusters.map((cl, i) => {
          const color = toneColors[cl.tone] || toneColors.neutral;
          const stores = cl.stores || [];
          const avg = cl.avg || {};
          const totalFact = stores.reduce((s, x) => s + (Number(x.fact) || 0), 0);
          return `<div style="padding:12px;border:1px solid var(--line,#e2e8f0);border-radius:10px;border-left:4px solid ${color}">
            <div style="font-weight:600;margin-bottom:6px">${esc(cl.name || `Кластер ${i + 1}`)}</div>
            <div style="font-size:11px;color:var(--muted,#64748b);margin-bottom:8px" title="точно ${Math.round(totalFact).toLocaleString('ru-RU')} ₽">${cl.count ?? stores.length} точек · ${fmtMoney(totalFact)} ₽ суммарно</div>
            <div style="font-size:12px;color:var(--muted,#64748b)">Сред. чек: ${fmtMoney(avg.avgCheck || 0)} ₽</div>
            ${avg.marginPct != null ? `<div style="font-size:12px;color:var(--muted,#64748b)">Маржа: ${avg.marginPct > 0.5 ? avg.marginPct.toFixed(1) + '%' : '<span title="1С не передала cost для этих точек">н/д</span>'}</div>` : ''}
            ${avg.pctCompletion != null ? `<div style="font-size:12px;color:var(--muted,#64748b)">Выполн. плана: ${avg.pctCompletion.toFixed(1)}%</div>` : ''}
            <div style="font-size:11px;margin-top:6px;color:var(--muted,#64748b)">${stores.slice(0, 5).map(s => esc(s.storeName || s.name || '')).join(', ')}${stores.length > 5 ? '…' : ''}</div>
          </div>`;
        }).join('') + '</div>';
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red,#ef4444);font-size:13px;padding:8px">Не удалось загрузить: ${esc(e.message)}</div>`;
    }
  }

  // ─── Праздники YoY ──────────────────────────────────────────────────────────
  async function loadHoliday() {
    const el = document.getElementById('mktHoliday');
    if (!el) return;
    el.innerHTML = '<div class="muted" style="font-size:12px;padding:8px">Загрузка…</div>';
    try {
      const data = await fetchJson('/api/marketing/holiday-yoy?window=60');
      const next = data.next || data.holiday;
      if (!next) {
        el.innerHTML = '<div style="color:var(--muted,#64748b);font-size:13px;padding:8px">Ближайший праздник в окне не найден.</div>';
        return;
      }
      const yoyPct = next.yoy != null ? next.yoy : (next.lastYearShare != null ? next.lastYearShare : null);
      const trend = yoyPct == null ? '' : (yoyPct >= 0 ? '↑' : '↓');
      const color = yoyPct == null ? 'var(--muted)' : (yoyPct >= 0 ? 'var(--green,#22c55e)' : 'var(--red,#ef4444)');
      el.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div style="padding:14px;border:1px solid var(--line,#e2e8f0);border-radius:10px">
          <div style="font-size:12px;color:var(--muted,#64748b)">Ближайший праздник</div>
          <div style="font-size:20px;font-weight:600;margin-top:4px">${esc(next.name || '—')}</div>
          <div style="font-size:13px;color:var(--muted,#64748b);margin-top:2px">${esc(next.date || '')}</div>
        </div>
        <div style="padding:14px;border:1px solid var(--line,#e2e8f0);border-radius:10px">
          <div style="font-size:12px;color:var(--muted,#64748b)">Выручка в прошлом году</div>
          <div style="font-size:20px;font-weight:600;margin-top:4px">${fmtMoney(next.prevRevenue || next.lastYearRevenue || 0)} ₽</div>
        </div>
        <div style="padding:14px;border:1px solid var(--line,#e2e8f0);border-radius:10px">
          <div style="font-size:12px;color:var(--muted,#64748b)">YoY-прирост</div>
          <div style="font-size:20px;font-weight:600;margin-top:4px;color:${color}">${trend} ${fmtPct(yoyPct ?? 0)}</div>
        </div>
      </div>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red,#ef4444);font-size:13px;padding:8px">Не удалось загрузить: ${esc(e.message)}</div>`;
    }
  }

  // ─── 2ГИС тренд рейтингов ───────────────────────────────────────────────────
  async function loadGisHistory() {
    const el = document.getElementById('mktGisHistory');
    if (!el) return;
    el.innerHTML = '<div class="muted" style="font-size:12px;padding:8px">Загрузка…</div>';
    try {
      const data = await fetchJson('/api/marketing/2gis-ratings-history');
      const entries = data.entries || [];
      if (!entries.length) {
        el.innerHTML = '<div style="color:var(--muted,#64748b);font-size:13px;padding:8px">Архив пока пуст. Первый снимок появится завтра после cron 7:00.</div>';
        return;
      }
      // Группируем по ID точки (а не по адресу): у master-карточек 2ГИС address=null,
      // но рейтинг есть — мы их теряли. Теперь показываем всех с rating != null.
      const byId = new Map();
      for (const e of entries) {
        for (const b of (e.branches || [])) {
          if (b.rating == null) continue;
          const key = b.id;
          if (!byId.has(key)) byId.set(key, { id: b.id, address: b.address, history: [] });
          const rec = byId.get(key);
          if (!rec.address && b.address) rec.address = b.address; // подхватим, если в другой день распарсилось
          rec.history.push({ date: e.date, rating: b.rating, ratingCount: b.ratingCount });
        }
      }
      if (!byId.size) {
        el.innerHTML = '<div style="color:var(--muted,#64748b);font-size:13px;padding:8px">Точек с рейтингом ещё нет в архиве.</div>';
        return;
      }
      // Таблица: рейтинг + delta vs первый снимок.
      const rows = [...byId.values()].sort((a, b) => {
        const lastA = a.history[a.history.length - 1].rating;
        const lastB = b.history[b.history.length - 1].rating;
        return lastB - lastA;
      }).map(rec => {
        rec.history.sort((a, b) => a.date.localeCompare(b.date));
        const last = rec.history[rec.history.length - 1].rating;
        const lastCount = rec.history[rec.history.length - 1].ratingCount;
        const first = rec.history[0].rating;
        const delta = rec.history.length > 1 ? last - first : null;
        const trend = delta == null ? '' :
          delta > 0.05 ? `<span style="color:var(--green,#22c55e)">↑ +${delta.toFixed(2)}</span>` :
          delta < -0.05 ? `<span style="color:var(--red,#ef4444)">↓ ${delta.toFixed(2)}</span>` :
          '<span style="color:var(--muted,#64748b)">→</span>';
        const addrCell = rec.address
          ? esc(rec.address)
          : `<span style="color:var(--muted,#64748b)">(без адреса) <code style="font-size:11px">${esc(rec.id)}</code></span>`;
        return `<tr>
          <td>${addrCell}</td>
          <td style="text-align:right;font-weight:600">${last.toFixed(2)}</td>
          <td style="text-align:right;color:var(--muted,#64748b)">${lastCount != null ? lastCount.toLocaleString('ru-RU') : '—'}</td>
          <td style="text-align:right">${rec.history.length}</td>
          <td>${trend}</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<div class="table-wrap"><table style="width:100%;font-size:13px">
        <thead><tr><th>Адрес / ID</th><th style="text-align:right">Рейтинг</th><th style="text-align:right">Оценок</th><th style="text-align:right">Снимков</th><th>Тренд</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div style="font-size:11px;color:var(--muted,#64748b);margin-top:8px">Точек с рейтингом: ${byId.size} · Снимков в архиве: ${entries.length} (за ${entries[0].date} … ${entries[entries.length - 1].date})</div>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red,#ef4444);font-size:13px;padding:8px">Не удалось загрузить: ${esc(e.message)}</div>`;
    }
  }

  // ─── SEO: расширенная аналитика поверх mktSeo ───────────────────────────────
  async function loadSeoExtra() {
    const el = document.getElementById('mktSeoExtra');
    if (!el) return;
    el.innerHTML = '<div class="muted" style="font-size:12px;padding:8px">Загрузка…</div>';
    try {
      const data = await fetchJson('/api/marketing/seo-history');
      const entries = data.entries || [];
      if (!entries.length) {
        el.innerHTML = '<div style="color:var(--muted,#64748b);font-size:13px;padding:8px">Архив SEO пока пуст. Появится после первого ежедневного снимка (cron 7:00).</div>';
        return;
      }
      const latest = entries[entries.length - 1];
      const sum = latest.summary || {};

      // Сравнение 5 брендов. Поддерживаем оба формата:
      //   новый: summary[brand] = {top10, top3, found, avg}
      //   старый (до 04.06.2026): summary.{maria,stefania}Top10 / avgRank{Maria,Stefania}
      // Старый формат содержит данные только по maria и stefania → остальные карточки не показываем,
      // чтобы не врать нулями.
      const brands = [
        { key: 'maria',    name: 'Мария',     color: '#22c55e' },
        { key: 'stefania', name: 'Стефания',  color: '#3b82f6' },
        { key: 'cakehome', name: 'Cake Home', color: '#a855f7' },
        { key: 'etika',    name: 'Этика',     color: '#f59e0b' },
        { key: 'yahont',   name: 'Яхонт',     color: '#ef4444' },
      ];
      function brandStats(brandKey) {
        const v = sum[brandKey];
        if (v && typeof v === 'object') return v; // новый формат
        if (brandKey === 'maria' && sum.mariaTop10 != null) {
          return { top10: sum.mariaTop10, avg: sum.avgRankMaria ?? null, top3: null, found: null, _legacy: true };
        }
        if (brandKey === 'stefania' && sum.stefaniaTop10 != null) {
          return { top10: sum.stefaniaTop10, avg: sum.avgRankStefania ?? null, top3: null, found: null, _legacy: true };
        }
        return null;
      }
      const brandCards = brands.map(b => {
        const v = brandStats(b.key);
        if (!v) return '';
        const fmtNum = n => n == null ? '—' : n;
        return `<div style="padding:12px;border:1px solid var(--line,#e2e8f0);border-radius:10px;border-top:3px solid ${b.color}">
          <div style="font-weight:600;color:${b.color}">${esc(b.name)}</div>
          <div style="font-size:24px;font-weight:700;margin:4px 0">${v.top10 ?? 0} <span style="font-size:12px;color:var(--muted,#64748b);font-weight:400">в топ-10</span></div>
          <div style="font-size:12px;color:var(--muted,#64748b)">Топ-3: ${fmtNum(v.top3)}</div>
          <div style="font-size:12px;color:var(--muted,#64748b)">Найден в выдаче: ${fmtNum(v.found)} запросов</div>
          <div style="font-size:12px;color:var(--muted,#64748b)">Сред. позиция: ${v.avg != null ? v.avg.toFixed(1) : '—'}</div>
          ${v._legacy ? '<div style="font-size:10px;color:var(--amber,#f59e0b);margin-top:4px" title="Старый формат скрейпа без top-3 и количества найденных">формат до 04.06</div>' : ''}
        </div>`;
      }).join('');

      // По категориям
      const catLabels = {
        main: 'Основные',
        'cake-type': 'Виды тортов',
        occasion: 'Случаи (свадебный/детский)',
        dessert: 'Десерты',
        coffee: 'Кофе и кафе',
        geo: 'По районам',
        brand: 'Брендовые',
        other: 'Прочее',
      };
      const catRows = (latest.byCategory || []).sort((a, b) => (a.avgRankMaria ?? 99) - (b.avgRankMaria ?? 99)).map(c => `<tr>
        <td>${esc(catLabels[c.cat] || c.cat)}</td>
        <td style="text-align:right">${c.total}</td>
        <td style="text-align:right">${c.mariaInTop10}</td>
        <td style="text-align:right">${c.avgRankMaria != null ? c.avgRankMaria.toFixed(1) : '—'}</td>
        <td style="text-align:right;color:${c.captcha ? 'var(--amber,#f59e0b)' : 'var(--muted,#64748b)'}">${c.captcha || 0}</td>
      </tr>`).join('');

      // Тренд средней позиции Маши по снимкам — поддерживаем оба формата summary.
      const trendRows = entries.map(e => {
        const s = e.summary || {};
        const avg = s.maria?.avg ?? s.avgRankMaria ?? null;
        const top10 = s.maria?.top10 ?? s.mariaTop10 ?? null;
        return { date: e.date, avg, top10, captcha: e.captchaCount ?? null };
      });
      const validTrend = trendRows.filter(t => t.avg != null);
      let trendBlock = '';
      if (validTrend.length >= 2) {
        const first = validTrend[0].avg;
        const last = validTrend[validTrend.length - 1].avg;
        const delta = last - first;
        const trendColor = delta < -0.2 ? 'var(--green,#22c55e)' : delta > 0.2 ? 'var(--red,#ef4444)' : 'var(--muted,#64748b)';
        const arrow = delta < -0.2 ? '↑ позиции выросли' : delta > 0.2 ? '↓ позиции упали' : '→ без изменений';
        trendBlock = `<div style="margin-top:14px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--paper,#fff)">
          <div style="font-weight:600;font-size:13px;margin-bottom:8px">Динамика средней позиции «Мария»</div>
          <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap">
            <div style="font-size:24px;font-weight:700;color:${trendColor}">${last.toFixed(1)} <span style="font-size:13px;font-weight:400;color:${trendColor}">${arrow} (${delta > 0 ? '+' : ''}${delta.toFixed(1)})</span></div>
            <div style="font-size:11px;color:var(--muted,#64748b)">было ${first.toFixed(1)} (${validTrend[0].date}) → стало ${last.toFixed(1)} (${validTrend[validTrend.length - 1].date})</div>
          </div>
        </div>`;
      } else {
        trendBlock = `<div style="margin-top:14px;padding:10px;border:1px dashed var(--line);border-radius:10px;color:var(--muted,#64748b);font-size:12px">Тренд появится после второго еженедельного снимка. Сейчас в архиве: ${entries.length}.</div>`;
      }

      el.innerHTML =
        `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px">${brandCards}</div>` +
        `<div style="font-weight:600;font-size:13px;margin-bottom:6px">Позиции Марии по группам запросов</div>` +
        `<div class="table-wrap"><table style="width:100%;font-size:13px">
          <thead><tr><th>Группа</th><th style="text-align:right">Запросов</th><th style="text-align:right">В топ-10</th><th style="text-align:right">Сред. позиция</th><th style="text-align:right" title="Сколько запросов в группе вернули капчу">⚠ Капча</th></tr></thead>
          <tbody>${catRows || '<tr><td colspan="5" style="color:var(--muted,#64748b);padding:8px">Нет данных по категориям — последний скрейп ещё на старой версии (15 запросов). Перезапустится в понедельник по cron.</td></tr>'}</tbody>
        </table></div>` +
        trendBlock +
        `<div style="font-size:11px;color:var(--muted,#64748b);margin-top:10px">Источник: Яндекс SERP, регион Иркутск (lr=63), скрейп еженедельно (пн 4:00). Капчи неизбежны при текущей анти-бот защите Яндекса. <code>scrape-seo.js</code> на VDS.</div>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red,#ef4444);font-size:13px;padding:8px">Не удалось загрузить SEO: ${esc(e.message)}</div>`;
    }
  }

  // ─── Платные каналы → SMS: тексты рассылок + аудитория ────────────────────
  // app.js renderPaidCosts() показывает SMS одной строкой ("X уник. получателей").
  // Чтобы не трогать app.js (правит параллельная сессия) — после рендера ищем строку
  // SMS в #mktPaidLive и вставляем под неё раскрывающийся блок с текстом каждой
  // рассылки + критерием отбора из 1С.
  // (Сегменты VIP/акт/спящ/хол и ответственный убраны по просьбе Маши 04.06.2026 —
  // sms-audience всё ещё дёргаем: из него берётся критерий.)
  // Используем MutationObserver: app.js может перерендерить таблицу несколько раз
  // (live-обновления, переключение периода) — каждый раз перевставляем нашу строку.
  let paidSmsState = { html: null, lastPeriod: null };

  async function fetchPaidSmsData(period) {
    if (paidSmsState.lastPeriod === period && paidSmsState.html) return paidSmsState.html;
    let sa, aud;
    try { sa = await fetchJson('/api/marketing/sms-attribution?period=' + period); } catch (_) { return null; }
    try { aud = await fetchJson('/api/marketing/sms-audience?period=' + period); } catch (_) { aud = null; }
    const camps = (sa && sa.campaigns) || [];
    if (!camps.length) return null;
    const critMap = new Map();
    for (const a of (aud?.campaigns || [])) {
      const k = a.firstDate + '|' + (a.text || '').slice(0, 50);
      critMap.set(k, a.criterion);
    }
    const typeLabel = { 'A': 'продукт+срок', 'A*': 'всё+срок', 'B': 'ссылка', 'C': 'оценка' };
    const critCell = (criterion) => {
      if (!criterion) return '';
      return `<div style="margin-top:4px;font-size:10px;color:#0369a1" title="Критерий отбора из карточки SMS в 1С (СодержаниеТемыSMS)">🎯 <b>Критерий:</b> ${esc(criterion)}</div>`;
    };
    const rowsHtml = camps.map(c => {
      const k = c.firstDate + '|' + (c.text || '').slice(0, 50);
      return `<tr>
        <td style="white-space:nowrap;color:var(--muted,#64748b);vertical-align:top">${esc(c.firstDate || '')}</td>
        <td style="text-align:right;vertical-align:top">${(c.recipients || 0).toLocaleString('ru-RU')}</td>
        <td style="vertical-align:top"><span style="font-size:10px;color:var(--muted,#64748b)">${esc(typeLabel[c.type] || c.type || '')}</span></td>
        <td style="font-size:11px;vertical-align:top">
          <div>${esc(c.text || '')}</div>
          ${critCell(critMap.get(k))}
        </td>
      </tr>`;
    }).join('');
    const inner = `<details style="padding:8px 12px">
      <summary style="cursor:pointer;font-size:12px;color:#555">📝 Содержание рассылок за месяц (${camps.length})</summary>
      <div style="margin-top:8px;overflow-x:auto"><table style="width:100%;font-size:11px;border-collapse:collapse">
        <thead><tr style="border-bottom:1px solid #e2e8f0"><th style="text-align:left;padding:4px">Дата</th><th style="text-align:right;padding:4px">Получ.</th><th style="text-align:left;padding:4px">Тип</th><th style="text-align:left;padding:4px">Текст</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>
    </details>`;
    paidSmsState = { html: inner, lastPeriod: period };
    return inner;
  }

  function insertSmsRowIfNeeded(container, innerHtml) {
    const tbody = container.querySelector('table tbody');
    if (!tbody) return false;
    const smsRow = Array.from(tbody.querySelectorAll('tr')).find(r => /SMS-рассылки/i.test(r.textContent || ''));
    if (!smsRow) return false;
    if (smsRow.nextElementSibling?.classList.contains('sms-texts-row')) return true; // уже вставлена
    const colCount = smsRow.children.length || 5;
    const insertRow = document.createElement('tr');
    insertRow.className = 'sms-texts-row';
    insertRow.innerHTML = `<td colspan="${colCount}" style="padding:0;background:#fafafa">${innerHtml}</td>`;
    smsRow.parentNode.insertBefore(insertRow, smsRow.nextSibling);
    return true;
  }

  async function enrichPaidSms() {
    const container = document.getElementById('mktPaidLive');
    if (!container) return;
    const period = currentPeriod();
    const inner = await fetchPaidSmsData(period);
    if (inner) insertSmsRowIfNeeded(container, inner);
    if (!container.__smsObserverArmed) {
      let fetching = false;
      const refresh = async () => {
        const p = currentPeriod();
        if (paidSmsState.lastPeriod === p && paidSmsState.html) {
          insertSmsRowIfNeeded(container, paidSmsState.html);
          return;
        }
        if (fetching) return;
        fetching = true;
        try {
          const html = await fetchPaidSmsData(p);
          if (html) insertSmsRowIfNeeded(container, html);
        } finally { fetching = false; }
      };
      const obs = new MutationObserver(refresh);
      obs.observe(container, { childList: true, subtree: true });
      container.__smsObserverArmed = true;
    }
  }

  // ─── SMS-атрибуция → критерий отбора ────────────────────────────────────────
  // app.js рисует таблицу #mktSmsAttr (Рассылка/Оффер/Получ./Купили/.../Затраты).
  // Дополняем: в КАЖДУЮ строку под текст добавляем критерий отбора из 1С.
  // Данные из sms-audience, мапим по «DD.MM.YYYY + первые 50 символов текста».
  // (Сегменты VIP/акт/спящ/хол и ответственный убраны по просьбе Маши 04.06.2026.)
  let smsAttrState = { audMap: null, lastPeriod: null };

  async function fetchSmsAudMap(period) {
    if (smsAttrState.lastPeriod === period && smsAttrState.audMap) return smsAttrState.audMap;
    let aud;
    try { aud = await fetchJson('/api/marketing/sms-audience?period=' + period); } catch (_) { return null; }
    const map = new Map();
    for (const a of (aud?.campaigns || [])) {
      const key = a.firstDate + '|' + (a.text || '').slice(0, 50);
      map.set(key, { criterion: a.criterion });
    }
    smsAttrState = { audMap: map, lastPeriod: period };
    return map;
  }

  function injectSmsAttrAudience(container, audMap) {
    const tbody = container.querySelector('table tbody');
    if (!tbody) return false;
    let injected = 0;
    Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
      if (tr.classList.contains('mkt-total')) return;
      const firstCell = tr.querySelector('td');
      if (!firstCell) return;
      // не вставлять повторно
      if (firstCell.querySelector('.sms-aud-line')) return;
      const divs = firstCell.querySelectorAll('div');
      if (divs.length < 2) return; // ожидаем: div(дата) + div(текст)
      const dateDiv = divs[0];
      const textDiv = divs[1];
      const dateMatch = /\d{2}\.\d{2}\.\d{4}/.exec(dateDiv.textContent || '');
      const textRaw = (textDiv.textContent || '').trim();
      if (!dateMatch || !textRaw) return;
      const key = dateMatch[0] + '|' + textRaw.slice(0, 50);
      const entry = audMap.get(key) || {};
      // Критерий отбора из 1С (СодержаниеТемыSMS)
      if (entry.criterion) {
        const cr = document.createElement('div');
        cr.className = 'sms-aud-line sms-crit-line';
        cr.style.cssText = 'font-size:10px;margin-top:4px;color:#0369a1';
        cr.setAttribute('title', 'Критерий отбора из 1С (СодержаниеТемыSMS)');
        cr.innerHTML = `🎯 <b>Критерий:</b> ${entry.criterion.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}`;
        firstCell.appendChild(cr);
        injected++;
      }
    });
    return injected > 0;
  }

  async function enrichSmsAttrAudience() {
    const container = document.getElementById('mktSmsAttr');
    if (!container) return;
    const period = currentPeriod();
    const audMap = await fetchSmsAudMap(period);
    if (audMap) injectSmsAttrAudience(container, audMap);
    if (!container.__smsAttrObserverArmed) {
      let fetching = false;
      const refresh = async () => {
        const p = currentPeriod();
        const have = smsAttrState.lastPeriod === p && smsAttrState.audMap;
        if (have) { injectSmsAttrAudience(container, smsAttrState.audMap); return; }
        if (fetching) return;
        fetching = true;
        try {
          const m = await fetchSmsAudMap(p);
          if (m) injectSmsAttrAudience(container, m);
        } finally { fetching = false; }
      };
      const obs = new MutationObserver(refresh);
      obs.observe(container, { childList: true, subtree: true });
      container.__smsAttrObserverArmed = true;
    }
  }

  // ─── Запуск ─────────────────────────────────────────────────────────────────
  // Триггеримся когда пользователь открывает соответствующую секцию маркетинг-таба.
  // Дешевле, чем грузить всё сразу: каждый блок прячется CSS-классом hidden до клика.
  function loadAll() {
    loadRfm();
    loadCohorts();
    loadZombie();
    loadCanniba();
    loadClusters();
    loadHoliday();
    loadGisHistory();
    loadSeoExtra();
    enrichPaidSms();
    enrichSmsAttrAudience();
  }

  function tryHook() {
    // Активный таб «Маркетинг» — грузим один раз при первом открытии.
    let loaded = false;
    function onTabSwitch() {
      const mkt = document.getElementById('page-marketing');
      if (mkt && !mkt.classList.contains('hidden') && !loaded) {
        loaded = true;
        loadAll();
      }
    }
    // Главная нав-кнопка маркетинг-таба — .nav-btn с data-page="marketing".
    // (раньше слушали по тексту «маркетинг» — работает, но ломается при ребрендинге).
    document.querySelectorAll('.nav-btn[data-page="marketing"]').forEach(btn => {
      btn.addEventListener('click', () => setTimeout(onTabSwitch, 200));
    });
    // Если страница загружена и маркетинг уже активен — грузим сразу
    onTabSwitch();
    // На переключение mgroup (под-вкладки) — не грузим заново; данные уже есть.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryHook);
  } else {
    tryHook();
  }
})();
