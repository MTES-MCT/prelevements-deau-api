FROM node:24-bookworm-slim AS builder
WORKDIR /app

ENV NODE_ENV=development

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci --no-audit --no-fund
RUN npx prisma generate --schema=./prisma/schema

ENV NODE_ENV=production
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY package.json package-lock.json prisma.config.ts ./
COPY api.js instrument.js worker.js ./
COPY db ./db
COPY lib ./lib
COPY prisma ./prisma
COPY scripts ./scripts
COPY data ./data

ARG ENV_NAME=testing

COPY deploy/certs/${ENV_NAME} ./deploy/certs/${ENV_NAME}
COPY deploy/certs/${ENV_NAME}/redis-ca.pem /usr/local/share/ca-certificates/scw-redis-ca.crt
COPY deploy/certs/${ENV_NAME}/postgres-ca.pem /usr/local/share/ca-certificates/scw-postgres-ca.crt

RUN update-ca-certificates

ENV NODE_OPTIONS=--use-openssl-ca
ENV PORT=8080

EXPOSE 8080
CMD ["node", "api.js"]
