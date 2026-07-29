#!/bin/bash
# Ежедневный архив маркетинговых данных. Запускается из cron 7:00.
# Копирует все актуальные JSON в /opt/marketing-data/archive/YYYY-MM-DD/
set -e
SRC=/opt/marketing-data
DATE=$(date +%Y-%m-%d)
DST=$SRC/archive/$DATE
mkdir -p "$DST"

# Файлы, которые имеет смысл архивировать (не сам archive/).
FILES=(
  2gis.json 2gis-all-sections.json 2gis-history.json
  2gis-rating-latest.json 2gis-rating-by-branch.json 2gis-rating-history.json
  bloggers.json direct.json metrika.json metrika-history.json
  partners.json partner-clicks.json prices.json seo.json
  sms-clicks.json social.json vk.json
)

COPIED=0
for f in "${FILES[@]}"; do
  if [ -f "$SRC/$f" ]; then
    cp -p "$SRC/$f" "$DST/$f"
    COPIED=$((COPIED+1))
  fi
done

# Очистка старого: оставляем 90 дней (~3 месяца тренда). Удаляем папки старше 90 дней.
find "$SRC/archive" -mindepth 1 -maxdepth 1 -type d -mtime +90 -exec rm -rf {} \; 2>/dev/null || true

echo "[$(date -Is)] archive-mkt: copied $COPIED files to $DST"
