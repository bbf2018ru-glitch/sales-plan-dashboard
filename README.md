# Sales Plan Dashboard

Дашборд выполнения плана продаж по точкам и товарам с интеграцией с 1С и базовым маркетинговым анализом.

## Что умеет

- показывает план / факт / % выполнения по сети;
- показывает выполнение по точкам;
- показывает выполнение по товарам;
- показывает детализацию по выбранной точке;
- считает прогноз до конца месяца и нужную выручку в день до выполнения плана;
- сравнивает результат с прошлым периодом;
- показывает дневной накопительный план-факт по месяцу;
- показывает многомесячный тренд по плану, факту и выполнению;
- формирует executive summary для руководителя;
- показывает маркетинговые метрики по каналам;
- по кнопке запускает маркетинговый анализ и выдает выводы и советы;
- принимает unified package import из `1С:УПП`;
- ведет журнал загрузок и отсекает дублирующиеся пакеты;
- обновляется автоматически через SSE и периодический polling;
- принимает данные из 1С по HTTP JSON.

## Структура

- `api/server.js` — backend и API
- `web/` — frontend дашборда
- `data/sample-db.json` — демо-данные
- `examples/1c-payloads.http` — примеры запросов из 1С
- `examples/upp-exchange-spec.md` — спецификация обмена для `1С:УПП`
- `examples/upp-http-export-template.bsl` — шаблон кода выгрузки из `1С`

## Запуск

```bash
npm start
```

Сервис поднимется на `http://localhost:3000`.

## Быстрый старт через Docker

1. Создайте `.env` на основе `.env.example`
2. Запустите:

```bash
docker compose up --build
```

После старта будут доступны:

- приложение: `http://localhost:3000`
- PostgreSQL: `localhost:5432`

Для первого запуска схема БД автоматически применится из [sql/init.sql](/C:/Users/user/sales-plan-dashboard/sql/init.sql).

## Переменные окружения

- `PORT` — порт, по умолчанию `3000`
- `INGEST_API_KEY` — ключ для загрузки данных из 1С, по умолчанию `demo-secret`
- `DB_PATH` — путь к json-файлу хранилища, по умолчанию `./data/db.json`
- `DATABASE_URL` — строка подключения PostgreSQL. Если задана, сервис работает с PostgreSQL вместо JSON.
- `DASHBOARD_PIN` — PIN для входа в дашборд (по умолчанию выключен)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — алерты по точкам ниже 80% плана
- `GROQ_API_KEY` — ключ Groq для LLM-маркетинг-анализа (если не задан, используется встроенный rules engine)
- `GROQ_MODEL` — модель для анализа, по умолчанию `llama-3.3-70b-versatile`
- `UPP_PULL_URL` — URL HTTP-сервиса 1С УПП для pull-режима (см. ниже)
- `UPP_PULL_USER`, `UPP_PULL_PASSWORD` — Basic Auth для HTTP-сервиса
- `UPP_PULL_INTERVAL_MIN` — авто-pull в минутах (`0` = только по запросу)

## Режимы хранения

- `JSON` — режим по умолчанию для быстрого локального старта без внешней БД
- `PostgreSQL` — основной режим для реальной эксплуатации

### PostgreSQL

1. Создайте базу.
2. Выполните схему из [sql/init.sql](/C:/Users/user/sales-plan-dashboard/sql/init.sql).
3. Установите зависимости: `npm install`
4. Запустите сервис с `DATABASE_URL`

Пример:

```bash
set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sales_dashboard
npm start
```

Если запускаете через Docker Compose, используйте хост `db` внутри `DATABASE_URL`, как в [.env.example](/C:/Users/user/sales-plan-dashboard/.env.example).

## Контракт интеграции с 1С

### Загрузка плана

`POST /api/ingest/plans`

```json
{
  "period": "2026-04",
  "stores": [
    { "id": "irk-1", "name": "Иркутск Центр" }
  ],
  "products": [
    { "id": "coffee", "name": "Кофе" }
  ],
  "plans": [
    { "storeId": "irk-1", "productId": "coffee", "amount": 120000 }
  ]
}
```

### Загрузка факта продаж

`POST /api/ingest/sales`

```json
{
  "period": "2026-04",
  "sales": [
    {
      "storeId": "irk-1",
      "productId": "coffee",
      "amount": 86400,
      "quantity": 320,
      "soldAt": "2026-04-20T15:00:00+08:00"
    }
  ]
}
```

Для обоих запросов нужен заголовок:

```text
X-API-Key: demo-secret
```

### Загрузка маркетинговых метрик

`POST /api/ingest/marketing`

```json
{
  "period": "2026-04",
  "metrics": [
    {
      "channelId": "yandex-direct",
      "channelName": "Яндекс Директ",
      "spend": 85000,
      "leads": 620,
      "orders": 164,
      "revenue": 402000,
      "impressions": 480000,
      "clicks": 11800,
      "sessions": 9700
    }
  ]
}
```

### Получение маркетинговой сводки

`GET /api/dashboard/marketing?period=2026-04`

### Запуск анализа

`POST /api/analysis/marketing`

