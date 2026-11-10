FROM node:24.22.1-alpine3.24@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS node

FROM clamav/clamav:1.4.6@sha256:cbc30de94b6e9b33ac14136ff45306cee02a1f9ae522394a3cc5b9215d1affe9
RUN apk upgrade --no-cache && apk add --no-cache 'zlib>=1.4-r0' libstdc++
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY clamd.mjs server.mjs start.mjs verify-signatures.mjs clamd.conf freshclam.conf ./
ENV TZ=UTC PORT=8080 NODE_ENV=production
# The CI changes this argument daily. A failed refresh or stale signed database
# fails the candidate build; a deployment never silently refreshes its image age.
ARG SIGNATURE_REFRESH
RUN test -n "$SIGNATURE_REFRESH" \
    && freshclam --config-file=/app/freshclam.conf --stdout --foreground \
    && node /app/verify-signatures.mjs
USER 100:101
EXPOSE 8080
HEALTHCHECK NONE
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/start.mjs"]
