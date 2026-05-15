# Настройка HTTPS для дашборда (один раз, ~15 минут)

## Шаг 1. Поддомен на DuckDNS (3 мин)

1. Открой https://www.duckdns.org → залогинься через Google/GitHub/Twitter
2. В поле «sub domain» введи имя — например `maria-sales` → жми `add domain`
3. Получится поддомен `maria-sales.duckdns.org`. В графе **current ip** должен быть `186.246.14.117` — если другой, замени и нажми `update ip`
4. Скопируй **token** (вверху страницы) — пригодится для авто-обновления IP

## Шаг 2. Auto-update IP на VDS (опционально, но нужно)

Если у Timeweb VDS статический IP — можно пропустить. Если может меняться — настроить cron:

```bash
# SSH на VDS
crontab -e
# Добавить (заменив TOKEN и поддомен):
*/5 * * * * curl -s "https://www.duckdns.org/update?domains=maria-sales&token=ТВОЙ_TOKEN&ip=" >/dev/null
```

## Шаг 3. nginx config (5 мин)

```bash
# На VDS
sudo nano /etc/nginx/sites-available/sales-dashboard
```

Содержимое (заменить `maria-sales.duckdns.org` на свой):

```nginx
# HTTP → HTTPS redirect
server {
    listen 80;
    server_name maria-sales.duckdns.org;

    # Let's Encrypt verification path должен остаться доступен по HTTP
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS proxy → Node.js на :3000
server {
    listen 443 ssl http2;
    server_name maria-sales.duckdns.org;

    ssl_certificate     /etc/letsencrypt/live/maria-sales.duckdns.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/maria-sales.duckdns.org/privkey.pem;

    # Modern TLS
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # 50 MB upload (1С дампы)
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # SSE требует длинного keepalive
    location /api/events {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

Подключить и проверить:

```bash
sudo ln -sf /etc/nginx/sites-available/sales-dashboard /etc/nginx/sites-enabled/sales-dashboard
# Убрать дефолтную HTTP-конфигу (если есть)
sudo rm -f /etc/nginx/sites-enabled/default
sudo mkdir -p /var/www/certbot
sudo nginx -t  # должно быть ok
```

## Шаг 4. SSL-сертификат через Certbot (3 мин)

```bash
# Установка certbot
sudo apt-get install -y certbot python3-certbot-nginx

# Получаем сертификат для нашего поддомена
# (--nginx автоматически правит конфигу, но мы её уже сделали, поэтому используем --webroot)
sudo certbot certonly --webroot -w /var/www/certbot \
  -d maria-sales.duckdns.org \
  --agree-tos -m твой@email.ru --non-interactive

# Перезапуск nginx
sudo systemctl reload nginx
```

После этого https://maria-sales.duckdns.org/ должен открыть дашборд с зелёным замочком.

## Шаг 5. Авто-обновление сертификата

Certbot ставит свой systemd timer при установке. Проверить:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run  # проверка без реального обновления
```

## Шаг 6. Сказать дашборду что мы за HTTPS (1 мин)

После того как HTTPS заработал, дашборд автоматически детектит схему через
заголовок `X-Forwarded-Proto` (nginx уже его проставляет в нашей конфиге)
и автоматически ставит флаг `Secure` на cookies.

Никаких ручных правок в коде Node.js не нужно.

## Шаг 7. Обновить ссылки в memory

Заменить в [reference_dashboard_admin_token](../memory/projects/sales-dashboard/reference_dashboard_admin_token.md):

- Было: `http://186.246.14.117/`
- Стало: `https://maria-sales.duckdns.org/`

И в Telegram-боте если он отправляет ссылки на дашборд — тоже обновить.

## Troubleshooting

**`Could not connect to maria-sales.duckdns.org`** — DNS ещё не пропагнулся. Подождать 5-10 мин. Проверить: `dig maria-sales.duckdns.org +short` должен вернуть `186.246.14.117`.

**`Connection refused` / `502 Bad Gateway`** — Node.js не на :3000 или упал. Проверить: `sudo systemctl status sales-dashboard` или `curl http://127.0.0.1:3000/api/health`.

**`SSL handshake failed`** — что-то с сертификатом. `sudo nginx -t` показывает где. `ls -la /etc/letsencrypt/live/maria-sales.duckdns.org/` должна показать 4 .pem файла.
