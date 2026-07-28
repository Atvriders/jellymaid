# syntax=docker/dockerfile:1
#
# Multi-stage build. Three stages produce the two dist trees the runtime stage actually needs
# (server `dist/`, client `dist/`); a fourth (runtime) carries neither a compiler nor dev
# dependencies. No stage here pins `--platform=$BUILDPLATFORM`: when this image is built with
# `docker buildx build --platform linux/amd64,linux/arm64`, buildx runs EVERY stage under each
# requested TARGET platform (via QEMU emulation when cross-building), so `npm ci` in the "server"
# and "runtime" stages below always compiles/fetches better-sqlite3's native addon for the
# platform the image will actually RUN on. Forcing any of these three stages onto the build
# host's own architecture (via $BUILDPLATFORM) would bake in the wrong ABI for the other target
# and produce an image that fails at require() time on that architecture — so don't.

FROM node:22-bookworm-slim AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-bookworm-slim AS server
WORKDIR /app
# better-sqlite3 compiles from source when no prebuilt binary matches the platform/ABI.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
# tsc directly, not `npm run build`: that script also drives the CLIENT sub-build
# (`npm --prefix client install && npm --prefix client run build`), which has no client/ source
# in this stage and would fail. The client has its own stage above. tsconfig.json's "include"
# also lists tests/**/*.ts, but tests/ is deliberately never copied into this stage, so that
# glob matches nothing and only src/ is compiled — dist/ here holds no test code.
RUN npx tsc -p tsconfig.json

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8099 DATA_DIR=/data
# Same toolchain as the server stage, for the same reason: this stage's OWN `npm ci` (a separate
# install, not a copy of the server stage's node_modules) may need to compile better-sqlite3's
# native addon for this stage's platform too. Purged below once npm ci is done — a production
# image has no business shipping a compiler.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
COPY --from=server /app/dist ./dist
# Copied from SOURCE (not from the server stage's dist output — plain .sql is not something tsc
# emits), because the server cannot open its database without these migrations on disk.
COPY --from=server /app/src/index/migrations ./dist/src/index/migrations
COPY --from=client /app/client/dist ./client/dist
# /data is a required bind mount (index, config, audit log, trash manifest all live there — see
# docker-compose.yml) and the operator's PUID/PGID (also in docker-compose.yml) may not be 1000,
# so this chown only sets up the image's OWN default; a compose-level `user:` override changes
# who the process runs as without needing this directory to be re-owned at build time.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8099
# Checks the ACTUAL reported status, not just that the HTTP server answers. /healthz always
# replies 200 even when it is reporting `status: "degraded"` (an unreachable Jellyfin or
# qBittorrent, say) — a plain `curl -f` would call that healthy. Uses Node's built-in fetch
# (stable since Node 18, no flag needed) so the runtime image does not need to carry curl at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const port=process.env.PORT||8099;fetch('http://127.0.0.1:'+port+'/healthz').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/src/index.js"]
