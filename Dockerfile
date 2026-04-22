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

CMD ["npm", "start"]
