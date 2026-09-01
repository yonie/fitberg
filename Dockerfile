# Fitberg — self-hosted fitness data hub.
#
# Node 24 is used deliberately: its built-in `node:sqlite` means this image needs
# no C toolchain and ships no native modules, so the same Dockerfile builds on a
# Raspberry Pi (arm64) and an x86 server without the usual node-gyp misery.

# ─── web build stage ──────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS web
WORKDIR /build
COPY web/package*.json ./web/
RUN npm --prefix web ci
COPY web ./web
RUN npm --prefix web run build

# ─── server deps stage ────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS deps
WORKDIR /build
COPY package*.json ./
# --omit=optional skips better-sqlite3: it is only a fallback for Node < 24,
# and skipping it keeps this stage toolchain-free.
RUN npm ci --omit=dev --omit=optional

# ─── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8710 \
    HOST=0.0.0.0
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data

COPY --from=deps  /build/node_modules ./node_modules
COPY --from=web   /build/web/dist     ./web/dist
COPY server ./server
# The demo seed is documented in the README as the way to look around before importing
# anything, so it has to be in the image rather than only in a source checkout.
# All the test files come along — they are how `docker exec fitberg npm test` is
# supposed to work, and a partial copy breaks the imports between test files.
COPY test ./test
COPY package.json ./

USER node
VOLUME /data
EXPOSE 8710

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8710)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
