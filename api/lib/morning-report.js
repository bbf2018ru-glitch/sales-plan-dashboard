// Утренний отчёт в Telegram в 09:00 по Иркутску (= 02:00 UTC).
// Активируется только если заданы TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID.

const https = require('https');
const { aggregateDashboard, monthKey } = require('./analytics');
const { getUpcomingEvents, nowInIrk } = require('./calendar-irk');

const TZ_OFFSET_MS = 8 * 3600 * 1000;

function fmt(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value || 0);
}

function fmtDate(date) {
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

// Сборка текста отчёта.
async function buildReportText(store) {
  const irkNow = nowInIrk();
  const yesterday = new Date(irkNow.getTime() - 24 * 3600 * 1000);
  const period = monthKey(`${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}`);
  const yDay = yesterday.getUTCDate();

  const db = await store.getDb();
  const summary = aggregateDashboard(db, period);

  // Продажи за вчерашний день из db.sales
  const yKey = `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(yDay).padStart(2, '0')}`;
  const yesterdayFact = db.sales
    .filter((s) => {
      if (s.period !== period) return false;
      if (!s.soldAt) return false;
      // Сравниваем дату в Иркутском поясе
      const d = new Date(new Date(s.soldAt).getTime() + TZ_OFFSET_MS);
      return d.getUTCFullYear() === yesterday.getUTCFullYear()
        && d.getUTCMonth() === yesterday.getUTCMonth()
        && d.getUTCDate() === yDay;
    })
    .reduce((sum, s) => sum + Number(s.amount || 0), 0);

  const f = summary.forecast;
  const upcoming = getUpcomingEvents(14).filter((e) => e.impact !== 'low').slice(0, 2);

  const lines = [];
  lines.push(`<b>Мария — утренний отчёт за ${fmtDate(yesterday)}</b>`);
  lines.push('');

  if (yesterdayFact > 0) {
    lines.push(`Вчера: <b>${fmt(yesterdayFact)} ₽</b>`);
  } else {
    lines.push(`Вчера: <i>нет данных за вчерашнюю дату</i>`);
  }

  lines.push(`Месяц: <b>${fmt(summary.totals.fact)} ₽</b> / план ${fmt(summary.totals.plan)} ₽ — <b>${summary.totals.completion}%</b>`);
  lines.push(`Прогноз: ${fmt(f.projectedFact)} ₽ (${f.projectedCompletion}% к плану)`);

  if (f.remainingDays > 0) {
    lines.push(`До конца месяца: ${f.remainingDays} дн., нужно ${fmt(f.requiredPerDayToPlan)} ₽/день`);
  }

  // Топ-3 риск-точек
  const risky = summary.stores
    .filter((s) => s.plan > 0 && s.percent < 80)
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 3);
  if (risky.length) {
    lines.push('');
    lines.push('<b>В зоне риска:</b>');
    for (const s of risky) {
      lines.push(`• ${s.storeName}: ${s.percent}%`);
    }
  }

  // YoY
  if (summary.yoy?.hasData) {
    const sign = summary.yoy.factDeltaPercent >= 0 ? '+' : '';
    lines.push('');
    lines.push(`vs тот же месяц год назад: <b>${sign}${summary.yoy.factDeltaPercent}%</b>`);
  }

  // Праздники впереди
  if (upcoming.length) {
    lines.push('');
    lines.push('<b>Впереди:</b>');
    for (const e of upcoming) {
      lines.push(`• ${e.name} — через ${e.daysFromNow} дн.`);
    }
  }

  return lines.join('\n');
}

function sendTelegram(token, chatId, text) {
  const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Запускает scheduler. Каждые 60 секунд проверяет: время по Иркутску = 09:00:xx и
// мы ещё не отправляли сегодня — отправить.
function startMorningReport({ store, botToken, chatId }) {
  if (!botToken || !chatId) {
    console.log('[morning-report] disabled — TELEGRAM_BOT_TOKEN/CHAT_ID не выставлены');
    return null;
  }

  let lastSentDate = null;

  const tick = async () => {
    const irk = nowInIrk();
    const hh = irk.getUTCHours();
    const mm = irk.getUTCMinutes();
    const today = `${irk.getUTCFullYear()}-${irk.getUTCMonth() + 1}-${irk.getUTCDate()}`;

    if (hh === 9 && mm < 5 && lastSentDate !== today) {
      try {
        const text = await buildReportText(store);
        const ok = await sendTelegram(botToken, chatId, text);
        if (ok) {
          console.log(`[morning-report] sent at Иркутск ${hh}:${String(mm).padStart(2, '0')}`);
          lastSentDate = today;
        } else {
          console.warn(`[morning-report] Telegram returned non-200`);
        }
      } catch (err) {
        console.warn(`[morning-report] failed: ${err.message}`);
      }
    }
  };

  const interval = setInterval(tick, 60 * 1000);
  console.log('[morning-report] scheduled — 09:00 Asia/Irkutsk daily');
  return { stop: () => clearInterval(interval), sendNow: async () => {
    const text = await buildReportText(store);
    return sendTelegram(botToken, chatId, text);
  } };
}

module.exports = { startMorningReport, buildReportText };
