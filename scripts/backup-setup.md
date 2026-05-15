# Настройка backup БД (один раз)

## 1. На VDS

```bash
# SSH на VDS как user (НЕ root)
ssh user@186.246.14.117

cd ~/sales-plan-dashboard
git pull

# Сделать скрипты исполняемыми
chmod +x scripts/backup-db.sh scripts/backup-rotate.sh scripts/backup-to-yadisk.sh

# Создать папку для бэкапов
sudo mkdir -p /var/backups/postgres
sudo chown $USER /var/backups/postgres

# Установить pg_dump если не установлен (он идёт с postgresql-client)
sudo apt-get install -y postgresql-client

# Создать app-password для Я.Диска:
#   https://id.yandex.ru/security/app-passwords
#   → «Создать пароль» → выбрать «WebDAV» → имя «sales-dashboard-backup»
#   Скопировать (показывают один раз!)

# Записать креды в /etc/environment (читается всеми cron jobs):
sudo nano /etc/environment
# Добавить:
#   YANDEX_LOGIN="ваш@yandex.ru"
#   YANDEX_APP_PWD="скопированный_пароль"

# Применить (для текущей сессии):
source /etc/environment
```

## 2. Cron

```bash
crontab -e
```

Добавить (время по часовому поясу VDS, проверить через `date`):

```
# Ежедневный pg_dump в 03:30
30 3 * * * /home/$USER/sales-plan-dashboard/scripts/backup-db.sh >> /var/log/sales-dashboard-backup.log 2>&1

# Ротация в 03:35 (после dump)
35 3 * * * /home/$USER/sales-plan-dashboard/scripts/backup-rotate.sh >> /var/log/sales-dashboard-backup.log 2>&1

# Загрузка в Я.Диск по понедельникам 03:45
45 3 * * 1 /home/$USER/sales-plan-dashboard/scripts/backup-to-yadisk.sh >> /var/log/sales-dashboard-backup.log 2>&1
```

Замени `$USER` на реальный логин (например `user`).

## 3. Проверка

```bash
# Запустить backup вручную, посмотреть что отработал
bash scripts/backup-db.sh
ls -lh /var/backups/postgres/

# Проверить загрузку на Я.Диск (если установил YANDEX_LOGIN/PWD)
bash scripts/backup-to-yadisk.sh
# Затем посмотри на disk.yandex.ru — папка /maria-dashboard-backups/
```

## 4. Тест восстановления (раз в месяц рекомендуется)

```bash
# На тестовой БД (НЕ на проде!):
createdb test_restore
gunzip -c /var/backups/postgres/sales-dashboard-2026-05-15.sql.gz | psql test_restore
psql test_restore -c "select count(*) from sales;"  # должно вернуть 3355+
dropdb test_restore
```

## Что хранится

- **Daily:** последние 14 ежедневных дампов на VDS
- **Weekly:** последние 8 еженедельных (воскресных) на VDS
- **Я.Диск:** копия свежего еженедельного, файлы накапливаются (вручную чистить по необходимости)

Размер одного дампа ~ 5-30 MB (зависит от sales). 14 дневных + 8 недельных = ~660 MB на VDS.
