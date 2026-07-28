# Jellymaid Plan 6 — Ship Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public multi-arch image on GHCR that runs the whole thing from one `docker compose up`, with the trash purge running on schedule, a health probe that tells the truth, and a README that makes the deletion risk impossible to miss.

**Architecture:** Multi-stage Dockerfile — one stage builds the client, one builds the server, the runtime stage carries only production dependencies and the two `dist` trees. GitHub Actions gates the image behind typecheck and tests, then builds `linux/amd64` and `linux/arm64` with buildx and pushes to `ghcr.io/atvriders/jellymaid`.

**Tech Stack:** Docker buildx · GitHub Actions · Node 22 slim base · better-sqlite3 (needs a build toolchain in the build stage only)

## Global Constraints

- Repo `Atvriders/jellymaid`, public. Image `ghcr.io/atvriders/jellymaid`, public, multi-arch (`linux/amd64`, `linux/arm64`).
- `/data` bind mount is **required** — the index, config, audit log and trash manifest all live there.
- CI gate: typecheck → test → build must pass before any image is published.
- The README states plainly that Jellymaid deletes media, and documents the guard defaults.
- TypeScript strict, no `any`. Commit after every task.

## Prerequisites

Plans 1–5 complete. `npm test`, `npm run typecheck`, `npm run build` and the client build all pass.

---

### Task 1: Trash purge scheduling and honest health

**Files:**
- Modify: `src/index.ts` (purge scheduler), `src/api/health.ts` (all four connectors)
- Test: `tests/api/health.test.ts` (extend)

**Interfaces:**
- Produces: `/healthz` reporting `{ status, schemaVersion, connectors: { jellyfin, qbittorrent, radarr, sonarr }, lastScan, indexCounts }`, where an unconfigured optional connector reports `not-configured` — distinct from `unreachable`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/health.test.ts — additional cases
describe('GET /healthz — all connectors', () => {
  it('reports every configured connector', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: { ping: async () => {} },
      sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.connectors).toEqual({ jellyfin: 'ok', qbittorrent: 'ok', radarr: 'ok', sonarr: 'not-configured' })
  })

  it('distinguishes not-configured from unreachable', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => { throw Object.assign(new Error('x'), { kind: 'unreachable' }) } },
      radarr: null,
      sonarr: null,
    }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.connectors.qbittorrent).toBe('unreachable')
    expect(body.connectors.radarr).toBe('not-configured')
    expect(body.status).toBe('degraded')
  })

  it('an unconfigured optional connector does not make the service degraded', async () => {
    const app = buildServer(depsWith({
      jellyfin: { ping: async () => {} },
      qbittorrent: { ping: async () => {} },
      radarr: null,
      sonarr: null,
    }))
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().status).toBe('ok')
  })

  it('reports index row counts so an empty index is visible at a glance', async () => {
    const app = buildServer(depsWith({ jellyfin: { ping: async () => {} }, qbittorrent: { ping: async () => {} }, radarr: null, sonarr: null }))
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json()
    expect(body.indexCounts).toMatchObject({ jellyfinItems: 0, fsEntries: 0, findings: 0 })
  })
})
```

`depsWith` is a small helper in this file that builds the same stub `ServerDeps` used by the existing tests, with the connectors replaced.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/api/health.test.ts`
Expected: FAIL — connectors object has only `jellyfin`.

- [ ] **Step 3: Widen the health route**

