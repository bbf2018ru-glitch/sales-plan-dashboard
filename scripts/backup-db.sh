#!/usr/bin/env bash
# Ежедневный pg_dump БД дашборда на VDS.
# Кладёт в /var/backups/postgres/sales-dashboard-YYYY-MM-DD.sql.gz.
# Ротация — отдельным скриптом backup-rotate.sh.
#
# Установка cron (один раз):
#   sudo mkdir -p /var/backups/postgres
#   sudo chown $USER /var/backups/postgres
#   crontab -e
#   # Добавить строку (ежедневно в 03:30 МСК = 06:30 НСК по локали VDS):
#   30 3 * * * /home/<user>/sales-plan-dashboard/scripts/backup-db.sh >> /var/log/sales-dashboard-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/postgres}"
DATABASE_URL="${DATABASE_URL:-}"

if [ -z "$DATABASE_URL" ]; then
  # Читаем из .env проекта если не задан в окружении
  ENV_FILE="$(dirname "$0")/../.env"
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    export $(grep -E '^DATABASE_URL=' "$ENV_FILE" | xargs)
  fi
fi

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL не задан (ни в env, ни в .env)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y-%m-%d)
OUT="$BACKUP_DIR/sales-dashboard-$TS.sql.gz"

echo "[$(date -Is)] dumping → $OUT"
# --no-owner / --no-acl — переносимый дамп между серверами
# Compress в gzip на лету
pg_dump --no-owner --no-acl --no-comments "$DATABASE_URL" | gzip -9 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo "[$(date -Is)] done, size=$SIZE"