```json
{
  "period": "2026-04"
}
```

Ответ содержит:

- агрегированные метрики по маркетингу;
- текстовый summary;
- список выводов;
- список рисков;
- список рекомендаций.

### Unified import для 1С:УПП

`POST /api/ingest/upp`

Назначение:

- принять единый пакет обмена из `1С:УПП`
- сохранить сырой payload
- записать запуск в журнал `ingest_runs`
- отбросить повторный пакет по `packageId` или `payloadHash`
- нормализовать данные в `plans`, `sales`, `marketing_metrics`

Минимальный пример:

```json
{
  "sourceSystem": "1c-upp",
  "sourceObject": "regulated_exchange",
  "packageId": "upp-2026-04-22-001",
  "period": "2026-04",
  "stores": [{ "id": "irk-1", "name": "Иркутск Центр", "region": "Иркутск" }],
  "products": [{ "id": "coffee", "name": "Кофе", "category": "Напитки" }],
  "plans": [{ "storeId": "irk-1", "productId": "coffee", "amount": 120000 }],
  "sales": [{ "storeId": "irk-1", "productId": "coffee", "amount": 12500, "cost": 7200, "quantity": 48, "soldAt": "2026-04-22T09:00:00+08:00" }],
  "marketingMetrics": [{ "channelId": "yandex-direct", "channelName": "Яндекс Директ", "spend": 85000, "leads": 620, "orders": 164, "revenue": 402000, "impressions": 480000, "clicks": 11800, "sessions": 9700 }]
}
```

### Журнал загрузок

`GET /api/ingest/runs?limit=20`

Отдает последние запуски импорта со статусами:

- `success`
- `duplicate`
- `failed`

## Управленческий слой

`GET /api/dashboard/summary?period=2026-04`

Кроме стандартных KPI ответ теперь содержит:

- `forecast` — прогноз до конца месяца и нужный ритм продаж
- `comparison` — сравнение с предыдущим периодом
- `daily` — дневной накопительный план-факт
- `trend` — многомесячный тренд по периодам
- `executive` — короткая сводка для руководителя

## Что уже готово под УПП

- отдельный endpoint под единый пакет обмена
- дедупликация повторных загрузок
- хранение сырого UPP payload
- журнал запусков импорта
- нормализация UPP-данных в витрину дашборда

## Два режима интеграции с 1С

### Push (1С → дашборд)

Регламентное задание в 1С шлёт пакет на `POST /api/ingest/upp`.

- BSL-шаблон: [examples/upp-http-export-template.bsl](/C:/Users/user/sales-plan-dashboard/examples/upp-http-export-template.bsl)
- Простой запуск: достаточно сетевого доступа из 1С наружу.
- Минусы: нужно править регламентное задание для смены частоты, нет «по требованию».

### Pull (дашборд → 1С)

Дашборд периодически (или по кнопке) дёргает HTTP-сервис в 1С.

- BSL-шаблон HTTP-сервиса: [examples/upp-http-service-template.bsl](/C:/Users/user/sales-plan-dashboard/examples/upp-http-service-template.bsl)
- Конфиг через env: `UPP_PULL_URL`, `UPP_PULL_USER`, `UPP_PULL_PASSWORD`, `UPP_PULL_INTERVAL_MIN`
- Ручной триггер: `POST /api/upp/pull` (требует admin-токен), опционально `?period=YYYY-MM`
- Ответ HTTP-сервиса должен совпадать с форматом `/api/ingest/upp` (см. выше)
- Плюсы: можно дёргать по кнопке, частоту меняем в env, не нужно ничего трогать в 1С после публикации.

Можно использовать оба режима одновременно — дедупликация по `packageId` отсечёт повторы.

## Роли и доступ

Дашборд поддерживает два типа пользователей:

- `admin` — видит все точки, может управлять пользователями через `/api/users`
- `manager` — видит только привязанные к нему точки

Доступ передаётся через `X-User-Token: <token>` или одноразовую ссылку вида `/?userToken=<token>` (токен сохраняется в localStorage и подставляется в дальнейшие запросы).

### API управления пользователями (только admin)

```text
GET  /api/users
POST /api/users        { "id": "mgr-pushkina", "name": "Менеджер Пушкина", "role": "manager", "stores": ["pushkina"], "token": "..." }
DELETE /api/users/:id
```

Если `token` не передан в POST — генерируется автоматически.

В `data/sample-db.json` уже заведены демо-пользователи:

- `admin-demo-token` — админ
- `mgr-yadr-token` — менеджер точки «Ядринцева»
- `mgr-kond-token` — менеджер точек «Кондитерская» и «Декабрьских Событий»
- `mgr-angarsk-token` — менеджер точки «Ангарск»

Для production обязательно поменяйте токены через `/api/users`.

## Что дальше

- подключить реальный обмен с 1С;
- для production использовать PostgreSQL как основное хранилище;
- добавить роли, фильтры по менеджерам и сравнительную аналитику по периодам;
- подключить реальные рекламные кабинеты, CRM и расходы по кампаниям;
- вынести rules engine анализа в отдельный модуль или LLM-сервис.
