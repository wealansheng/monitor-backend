FROM node:20.20.2-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY dist/ ./dist/
COPY scripts/clickhouse-schema.sql ./scripts/clickhouse-schema.sql

RUN mkdir -p /app/mapdata && chown -R node:node /app
USER node

EXPOSE 3001
CMD ["node", "dist/main.js"]
