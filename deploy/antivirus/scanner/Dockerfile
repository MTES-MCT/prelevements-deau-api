FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS node

FROM clamav/clamav:1.4.6@sha256:cbc30de94b6e9b33ac14136ff45306cee02a1f9ae522394a3cc5b9215d1affe9
# CI supplies a unique value per run attempt to refresh packages and signatures.
ARG SIGNATURE_REFRESH
RUN test -n "$SIGNATURE_REFRESH" \
    && apk upgrade --no-cache \
    && apk add --no-cache 'zlib>=1.4-r0' libstdc++
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY clamd.mjs server.mjs start.mjs verify-signatures.mjs clamd.conf freshclam.conf ./
ENV TZ=UTC PORT=8080 NODE_ENV=production
RUN freshclam --config-file=/app/freshclam.conf --stdout --foreground \
    && node /app/verify-signatures.mjs
USER 100:101
EXPOSE 8080
HEALTHCHECK NONE
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/start.mjs"]
