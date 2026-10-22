# Fredy MCP Bridge – schlanker Node-Container
FROM node:25-bookworm-slim AS deps
WORKDIR /app
# Build-Werkzeuge, falls better-sqlite3 für die Node-/CPU-Kombination kein fertiges Binary hat.
# Nur in dieser Stufe – das fertige Image enthält sie nicht.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:25-bookworm-slim
ARG VERSION=dev
ARG REVISION=unknown
ARG BUILD_DATE=
LABEL org.opencontainers.image.title="fredy-mcp-bridge" \
      org.opencontainers.image.description="MCP-Sidecar für Fredy mit OAuth und Rechten pro Verbindung" \
      org.opencontainers.image.source="https://github.com/Jake-double-one/fredy-mcp-bridge" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV NODE_ENV=production \
    BRIDGE_REVISION=${REVISION} \
    BRIDGE_BUILD_DATE=${BUILD_DATE} \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=Europe/Berlin
WORKDIR /app
# Debian-Sicherheitsupdates beim Bau einspielen – das offizielle Node-Image hinkt manchmal
# ein paar Tage hinterher. Zusammen mit dem wöchentlichen Neubau bleibt das Image so aktuell.
RUN apt-get update \
 && apt-get -y upgrade \
 && rm -rf /var/lib/apt/lists/*
# npm, Yarn und Corepack braucht die Bridge zur Laufzeit nicht (installiert wird in der Build-Stufe).
# Raus damit: weniger Angriffsfläche, und Lücken in npms eigenen Paketen betreffen das Image nicht mehr.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/index.js"]
