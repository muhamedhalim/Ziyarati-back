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
# here: the runtime dependencies are pure JavaScript except native `bcrypt`,
# whose prebuilt binary for linux-x64 musl was verified on this exact base
# (P1.2, 2026-09-04). linux-arm64 musl is NOT verified yet — keep ECS tasks on
# X86_64 until it is (infra/docs/CURRENT-STATE-AUDIT.md F-12).
ARG NODE_IMAGE=node:24.16.0-alpine3.22
# Amazon RDS trust anchors. Production refuses to connect to Postgres without
# validating the server certificate (database-ssl.ts, ZT-012); the ECS task sets
# DB_SSL_CA=/app/certs/rds-global-bundle.pem. Public CA bundle, not a secret.
ARG RDS_CA_BUNDLE_URL=https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

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
# /app/certs is created here (0755) on purpose: letting ADD --chmod=644 create
# it applies 644 to the DIRECTORY too, which the non-root user cannot traverse
# — the DB CA would be unreadable and production boot would fail.
#
# `apk upgrade` first: the official node images lag the Alpine repositories by weeks, so
# even the newest base ships openssl/zlib/musl that ECR basic scanning reports as
# CRITICAL/HIGH (2026-10-08: openssl 3.5.4 -> CVE-2026-31789 et al.; fixed in 3.5.9). This
# trades bit-for-bit base reproducibility for current OS security patches; the base tag
# stays pinned and the vulnerability gate in scripts/ecs-deploy.sh is the check.
RUN apk upgrade --no-cache \
 && apk add --no-cache tini \
 && mkdir -p /app/certs && chmod 0755 /app/certs

# Non-root. The `node` user (uid/gid 1000) ships with the base image. Nothing in
# the app writes to disk at runtime — uploads go to object storage (S3, or R2
# until cutover) — so the tree can stay read-only (ECS: readonlyRootFilesystem
# with a writable /tmp).
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY               --chown=node:node package.json         ./package.json
# (A pre-FROM ARG is only visible to FROM lines — re-declare it for this stage.)
ARG RDS_CA_BUNDLE_URL
ADD --chmod=644 ${RDS_CA_BUNDLE_URL} /app/certs/rds-global-bundle.pem

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
