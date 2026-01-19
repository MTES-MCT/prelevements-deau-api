FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS runner

COPY --from=deps /app/node_modules ./node_modules
COPY . .

COPY deploy/testing-scaleway-mongodb-ca.pem /usr/local/share/ca-certificates/scw-mongodb-ca.crt
COPY deploy/testing-scaleway-redis-ca.pem /usr/local/share/ca-certificates/scw-redis-ca.crt
RUN update-ca-certificates

ENV NODE_OPTIONS=--use-openssl-ca

ENV PORT=8080
EXPOSE 8080

CMD ["node", "api.js"]