```ts
// src/api/health.ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../index/db.js'
import { currentSchemaVersion } from '../index/db.js'

type Pingable = { ping(): Promise<void> } | null

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { db: Db; jellyfin: Pingable; qbittorrent: Pingable; radarr: Pingable; sonarr: Pingable },
): void {
  app.get('/healthz', async (_req, reply) => {
    const connectors: Record<string, string> = {}
    let degraded = false
    for (const [name, client] of [
      ['jellyfin', deps.jellyfin], ['qbittorrent', deps.qbittorrent],
      ['radarr', deps.radarr], ['sonarr', deps.sonarr],
    ] as const) {
      if (!client) { connectors[name] = 'not-configured'; continue }
      try {
        await client.ping()
        connectors[name] = 'ok'
      } catch (err) {
        connectors[name] = (err as { kind?: string }).kind ?? 'unreachable'
        degraded = true
      }
    }

    const count = (sql: string) => (deps.db.prepare(sql).get() as { c: number }).c
    return reply.send({
      status: degraded ? 'degraded' : 'ok',
      schemaVersion: currentSchemaVersion(deps.db),
      connectors,
      lastScan: deps.db.prepare('SELECT id, status, started_at, finished_at FROM scans ORDER BY id DESC LIMIT 1').get() ?? null,
      indexCounts: {
        jellyfinItems: count('SELECT COUNT(*) c FROM jellyfin_items'),
        fsEntries: count('SELECT COUNT(*) c FROM fs_entries'),
        torrents: count('SELECT COUNT(*) c FROM torrents'),
        findings: count("SELECT COUNT(*) c FROM findings WHERE status = 'open'"),
      },
    })
  })
}
```

- [ ] **Step 4: Schedule the trash purge**

In `src/index.ts`, alongside the scan scheduler:

```ts
import { purgeExpiredTrash } from './plan/trash.js'

const purgeScheduler = createScheduler({
  cron: '30 4 * * *',
  isRunning: () => false,
  run: async () => {
    const { purged, failed } = purgeExpiredTrash({
      db, config: config.file, pathMap: createPathMap(config.file.pathMappings),
    })
    if (purged) logger.info('purged expired trash', { purged })
    // A file that could not be removed keeps its trash row deliberately — the row is the
    // only record that it exists. Say so, or the operator never learns it is stuck.
    if (failed.length) logger.warn('some trash entries could not be purged', { failed })
  },
})
purgeScheduler.start()
```

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run && npm run typecheck`

```bash
git add src/api/health.ts src/index.ts tests/api/health.test.ts
git commit -m "feat: full connector health, index counts and scheduled trash purge"
```

---

### Task 2: Dockerfile and compose

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`
- Test: `tests/deploy/dockerfile.test.ts`

**Interfaces:**
- Produces: an image whose entrypoint is `node dist/src/index.js`, listening on `PORT` (default 8099), with `/data` as the state volume.

- [ ] **Step 1: Write the failing test**

```ts
// tests/deploy/dockerfile.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const dockerfile = () => readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
const compose = () => readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')

describe('Dockerfile', () => {
  it('builds in stages so the runtime carries no compiler', () => {
    const stages = dockerfile().match(/^FROM /gm) ?? []
    expect(stages.length).toBeGreaterThanOrEqual(3)
  })

  it('targets Node 22', () => {
    expect(dockerfile()).toMatch(/FROM node:22/)
  })

  it('installs only production dependencies in the runtime stage', () => {
    expect(dockerfile()).toMatch(/npm ci --omit=dev/)
  })

  it('copies the migration SQL into the image — the server cannot start without it', () => {
    expect(dockerfile()).toMatch(/migrations/)
  })

  it('copies the built client', () => {
    expect(dockerfile()).toMatch(/client\/dist/)
  })

  it('declares the data volume and a healthcheck', () => {
    expect(dockerfile()).toMatch(/VOLUME .*\/data/)
    expect(dockerfile()).toMatch(/HEALTHCHECK/)
  })

  it('does not run as root', () => {
    expect(dockerfile()).toMatch(/^USER (?!root)/m)
  })
})

describe('docker-compose.yml', () => {
  it('references the public GHCR image', () => {
    expect(compose()).toContain('ghcr.io/atvriders/jellymaid')
  })

  it('bind-mounts /data, which is required for the index and audit log', () => {
    expect(compose()).toMatch(/:\/data/)
  })

  it('documents every required environment variable', () => {
    for (const key of ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'QBIT_URL', 'QBIT_USER', 'QBIT_PASS']) {
      expect(compose()).toContain(key)
    }
  })

  it('mounts media read-write, since Jellymaid must remove empty folders and leftover links', () => {
    expect(compose()).toMatch(/\/mnt\/media/)
    expect(compose()).not.toMatch(/\/mnt\/media:ro/)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/deploy/dockerfile.test.ts`
