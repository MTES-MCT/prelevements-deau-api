FROM node:24-bookworm-slim AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client jq \
  && rm -rf /var/lib/apt/lists/*

FROM base AS builder
ENV NODE_ENV=development

COPY package.json package-lock.json ./
COPY packages ./packages
COPY prisma ./prisma

RUN npm install --no-audit --no-fund
RUN npx prisma generate --schema=./prisma/schema/schema.prisma

ENV NODE_ENV=production
RUN npm prune --omit=dev

FROM base AS runner
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY . .

COPY deploy/testing-scaleway-mongodb-ca.pem /usr/local/share/ca-certificates/scw-mongodb-ca.crt
COPY deploy/testing-scaleway-redis-ca.pem /usr/local/share/ca-certificates/scw-redis-ca.crt
COPY deploy/testing-scaleway-postgres-ca.pem /usr/local/share/ca-certificates/scw-postgres-ca.crt
RUN update-ca-certificates

ENV NODE_OPTIONS=--use-openssl-ca
ENV PORT=8080
EXPOSE 8080
CMD ["node", "api.js"]
