FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY api ./api
COPY web ./web
COPY sql ./sql
COPY data ./data
COPY .env.example ./.env.example
COPY README.md ./README.md

EXPOSE 3000

# В контейнере слушаем все интерфейсы (иначе порт недоступен снаружи).
# На хосте (systemd за nginx) по умолчанию 127.0.0.1 — см. HOST в api/server.js.
ENV HOST=0.0.0.0

CMD ["npm", "start"]