Expected: FAIL — files not found.

- [ ] **Step 3: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-bookworm-slim AS server
WORKDIR /app
# better-sqlite3 compiles from source when no prebuilt binary matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8099 DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && apt-get purge -y python3 make g++ && apt-get autoremove -y
COPY --from=server /app/dist ./dist
COPY --from=server /app/src/index/migrations ./dist/src/index/migrations
COPY --from=client /app/client/dist ./client/dist
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8099/healthz || exit 1
USER node
CMD ["node", "dist/src/index.js"]
```

- [ ] **Step 4: Write compose, dockerignore and env example**

```yaml
# docker-compose.yml
services:
  jellymaid:
    image: ghcr.io/atvriders/jellymaid:latest
    container_name: jellymaid
    restart: unless-stopped
    ports:
      - "8099:8099"
    environment:
      JELLYFIN_URL: "http://192.0.2.10:8096"
      JELLYFIN_API_KEY: "${JELLYFIN_API_KEY}"
      QBIT_URL: "http://192.0.2.10:8080"
      QBIT_USER: "${QBIT_USER}"
      QBIT_PASS: "${QBIT_PASS}"
      # Optional. Jellymaid only ever unmonitors in these — it never deletes or blocklists.
      RADARR_URL: "http://192.0.2.11:7878"
      RADARR_API_KEY: "${RADARR_API_KEY}"
      SONARR_URL: "http://192.0.2.11:8989"
      SONARR_API_KEY: "${SONARR_API_KEY}"
      TZ: "UTC"
      # Must equal the number of proxies actually in front of this service — behind a single
      # Cloudflare tunnel that is 1. Setting it HIGHER than the real count lets a caller forge
      # X-Forwarded-For and reinstate the login-lockout bypass this setting exists to close.
      TRUST_PROXY: "1"
    volumes:
      # REQUIRED: index, config, audit log and trash manifest live here.
      - ./data:/data
      # Media and downloads, read-write: empty folders and leftover hardlinks cannot be
      # removed through any API, only on disk.
      - /path/to/media:/mnt/media
      - /path/to/downloads:/mnt/downloads
```

```
# .dockerignore
node_modules
client/node_modules
dist
client/dist
data
.git
docs
*.log
```

```
# .env.example
JELLYFIN_API_KEY=
QBIT_USER=
QBIT_PASS=
RADARR_API_KEY=
SONARR_API_KEY=
```

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run tests/deploy/dockerfile.test.ts && npx vitest run`

```bash
git add Dockerfile .dockerignore docker-compose.yml .env.example tests/deploy
git commit -m "feat: multi-stage dockerfile and compose"
```

---

### Task 3: CI publish to GHCR

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/publish.yml`

**Interfaces:**
- Produces: on push to `master` and on `workflow_dispatch`, a multi-arch image at `ghcr.io/atvriders/jellymaid:latest` and `:sha-<short>`, published only after the verify job passes.

- [ ] **Step 1: Extend CI to cover the client**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [master]
  pull_request:
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - name: Client
        working-directory: client
        run: |
          npm ci
          npm test
          npm run build
```

- [ ] **Step 2: Write the publish workflow**

```yaml
# .github/workflows/publish.yml
name: Publish
on:
  push:
    branches: [master]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  verify:
    uses: ./.github/workflows/ci.yml

  publish:
    needs: verify
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/atvriders/jellymaid
          tags: |
            type=raw,value=latest
            type=sha,prefix=sha-,format=short
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 3: Verify the workflow files parse**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/publish.yml','utf8'); if(!y.includes('linux/arm64')) throw new Error('missing arm64'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 4: Commit and confirm the run**

```bash
git add .github/workflows
git commit -m "ci: publish multi-arch image to ghcr behind the test gate"
```

After pushing, confirm the Actions run is green and the package appears. Per the fleet convention the GHCR package must be **public** — check the package settings after the first successful publish and flip visibility if GitHub defaulted it to private.

---

### Task 4: README and first-run verification

**Files:**
- Create: `README.md`
- Test: `tests/deploy/readme.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/deploy/readme.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const readme = () => readFileSync(new URL('../../README.md', import.meta.url), 'utf8')

