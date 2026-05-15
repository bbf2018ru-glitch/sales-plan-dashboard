#!/usr/bin/env bash
# Ротация бэкапов БД: оставляем последние 14 ежедневных + последние 8 еженедельных.
# Запускать раз в день после backup-db.sh.
#
# cron:
#   35 3 * * * /home/<user>/sales-plan-dashboard/scripts/backup-rotate.sh >> /var/log/sales-dashboard-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/postgres}"
DAILY_KEEP=14
WEEKLY_KEEP=8

cd "$BACKUP_DIR"

# Все ежедневные файлы, отсортированы по имени (новейшие в конце т.к. имя YYYY-MM-DD)
mapfile -t DAILY < <(ls -1 sales-dashboard-????-??-??.sql.gz 2>/dev/null | sort)

# Удаляем всё старше последних DAILY_KEEP, КРОМЕ воскресных (они идут в weekly).
TOTAL=${#DAILY[@]}
if [ "$TOTAL" -gt "$DAILY_KEEP" ]; then
  TO_REMOVE=$((TOTAL - DAILY_KEEP))
  for ((i = 0; i < TO_REMOVE; i++)); do
    f="${DAILY[$i]}"
    DATE_PART=$(echo "$f" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')
    DOW=$(date -d "$DATE_PART" +%u 2>/dev/null || echo 1)  # 7 = воскресенье
    if [ "$DOW" = "7" ]; then
      # Воскресный — переименовываем в weekly если ещё не сделали
      WEEKLY_NAME="weekly-sales-dashboard-$DATE_PART.sql.gz"
      if [ ! -f "$WEEKLY_NAME" ]; then
        mv "$f" "$WEEKLY_NAME"
        echo "[$(date -Is)] promote to weekly: $WEEKLY_NAME"
      else
        rm -f "$f"
        echo "[$(date -Is)] remove daily (already weekly): $f"
      fi
    else
      rm -f "$f"
      echo "[$(date -Is)] remove old daily: $f"
    fi
  done
fi

# Чистим weekly старше WEEKLY_KEEP
mapfile -t WEEKLY < <(ls -1 weekly-sales-dashboard-????-??-??.sql.gz 2>/dev/null | sort)
TOTAL_W=${#WEEKLY[@]}
if [ "$TOTAL_W" -gt "$WEEKLY_KEEP" ]; then
  TO_REMOVE=$((TOTAL_W - WEEKLY_KEEP))
  for ((i = 0; i < TO_REMOVE; i++)); do
    rm -f "${WEEKLY[$i]}"
    echo "[$(date -Is)] remove old weekly: ${WEEKLY[$i]}"
  done
fi
