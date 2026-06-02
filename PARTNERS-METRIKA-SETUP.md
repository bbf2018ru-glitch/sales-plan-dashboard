# Подключение трекинга переходов по партнёрам — 5 минут

## Что нужно

Дашборд показывает **0 переходов** для всех 14 партнёров. Чтобы Метрика начала их считать, нужно:
1. Создать одну общую Цель в Метрике (3 клика)
2. Вставить JS-snippet на сайт maria-irk.ru (1 файл в Bitrix)

После этого дашборд **сам** подхватит цифры на следующем cron-прогоне.

---

## ШАГ 1. Цель в Метрике (3 клика)

1. Открой `https://metrika.yandex.ru/settings/goals?id=43949414`
2. Кнопка «**Добавить цель**» → тип «**JavaScript-событие**»
3. Заполни:
   - **Название**: `Клик по партнёру`
   - **Идентификатор цели**: `partner_click`
4. Нажми **«Добавить цель»** → сохрани.

## ШАГ 2. JS-snippet на сайт (1 файл в Bitrix)

1. Открой `https://www.maria-irk.ru/bitrix/admin/fileman_admin.php?lang=ru`
2. Найди файл шаблона сайта — обычно `/local/templates/.default/footer.php` или `/bitrix/templates/maria/footer.php` (зависит от шаблона)
3. **Перед закрывающим `</body>`** или внутри блока счётчика Метрики добавь:

```html
<script>
(function() {
  // Трекинг кликов по партнёрским ссылкам с utm_source
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a[href*="utm_source"]');
    if (!a) return;
    try {
      var m = a.href.match(/utm_source=([^&]+)/);
      var partner = m ? decodeURIComponent(m[1]) : 'unknown';
      // Общая цель: partner_click + параметр partner=<utm_source>
      if (typeof ym === 'function') {
        ym(43949414, 'reachGoal', 'partner_click', { partner: partner, url: a.href });
      }
    } catch (err) { console.warn('partner-click track', err); }
  }, true);
})();
</script>
```

4. Сохрани файл.

## ШАГ 3. Проверка (через 24 часа)

- В Метрике → **Отчёты → Конверсии → По целям** появится строка «Клик по партнёру».
- В разрезе **«Параметры визитов → partner»** будут видны конкретные партнёры (mariasite, sitemaria-irk.ru, и т.д.).

## ШАГ 4. На дашборде

Я добавлю scraper который через сессию Метрики берёт цифры из «Параметров визитов → partner» и пишет в `partners.json`. После этого колонка «Переходов» в разделе #mkt-s-partners заполнится автоматически.

---

**Если не уверена куда вставлять JS** — пришли мне путь к файлу `footer.php` твоего шаблона из админки Bitrix, и я вставлю код напрямую через REST или дам точную инструкцию для конкретного файла.
