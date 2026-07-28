# syntax=docker/dockerfile:1
#
# Multi-stage build. Three stages produce the two dist trees the runtime stage actually needs
# (server `dist/`, client `dist/`); a fourth (runtime) carries neither a compiler nor dev
# dependencies.
#
# Only the RUNTIME stage is left unpinned, which under `docker buildx build --platform
# linux/amd64,linux/arm64` means "build under TARGETPLATFORM" (via QEMU emulation when
# cross-building): its own `npm ci --omit=dev` node_modules — including better-sqlite3's native
# addon — is what actually ships in the final image, so it alone must match the architecture the
# container will RUN on.
#
# The "client" and "server" stages below ARE pinned to `--platform=$BUILDPLATFORM` (the build
# host's own architecture, never emulated). Neither stage's `node_modules` — nor either one's own
# better-sqlite3 compile, triggered incidentally by their own `npm ci` — is copied into the final
# image: "client" hands forward only `client/dist` (static JS/CSS from `vite build`,
# arch-independent), and "server" hands forward only `dist/` (plain JS from `tsc`) and the
# migrations' `.sql` files — see the `COPY --from=` lines in the runtime stage below. Running these
# two stages natively instead of under QEMU skips a redundant emulated better-sqlite3 compile per
# target architecture (measured as the slowest single step in a multi-arch build) with no effect
# on what ships.

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS server
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
# LIVENESS ONLY — a deliberate policy, not an oversight. This does NOT fail on
# `status: "degraded"` (an unreachable Jellyfin, qBittorrent, Radarr, or Sonarr): Jellymaid deletes
# files, and an orchestrator that restarts an "unhealthy" container (autoheal, Unraid's container
# monitor, Swarm/Kubernetes) will do so mid-plan just as readily as it would restart a crashed one —
# manufacturing exactly the stuck-`running`-plan state a restart is supposed to recover from. A
# degraded connector is a condition for the operator to see and act on in the UI, never a reason to
# kill this process. Failing on `degraded` also can't be fixed by waiting it out: each connector's
# ping result is cached for PING_TTL_MS (5s, src/api/health.ts), far shorter than this
# HEALTHCHECK's own --interval (30s), so a connector that is merely slower than the probe deadline
# — not actually down — would read as unhealthy FOREVER, with no interval short enough to ever
# catch its own cached-good result before it expires. "Healthy" here means only: the process is up
# and /healthz answers with a well-formed JSON body (a `status` field of some kind) — nothing about
# that field's value. Uses Node's built-in fetch (stable since Node 18, no flag needed) so the
# runtime image does not need to carry curl at all. Pinned against the real response shape by
# tests/deploy/healthcheck.test.ts, which extracts and runs this exact command string against a
# live server — a future field rename in src/api/health.ts that this comment doesn't catch, that
# test will.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const port=process.env.PORT||8099;fetch('http://127.0.0.1:'+port+'/healthz').then(r=>r.json()).then(j=>process.exit(typeof j.status==='string'?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/src/index.js"]
