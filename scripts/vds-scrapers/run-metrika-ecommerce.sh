#!/bin/sh
set -eu
cd /opt/2gis-scraper
TARGET_YM="$(date +%Y-%m)" /usr/bin/node scrape-metrika-ecommerce.js
TARGET_YM="$(date -d '1 month ago' +%Y-%m)" /usr/bin/node scrape-metrika-ecommerce.js
