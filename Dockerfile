# syntax=docker/dockerfile:1.7
###############################################################################
# Ziyarati backend — production image (NestJS API + BullMQ worker)
#
# ONE image, TWO entrypoints. `src/main.ts` (HTTP API) and `src/worker.ts`
# (BullMQ consumer) are two process roots of the SAME compiled tree — see
# worker.ts's docstring ("deployed as a SEPARATE service"). Building them
# separately would let the two drift; instead the image defaults to the API and
# the worker deployment overrides the command:
#
#   API     : (default CMD)         node dist/src/main.js
#   Worker  : command override      node dist/src/worker.js
#   Migrate : command override      node dist/src/migrate.js
#
# Build:  docker build -t ziyarati-backend:local .
###############################################################################

# Pinned to a specific minor so a rebuild resolves the same base. Alpine is safe
# here: every RUNTIME dependency (pg, ioredis, bcryptjs, @aws-sdk, prom-client,
# pdf-parse, socket.io, pdfkit, bidi-js) is pure JavaScript — the only native
# artefacts in the tree belong to devDependencies (artillery/eslint), which
# never reach the runtime stage.
ARG NODE_IMAGE=node:24.11-alpine3.22

# ─────────────────────────── Stage 1: dependencies ──────────────────────────
# `npm ci` (not `npm install`) so the lockfile is the single source of truth and
# the resolved tree is byte-reproducible across builds and machines.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ──────────────────────────── Stage 2: build ────────────────────────────────
# TypeScript → JavaScript INSIDE the image (never copy a host-built dist/ in:
# the host's dist may be stale, built from different sources, or built on a
# different platform). Output lands in dist/src/** — package.json's own
# `start:prod` (`node dist/src/main`) already assumes this layout.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build \
 && test -f dist/src/main.js \
 && test -f dist/src/worker.js \
 && test -f dist/src/migrate.js \
 && test -f dist/src/config/data-source.js \
 && test -d dist/src/migrations \
 && test -d dist/src/entities

# ────────────────────── Stage 3: production dependencies ────────────────────
# A SECOND, independent install with devDependencies omitted. Pruning the
# stage-1 tree in place is not equivalent — `npm prune` leaves hoisted
# transitive devDependency artefacts behind.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ─────────────────────────── Stage 4: runtime ───────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# NODE_ENV=production is a floor, not a lock — the platform still injects the
# full environment. Set here so a misconfigured platform cannot accidentally
# boot this image in development mode (which would, among other things, allow
# TypeORM synchronize and unauthenticated API docs).
#
# TZ=UTC is pinned deliberately. This is a scheduling product: appointment
# local wall-time is derived from each branch's own IANA timezone
# (Branch.timezone / Appointment.booked_timezone), never from the process
# timezone. Pinning UTC keeps every server-side Date computation, log timestamp
# and cron evaluation identical across hosts, so a platform that injects a
# local TZ cannot shift them. This matches what the base image already
# resolves to — it makes the assumption explicit rather than changing it.
ENV NODE_ENV=production \
    PORT=3000 \
    TZ=UTC \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# `tini` as PID 1 reaps zombies and forwards signals. main.ts / worker.ts BOTH
# install their own SIGTERM/SIGINT handlers for graceful shutdown (app.close()
# → onModuleDestroy → BullMQ drain, Redis/DB teardown); tini guarantees the
# signal actually reaches them and that no orphaned child survives.
RUN apk add --no-cache tini

# Non-root. The `node` user (uid/gid 1000) ships with the base image. Nothing in
# the app writes to disk at runtime — uploads go to Cloudflare R2 — so the whole
# tree can stay read-only-for-the-app and root-owned-by-nobody.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY               --chown=node:node package.json         ./package.json

USER node

EXPOSE 3000

# Liveness only — main.ts serves /api/v1/health from a raw handler that touches
# neither Postgres nor Redis, so this answers "is the process serving HTTP?"
# without turning a datastore blip into a container restart loop. Readiness
# (DB + Redis reachable) is a separate, orchestrator-level concern:
# GET /api/v1/system/health/readiness.
#
# Uses Node's built-in fetch (no curl/wget in the image) and honours $PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]

# Exec form, and `node` directly — NOT `npm run start:prod`. npm would sit
# between tini and the app as an extra process that does not forward SIGTERM,
# silently defeating main.ts's graceful-shutdown handler.
CMD ["node", "dist/src/main.js"]
