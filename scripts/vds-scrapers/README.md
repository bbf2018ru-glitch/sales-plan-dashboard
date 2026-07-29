# Бэкап скрейперов маркетинга с VDS

**Источник истины — VDS 186.246.14.117, каталог `/opt/2gis-scraper/`** (там же
`node_modules` с playwright 1.49.1 и state-файлы сессий). Здесь — резервная копия
боевых скриптов (всё, что в cron), БЕЗ секретов: `*state*.json`, `.env-yandex` не копируются.

Правка скриптов = правка на VDS + обновление копии здесь. Одноразовые dbg-/probe-скрипты
(две сотни штук на VDS) сюда сознательно не тащим.

Расписание (crontab root на VDS, время локальное +08):
- 04:00 scrape-seo · 04:30 scrape-prices, scrape-social · 04:45 scrape-yahont-prices
- 05:30 scrape-direct-history · 05:50 relogin-2gis · 06:00 scrape-mkt
- 06:15 scrape-direct · 06:30 scrape-metrika · 06:35/06:40 scrape-metrika-entry/partners
- 06:50 scrape-2gis-ratings.sh · 07:00 archive-mkt-snapshots.sh · 07:20/07:25 scrape-2gis-monthly/competitors
- плюс /etc/cron.d: 2gis-reviews, gis2-cache-warm, metrika-partner-clicks

Выход скрейперов — JSON в `/opt/marketing-data/` (дневной архив в `archive/YYYY-MM-DD/`),
их читает api/lib/marketing-channels.js (`readExternal`).

Грабли Я.Директа (2026-07-29, после 7 недель молчания скрейпера):
- Паспорт периодически требует «освежить» вход в Директ (`cause=auth`, редирект на
  список аккаунтов) при ЖИВОЙ сессии — Метрика с тем же yandex-state.json работает.
  Лечится кликом по своему аккаунту (без пароля) — см. ensureAuth в scrape-direct*.js.
- Сохранённые ссылки отчётов (`&state=NNN`) умирают; свежий отчёт открывается с пустым
  периодом → период выставляем календарём. Дашборд ждёт от direct.json строго
  month-to-date текущего месяца (НЕ «30 дней») — см. web/app.js.
- Порядок колонок в отчёте гуляет: «дата/№/имя» ↔ «дата/имя/№» — парсер понимает оба.
- relogin-yandex.js (полный вход по паролю из .env-yandex) в cron НЕ стоит — рискует
  капчей/СМС; ensureAuth покрывает наблюдаемый сценарий протухания.
