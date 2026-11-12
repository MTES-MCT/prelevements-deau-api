FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base
# Keep the CVE-2026-4738 fix even when the base image or build cache predates it.
RUN apk upgrade --no-cache && apk add --no-cache 'zlib>=1.4-r0'
WORKDIR /app
COPY package.json ./
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" --ignore-scripts --no-audit --no-fund

FROM base AS builder
WORKDIR /app

ENV NODE_ENV=development

RUN apk add --no-cache openssl

COPY package.json package-lock.json .npmrc ./
COPY prisma ./prisma

RUN npm ci --no-audit --no-fund
RUN npx prisma generate --schema=./prisma/schema

ENV NODE_ENV=production
RUN npm prune --omit=dev

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache ca-certificates openssl

# API, worker and private migrations run directly with Node; package managers are build-only.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

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