describe('README', () => {
  it('warns that Jellymaid deletes media', () => {
    expect(readme().toLowerCase()).toMatch(/deletes? (your )?media|permanently delete/)
  })

  it('states that Radarr and Sonarr are unmonitor-only', () => {
    expect(readme().toLowerCase()).toContain('unmonitor')
    expect(readme().toLowerCase()).toMatch(/never delet\w+ (from )?(radarr|sonarr)|does not delete/)
  })

  it('documents the required /data bind mount', () => {
    expect(readme()).toContain('/data')
  })

  it('documents the path map including download roots', () => {
    expect(readme()).toContain('pathMappings')
    expect(readme()).toContain('download')
  })

  it('documents the guard defaults', () => {
    expect(readme()).toContain('minRatio')
    expect(readme()).toContain('minSeedTimeDays')
  })

  it('lists every required environment variable', () => {
    for (const key of ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'QBIT_URL', 'QBIT_USER', 'QBIT_PASS']) {
      expect(readme()).toContain(key)
    }
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/deploy/readme.test.ts`
Expected: FAIL — README.md not found.

- [ ] **Step 3: Write the README**

It must cover, in this order:

1. **What it is** — one paragraph, and an unmissable warning that Jellymaid **permanently deletes media** and removes torrents with their data.
2. **What it will not do** — never deletes from Radarr/Sonarr, never blocklists, never acts without an approved plan.
3. **Quick start** — compose snippet, the required `/data` bind mount, the media/download mounts, the environment variables, first login with a Jellyfin **admin** account.
4. **Path mapping** — the three-field shape with `role`, why download roots exist (inode resolution for the hardlink and cross-seed guards), and the Verify button.
5. **How a delete actually runs** — the five ordered steps, verbatim from the spec.
6. **The four guards** — table with defaults (`minRatio 1.0`, `minSeedTimeDays 14`, protect lists empty), which are overridable and which are not.
7. **Trash** — small non-torrent files only, `trash.maxBytes` 1 GB, `trash.retentionDays` 30.
8. **Scanning** — `SCAN_CRON` default `0 3 * * *`, opt-in hashing per root, what "not evaluated" means.
9. **Troubleshooting** — path map verification failures, qBittorrent unreachable blocking deletes by design, resuming an interrupted scan, and `TRUST_PROXY`: it must equal the number of proxies actually in front of Jellymaid (1 behind a single Cloudflare tunnel) — set it too low and the per-IP login lockout locks every caller at once behind the collapsed proxy address; set it too high and a caller can forge `X-Forwarded-For` to defeat that same lockout.

- [ ] **Step 4: First-run verification against the real stack**

Run through this by hand and record the result in the commit message:

1. `docker compose up -d`, then `curl -fsS localhost:8099/healthz` — expect `status: ok` and four connector states.
2. Log in with a Jellyfin admin; confirm a non-admin account is refused.
3. Settings → auto-detect → verify: expect a high resolved ratio; fix mappings until it is 20/20.
4. Scan now; watch phases progress; confirm the four snapshot tables fill.
5. Findings and Duplicates populate; spot-check three duplicate groups by hand.
6. Queue **one** deliberately chosen throwaway file. Build the plan, read the dry run, approve, execute.
7. Confirm afterwards: the file is gone, qBittorrent no longer lists that torrent, Radarr shows the
   movie **unmonitored and still present**, the empty folder was swept, and History shows the chain.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/deploy/readme.test.ts
git commit -m "docs: README with deletion warning, guard defaults and first-run verification"
```

---

## Definition of done

- CI is green and `docker pull ghcr.io/atvriders/jellymaid:latest` works from a clean machine on both
  architectures; the GHCR package is public.
- `docker compose up -d` on the real host yields a container that passes its healthcheck.
- The seven manual verification steps above all pass, and the one deliberate deletion behaves exactly
  as documented — including Radarr still holding the movie, unmonitored.
- `grep -rn "blocklist\|blacklist" src/ client/src/` returns nothing.
