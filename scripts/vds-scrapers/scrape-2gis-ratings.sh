#!/bin/bash
# Ежедневное обновление 2gis-rating-latest.json через discover-branches.js
# (исправляет долгий простой файла с 29.05). Также append-ит в history.
set -e
DST=/opt/marketing-data
LATEST=$DST/2gis-rating-latest.json
HISTORY=$DST/2gis-rating-history.json
TMP=$(mktemp)

cd /opt/2gis-scraper
node discover-branches.js > "$TMP" 2>>/var/log/marketing-scrape.log || {
  echo "[$(date -Is)] scrape-2gis-ratings: scraper failed" >&2
  rm -f "$TMP"
  exit 1
}

# Проверяем что в TMP валидный JSON и есть branches
if node -e "const j=JSON.parse(require('fs').readFileSync('$TMP','utf8')); if(!j.ok || !Array.isArray(j.branches) || j.branches.length===0) process.exit(1);" 2>/dev/null; then
  # Перезаписываем latest
  cp "$TMP" "$LATEST"

  # Append в history: { scrapedAt, ratings: [{id,address,rating}] }
  node -e "
    const fs = require('fs');
    const fresh = JSON.parse(fs.readFileSync('$TMP','utf8'));
    const ratings = (fresh.branches||[]).map(b=>({ id:b.id, address:b.address, rating:b.rating, ratingCount:b.ratingCount }));
    let hist = { entries: [] };
    try { hist = JSON.parse(fs.readFileSync('$HISTORY','utf8')); if(!Array.isArray(hist.entries)) hist.entries = []; } catch(_){}
    hist.entries.push({ scrapedAt: new Date().toISOString(), ratings });
    // Не больше 120 записей (4 мес ежедневно).
    if (hist.entries.length > 120) hist.entries = hist.entries.slice(-120);
    fs.writeFileSync('$HISTORY', JSON.stringify(hist, null, 2));
  "
  echo "[$(date -Is)] scrape-2gis-ratings: OK ($(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP','utf8')).branches.length)") branches)"
else
  echo "[$(date -Is)] scrape-2gis-ratings: invalid JSON or empty branches, latest NOT updated" >&2
fi
rm -f "$TMP"
