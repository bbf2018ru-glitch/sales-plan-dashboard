#!/usr/bin/env bash
# Еженедельная загрузка свежего бэкапа БД в Яндекс.Диск через WebDAV.
# Требует:
#   YANDEX_LOGIN   — логин Я.Диска (email)
#   YANDEX_APP_PWD — app-password (НЕ обычный пароль аккаунта).
#                    Создай: https://id.yandex.ru/security/app-passwords
#                    → «Создать пароль» → «WebDAV». Выдаётся 1 раз.
#
# Кладёт в /maria-dashboard-backups/<имя_файла>.sql.gz
#
# cron (раз в неделю по понедельникам):
#   45 3 * * 1 /home/<user>/sales-plan-dashboard/scripts/backup-to-yadisk.sh >> /var/log/sales-dashboard-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/postgres}"
YANDEX_LOGIN="${YANDEX_LOGIN:-}"
YANDEX_APP_PWD="${YANDEX_APP_PWD:-}"
REMOTE_DIR="/maria-dashboard-backups"

if [ -z "$YANDEX_LOGIN" ] || [ -z "$YANDEX_APP_PWD" ]; then
  echo "ERROR: YANDEX_LOGIN и YANDEX_APP_PWD должны быть в env (см. /etc/environment или systemd unit)" >&2
  exit 1
fi

# Берём самый свежий weekly или последний daily
LATEST=$(ls -1t "$BACKUP_DIR"/weekly-sales-dashboard-*.sql.gz 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  LATEST=$(ls -1t "$BACKUP_DIR"/sales-dashboard-*.sql.gz 2>/dev/null | head -1)
fi
if [ -z "$LATEST" ]; then
  echo "ERROR: нет файлов бэкапа в $BACKUP_DIR" >&2
  exit 1
fi

BASENAME=$(basename "$LATEST")
REMOTE_URL="https://webdav.yandex.ru$REMOTE_DIR/$BASENAME"

# Создаём папку (MKCOL вернёт 201 или 405 если уже есть — оба ок)
curl -sS -X MKCOL "https://webdav.yandex.ru$REMOTE_DIR" \
  -u "$YANDEX_LOGIN:$YANDEX_APP_PWD" >/dev/null || true

echo "[$(date -Is)] uploading $BASENAME → $REMOTE_URL"
HTTP_CODE=$(curl -sS -o /tmp/yadisk-resp.txt -w '%{http_code}' \
  -T "$LATEST" "$REMOTE_URL" \
  -u "$YANDEX_LOGIN:$YANDEX_APP_PWD")

if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "204" ]; then
  echo "[$(date -Is)] ok, HTTP $HTTP_CODE"
else
  echo "ERROR: upload failed HTTP $HTTP_CODE" >&2
  cat /tmp/yadisk-resp.txt >&2
  exit 1
fi
