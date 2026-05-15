// Реактивные Telegram-алерты — реагируют на критичные состояния, в отличие
// от morning-report (который шлёт всегда в 09:00 МСК).
//
// Запускается каждый час, отправляет алерт если есть И не отправляли его
// сегодня (антиспам — 1 алерт каждого типа в сутки).

const https = require('https');
const { aggregateDashboard, monthKey } = require('./analytics');
const { nowInIrk } = require('./calendar-irk');

const TZ_OFFSET_MS = 8 * 3600 * 1000;

function fmt(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value || 0);
}

function sendTelegram(token, chatId, text) {
  const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

// Сколько факт за указанный день у магазинов (карта storeId → fact)
function factByStoreOnDate(sales, period, dateIrk) {
  const result = new Map();
  const y = dateIrk.getUTCFullYear();
  const m = dateIrk.getUTCMonth();
  const d = dateIrk.getUTCDate();
  for (const s of sales) {
    if (s.period !== period) continue;
    if (!s.soldAt) continue;
    const t = new Date(new Date(s.soldAt).getTime() + TZ_OFFSET_MS);
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m || t.getUTCDate() !== d) continue;
    const sid = s.storeId || s.store_id;
    result.set(sid, (result.get(sid) || 0) + Number(s.amount || 0));
  }
  return result;
}

// ─── Алерт 1: магазины с 0₽ за вчерашний день ───────────────────────────
async function checkZeroSalesStores(store, sent) {
  const today = sent.todayKey;
  if (sent.zero === today) return null;

  const irk = nowInIrk();
  const yesterday = new Date(irk.getTime() - 24 * 3600 * 1000);
  const period = monthKey(`${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}`);

  const db = await store.getDb();
  const summary = aggregateDashboard(db, period);
  const yFact = factByStoreOnDate(db.sales || [], period, yesterday);

  // Магазины с плановой ненулевой выручкой, но факт 0 за весь день
  // (исключаем выходные магазины — у которых нет факта последние 3 дня → видимо не работает регулярно)
  const dead = summary.stores
    .filter((s) => s.plan > 0 && !(yFact.get(s.storeId) > 0));
  if (!dead.length) return null;

  const lines = dead.slice(0, 10).map((s) => `• ${s.storeName}`);
  sent.zero = today;
  return `🔴 <b>Магазины без продаж за вчера (${yesterday.getUTCDate()}.${String(yesterday.getUTCMonth() + 1).padStart(2, '0')})</b>\n${lines.join('\n')}\n\nПроверьте, всё ли с ними в порядке.`;
}

// ─── Алерт 2: план под угрозой провала ───────────────────────────────────
async function checkPlanAtRisk(store, sent) {
  const today = sent.todayKey;
  if (sent.risk === today) return null;
  // Шлём не чаще раза в 3 дня
  if (sent.riskCooldownUntil && Date.now() < sent.riskCooldownUntil) return null;

  const irk = nowInIrk();
  const period = monthKey(`${irk.getUTCFullYear()}-${String(irk.getUTCMonth() + 1).padStart(2, '0')}`);
  const db = await store.getDb();
  const summary = aggregateDashboard(db, period);
  const f = summary.forecast || {};
  const t = summary.totals || {};

  if (!t.plan || t.plan === 0) return null;
  if ((f.remainingDays || 0) > 10) return null; // далеко до конца месяца — не паникуем

  // Шлём только если прогноз < 90% плана И есть смысл напрячься
  if (!f.projectedCompletion || f.projectedCompletion >= 90) return null;

  sent.risk = today;
  sent.riskCooldownUntil = Date.now() + 3 * 24 * 3600 * 1000;
  return `⚠️ <b>План ${period} под угрозой провала</b>\n` +
    `Выполнено: ${t.completion}% (${fmt(t.fact)} ₽ из ${fmt(t.plan)} ₽)\n` +
    `Прогноз на конец месяца: <b>${f.projectedCompletion}%</b> · разрыв ${fmt(f.runwayGap)} ₽\n` +
    `Осталось ${f.remainingDays} дн. — нужно ${fmt(f.requiredPerDayToPlan)} ₽/день\n\n` +
    `Срочно усилить отстающие точки.`;
}

// ─── Алерт 3: всплеск возвратов за 7 дней ────────────────────────────────
async function checkReturnsSpike(store, sent) {
  const today = sent.todayKey;
  if (sent.returns === today) return null;

  const irk = nowInIrk();
  const cutoff = new Date(irk.getTime() - 7 * 24 * 3600 * 1000);

  const db = await store.getDb();
  let positive = 0;
  let returns = 0;
  for (const s of db.sales || []) {
    if (!s.soldAt) continue;
    if (new Date(s.soldAt) < cutoff) continue;
    const amt = Number(s.amount || 0);
    if (amt < 0) returns += -amt; else positive += amt;
  }
  if (positive < 100000) return null; // мало данных
  const ratio = (returns / positive) * 100;
  if (ratio < 5) return null; // норм

  sent.returns = today;
  return `🟠 <b>Скачок возвратов за 7 дней</b>\n` +
    `Возвраты: ${fmt(returns)} ₽ (${ratio.toFixed(1)}% от выручки ${fmt(positive)} ₽)\n` +
    `Норма ≤ 5%. Проверьте топ-возвращаемые товары.`;
}

// ─── Scheduler ──────────────────────────────────────────────────────────
function startCriticalAlerts({ store, botToken, chatId }) {
  if (!botToken || !chatId) {
    console.log('[critical-alerts] disabled — TELEGRAM_BOT_TOKEN/CHAT_ID не выставлены');
    return null;
  }
  // Антиспам state: storeName → дата последней отправки
  const sent = { todayKey: '', zero: '', risk: '', returns: '', riskCooldownUntil: 0 };

  const tick = async () => {
    const irk = nowInIrk();
    sent.todayKey = `${irk.getUTCFullYear()}-${irk.getUTCMonth() + 1}-${irk.getUTCDate()}`;
    // Шлём только в рабочие часы — 10:00–20:00 МСК (= 13:00–23:00 Иркутск)
    // То есть проверяем что час Иркутска от 13 до 23
    const hh = irk.getUTCHours();
    if (hh < 13 || hh > 23) return;

    try {
      const msgs = [
        await checkZeroSalesStores(store, sent),
        await checkPlanAtRisk(store, sent),
        await checkReturnsSpike(store, sent)
      ].filter(Boolean);
      for (const m of msgs) {
        await sendTelegram(botToken, chatId, m);
        console.log('[critical-alerts] sent');
      }
    } catch (e) {
      console.warn('[critical-alerts] tick failed:', e.message);
    }
  };

  // Раз в час — чаще нет смысла
  const interval = setInterval(tick, 60 * 60 * 1000);
  // Первый запуск через 60с после старта (даём времени БД подгрузиться)
  setTimeout(tick, 60 * 1000);
  console.log('[critical-alerts] scheduled — hourly check, 13:00-23:00 Asia/Irkutsk');
  return {
    stop: () => clearInterval(interval),
    runNow: tick,
    state: sent
  };
}

module.exports = { startCriticalAlerts, checkZeroSalesStores, checkPlanAtRisk, checkReturnsSpike };
