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
          return `<div style="padding:14px;border:1px solid var(--line,#e2e8f0);border-radius:10px;background:var(--paper,#fff);border-top:3px solid ${m.color}">
            <div style="font-size:24px">${m.emoji}</div>
            <div style="font-weight:600;color:${m.color}">${esc(s.segment)}</div>
            <div style="font-size:28px;font-weight:700;margin:4px 0">${(s.count || 0).toLocaleString('ru-RU')}</div>
            <div style="font-size:12px;color:var(--muted,#64748b)">${fmtPct(share)} клиентов</div>
            <div style="font-size:11px;color:var(--muted,#64748b);margin-top:4px">${esc(m.desc)}</div>
            <div style="font-size:11px;color:var(--muted,#64748b);margin-top:4px">Чек: ${fmtMoney(s.avgMonetary || 0)} ₽ · Выручка ${fmtMoney(s.monetary || 0)} ₽</div>
          </div>`;
        }).join('') +
        '</div>' +
        `<div style="font-size:11px;color:var(--muted,#64748b);margin-top:10px">Всего клиентов: ${total.toLocaleString('ru-RU')} · Период: ${from} … ${to} (6 мес)</div>` +
        (data.topVIP && data.topVIP.length ? renderTopVip(data.topVIP) : '');
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red,#ef4444);font-size:13px;padding:8px">Не удалось загрузить RFM: ${esc(e.message)}</div>`;
    }
  }

  function renderTopVip(list) {
    const rows = list.slice(0, 10).map((v, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(v.name || '')}</td>
      <td style="text-align:right">${fmtMoney(v.monetary || 0)} ₽</td>
      <td style="text-align:right">${(v.frequency || 0).toLocaleString('ru-RU')}</td>
    </tr>`).join('');
    return `<div style="margin-top:14px">
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">Топ-10 VIP клиентов</div>
      <div class="table-wrap"><table style="width:100%;font-size:13px">
        <thead><tr><th>#</th><th>Клиент</th><th style="text-align:right">Выручка</th><th style="text-align:right">Покупок</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
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
      const rows = cohorts.map(c => {
        const byOffset = new Map((c.retention || []).map(r => [r.offset, r]));
        const tds = offsets.map(o => {
          const r = byOffset.get(o);
          if (!r || r.pct == null) return '<td style="color:var(--muted,#64748b);text-align:center">—</td>';
          const ratio = Math.max(0, Math.min(1, r.pct / 100));
          const bg = `hsl(${Math.round(120 * ratio)}deg 60% ${88 - ratio * 28}%)`;
          return `<td style="background:${bg};text-align:center;font-weight:600" title="${r.count?.toLocaleString('ru-RU') ?? 0} карт">${r.pct.toFixed(1)}%</td>`;
        }).join('');
        return `<tr><td>${esc(c.firstMonth || c.month || '')}</td><td style="text-align:right">${(c.total || c.size || 0).toLocaleString('ru-RU')}</td>${tds}</tr>`;
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
            <div style="font-size:11px;color:var(--muted,#64748b);margin-bottom:8px">${cl.count ?? stores.length} точек · ${fmtMoney(totalFact)} ₽ суммарно</div>
            <div style="font-size:12px;color:var(--muted,#64748b)">Сред. чек: ${fmtMoney(avg.avgCheck || 0)} ₽</div>
            ${avg.marginPct != null ? `<div style="font-size:12px;color:var(--muted,#64748b)">Маржа: ${avg.marginPct.toFixed(1)}%</div>` : ''}
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
      // Сгруппировать по точке: { address: [{date, rating}] }
      const byAddr = new Map();
      for (const e of entries) {
        for (const b of (e.branches || [])) {
          if (!b.address || b.rating == null) continue;
          if (!byAddr.has(b.address)) byAddr.set(b.address, []);
          byAddr.get(b.address).push({ date: e.date, rating: b.rating });
        }
      }
      if (!byAddr.size) {
        el.innerHTML = '<div style="color:var(--muted,#64748b);font-size:13px;padding:8px">В архиве пока только снимки без распарсенных адресов.</div>';
        return;
      }
      // Таблица с последним рейтингом + стрелочкой если есть ≥2 точки в архиве.
      const rows = [...byAddr.entries()].map(([addr, arr]) => {
        arr.sort((a, b) => a.date.localeCompare(b.date));
        const last = arr[arr.length - 1].rating;
        const first = arr[0].rating;
        const delta = arr.length > 1 ? last - first : null;
        const trend = delta == null ? '' : (delta > 0.05 ? `<span style="color:var(--green,#22c55e)">↑ +${delta.toFixed(2)}</span>` : delta < -0.05 ? `<span style="color:var(--red,#ef4444)">↓ ${delta.toFixed(2)}</span>` : '<span style="color:var(--muted,#64748b)">→</span>');
        return `<tr>
          <td>${esc(addr)}</td>
          <td style="text-align:right;font-weight:600">${last.toFixed(2)}</td>
          <td style="text-align:right">${arr.length}</td>
          <td>${trend}</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<div class="table-wrap"><table style="width:100%;font-size:13px">
        <thead><tr><th>Адрес</th><th>Текущий</th><th>Снимков</th><th>Тренд</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div style="font-size:11px;color:var(--muted,#64748b);margin-top:8px">Снимков в архиве: ${entries.length} (за ${entries[0].date} … ${entries[entries.length - 1].date})</div>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red,#ef4444);font-size:13px;padding:8px">Не удалось загрузить: ${esc(e.message)}</div>`;
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
    document.querySelectorAll('.nav-btn').forEach(btn => {
      if (/маркетинг/i.test(btn.textContent || '')) btn.addEventListener('click', () => setTimeout(onTabSwitch, 200));
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
