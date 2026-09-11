FROM node:24.21.0-alpine3.24@sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2 AS base
RUN apk upgrade --no-cache
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
