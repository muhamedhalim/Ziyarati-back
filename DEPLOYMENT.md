# Production deployment — Ziyarati backend

Operator reference for deploying this service. `.env.example` is the
authoritative per-variable documentation; this file is the procedure and the
short list of what must be configured on the hosting platform.

---

## 1. Topology

The service is **two process roots built from one image**:

| Deployment | Command                    | What it does                                  |
| ---------- | -------------------------- | --------------------------------------------- |
| API        | `node dist/src/main.js`    | HTTP + WebSocket. Enqueues jobs, never consumes. |
| Worker     | `node dist/src/worker.js`  | Consumes BullMQ jobs. No HTTP adapter (only a Prometheus listener on `WORKER_METRICS_PORT`). |
| Migrate    | `node dist/src/migrate.js` | One-shot. Applies pending migrations, exits 0/1. |

Both long-running roots need PostgreSQL (pgvector) and Redis.

Building one image for both is deliberate: the two roots share the entire
compiled tree, so separate images could drift.

---

## 2. Build and run

```bash
docker build -t ziyarati-backend:<tag> .
```

The image is multi-stage (deps → build → prod-deps → runtime), compiles
TypeScript inside the build stage, runs as the non-root `node` user, uses
`tini` as PID 1 so `SIGTERM` reaches the app's graceful-shutdown handler, and
carries a `HEALTHCHECK` against `GET /api/v1/health`.

`PORT` is honoured (default 3000) and the server binds `0.0.0.0`.

To run the full production-shaped stack locally — including a TLS-serving
Postgres, so the production certificate-validation path is genuinely exercised:

```bash
bash deploy/generate-local-tls.sh
cp .env.example .env.production.local     # then fill in real values
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d api worker
```

---

## 3. Migrations

Schema is owned by migrations. `TYPEORM_SYNCHRONIZE=true` together with
`NODE_ENV=production` is a hard boot error.

**Deploy-time command (run before the new API/worker containers start):**

```bash
docker run --rm --env-file <your-env> ziyarati-backend:<tag> node dist/src/migrate.js run
```

or, with the bundled compose stack:

```bash
docker compose -f docker-compose.prod.yml run --rm migrate
```

Other commands: `node dist/src/migrate.js show` (status, read-only) and
`node dist/src/migrate.js revert` (undo the single most recent migration).
The same three are exposed as `npm run migration:run` / `:show` / `:revert`.

**The API also runs pending migrations on boot**, serialized across every
process root and replica by a Postgres advisory lock
(`src/config/run-migrations-with-lock.ts`). That is the safety net that
guarantees no process ever serves traffic against an unmigrated schema.
Running both the explicit step and the boot-time run is safe and expected:
whichever goes first applies them, the other finds none pending.

Migrations use `migrationsTransactionMode: 'each'` — each commits
independently, which is required for the `CREATE INDEX CONCURRENTLY` and
`ALTER TYPE ... ADD VALUE` migrations.

To verify migrations against a throwaway database (creates, migrates from
empty, asserts schema, exercises the down migration, drops):

```bash
npm run migration:verify
```

---

## 4. Required production environment

`.env.example` documents every variable. These are the ones a deploy **fails
without** — each is enforced by an explicit fail-fast in
`src/config/env.validation.ts` (or, for `WORKER_ROLE`, `src/worker.module.ts`).

### Mandatory — both API and worker

| Variable | Expected value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@HOST:PORT/DB` — pgvector must be available |
| `REDIS_URL` | `rediss://…` (or `redis://` on a private network). Parsed for host/port/credentials/db |
| `JWT_ACCESS_SECRET` | high-entropy random, `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | a **different** high-entropy random value |
| `CREDENTIALS_ENCRYPTION_KEY` | base64/hex decoding to **exactly 32 bytes**, `openssl rand -base64 32` |
| `FRONTEND_ORIGIN` | comma-separated full origins, no trailing slash, e.g. `https://app.example.com` |
| `AUTH_REGISTER_OWNER_ENDPOINT_CEILING` | integer, sized from real expected signup volume |
| `DB_SSL_CA` **or** `DB_SSL_CA_CERT` | exactly one, never both. Path to a PEM file, or the inline PEM |

### Mandatory — worker deployment only

Every variable a job needs must be set on the **worker** service, not just the
API — the API only enqueues. In 2026-09 the worker ran with `EMAIL_FROM=""`
while the API held a valid value, and every email failed for four weeks.

| Variable | Expected value |
| --- | --- |
| `WORKER_ROLE` | `all` \| `critical` \| `dispatch`. **Must not be set on the API.** |

### Conditionally mandatory

| Variable | When |
| --- | --- |
| `MOYASAR_SECRET_KEY`, `MOYASAR_WEBHOOK_SECRET` | whenever `PAYMENT_PROVIDER` is not `noop` (the default is `moyasar`). Without them the boot fails rather than falling back to the provider that *simulates* successful payments. |
| `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_WEBHOOK_VERIFY_TOKEN` | all four, or none. A *partial* Meta configuration is a boot error. |
| `METRICS_TOKEN` | required in practice: with it unset, `/metrics` answers 401 in production. |
| `RESEND_API_KEY`, `EMAIL_FROM` | whenever `EMAIL_PROVIDER=resend` (the default) and email is enabled (the production default). Boot fails when either is blank or `EMAIL_FROM` is not `addr` / `Name <addr>`. **Set them on the worker** — it is the process that sends. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | all four together, or every upload route fails closed with 503 (default `STORAGE_PROVIDER=r2`). |
| `S3_BUCKET` + `S3_REGION`/`AWS_REGION` | whenever `STORAGE_PROVIDER=s3` (AWS). No keys: the IAM task role authenticates. Boot fails without them. |
| `SES_REGION`/`AWS_REGION`, `EMAIL_FROM` | whenever `EMAIL_PROVIDER=ses` (AWS) and email is enabled. No API key: the IAM task role authenticates. `SES_FEEDBACK_QUEUE_URL` (worker) enables bounce/complaint handling. |

### Must be false / unset in production

`TYPEORM_SYNCHRONIZE`, `TYPEORM_LOGGING`, `AUTH_EXPOSE_RESET_TOKEN`
(each is a hard boot error when `true`), plus `ENABLE_API_DOCS`,
`ENABLE_INTEGRATION_DOCS`, `INTEGRATION_OAUTH_TEST_PROVIDER`,
`INTEGRATION_ALLOW_INSECURE_BASE_URL`, `INTEGRATION_ALLOW_PRIVATE_BASE_URL`.

### Recommended

`SEED_ON_STARTUP=false` — provision the super-admin once with `npm run seed`
(supplying `ADMIN_EMAIL` / `ADMIN_PASSWORD` for that run only) rather than
running the seeder on every container start. In production the admin seed skips
entirely when those two are unset; it never fabricates credentials.

---

## 5. Secrets to configure on the hosting platform

Set these as platform secrets — never in the image, never in the repository:

`DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`CREDENTIALS_ENCRYPTION_KEY`, `METRICS_TOKEN`, `MOYASAR_SECRET_KEY`,
`MOYASAR_WEBHOOK_SECRET`, `MOYASAR_PUBLISHABLE_KEY`, `META_APP_SECRET`,
`META_WEBHOOK_VERIFY_TOKEN`, `RESEND_API_KEY`, `OPENAI_API_KEY`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `DB_SSL_CA_CERT` (or the file
behind `DB_SSL_CA`), and `ADMIN_PASSWORD` if used for a one-off seed run.

Rotating `CREDENTIALS_ENCRYPTION_KEY` makes every already-stored tenant
provider credential undecryptable — treat it as permanent unless you also plan
a re-encryption pass.

---

## 6. Networking and reverse proxy

* **Health:** `GET /api/v1/health` is liveness (no datastore access — safe as a
  container/LB probe). `GET /api/v1/system/health/readiness` checks Postgres
  and Redis with a 1.5 s per-dependency timeout and answers `503 degraded` when
  either is down. Point restart probes at liveness and traffic-admission
  probes at readiness.
* **TLS termination** happens at the platform edge. The app emits HSTS only
  when `NODE_ENV=production` *and* the request carries
  `x-forwarded-proto: https`, so the proxy must set that header.
* **`trust proxy` is deliberately NOT enabled** (`src/config/security-headers.ts`).
  Enabling it would change the abuse-resistance throttle key derivation. The
  consequence to know: `req.ip` is the proxy's address, so the audit-log IP and
  the global `ThrottlerGuard` key are per-proxy, not per-client. The auth abuse
  limiters key on identity (email/account), not IP, so they are unaffected.
* **Cookies:** `Secure` is derived from `NODE_ENV=production` and is not
  configurable. Same-origin deployments (SPA behind a Next.js rewrite) want
  `COOKIE_SAMESITE=lax`; a genuinely cross-site SPA needs
  `COOKIE_SAMESITE=none`. Leave `COOKIE_DOMAIN` unset for host-only cookies
  unless you deliberately want them shared across subdomains.
* **CSRF** is double-submit: the API issues a non-HttpOnly `csrf_token` cookie
  and the SPA must echo it in `X-CSRF-Token` on state-changing requests.
* **Webhooks** must be reachable at the public origin and are
  signature-verified — Meta with `META_APP_SECRET`, Moyasar with
  `MOYASAR_WEBHOOK_SECRET`. Both verifiers fail closed when their secret is
  unset; there is no development bypass.

---

## 7. Scaling notes

* `API_CLUSTER_WORKERS` (1–8, default 1) forks the API with Node `cluster`.
  Total DB connections are `API_CLUSTER_WORKERS × API_DB_POOL_MAX` per
  container — size against Postgres's `max_connections`.
* Split the worker into two deployments (`WORKER_ROLE=critical` and
  `WORKER_ROLE=dispatch`), each with its own `WORKER_DB_POOL_MAX`, once
  campaign dispatch throughput needs isolating. `all` is a supported choice for
  a small deployment and logs a warning so the choice stays visible.
* Set `QUEUE_ENV_PREFIX` if staging and production ever share one Redis
  database — without it they consume each other's jobs.
* Redis holds BullMQ job state, so it must run `maxmemory-policy noeviction`
  with AOF enabled. The app audits this at boot; on managed Redis where
  `CONFIG GET` is blocked, set `REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC=true`.

---

## 8. Background job observability

* A job that cannot succeed (bad email sender or recipient, missing tenant
  configuration) ends in BullMQ's **failed** set after one attempt
  (`UnrecoverableError`); transient errors retry with backoff. `QueueMonitor`
  on the worker logs every final failure as `[<queue>] ✗ failed job=…`.
* A completed job is not the same as a delivered email. `email_logs` (and
  `GET /api/v1/platform/email-logs`, super-admin) records the outcome per
  message — `SENT` means Resend accepted it.
* Re-drive a failed email job by retrying it in BullMQ: its `email_logs` row is
  `FAILED`, so the retry re-claims it and sends once. Failed email jobs are
  kept for 6 hours (PII retention).

## 9. Graceful shutdown

Both roots install `SIGTERM`/`SIGINT` handlers and call `app.close()`, which
runs every `onModuleDestroy` hook — the worker drains in-flight BullMQ jobs and
both close their Redis and Postgres connections. `tini` is PID 1 in the image
so the signal actually arrives. Allow at least **30 s** of termination grace in
the platform's deployment settings (the clustered API primary waits up to 25 s
for its forked workers before force-killing).

## 10. AWS (ECS Fargate / RDS / ElastiCache / S3 / SES)

The AWS target architecture, Terraform, and the Railway → AWS migration runbook
live in [`infra/`](infra/README.md). On AWS the ECS task definitions set the
platform variables (`STORAGE_PROVIDER=s3`, `EMAIL_PROVIDER=ses`,
`DB_SSL_CA=/app/certs/rds-global-bundle.pem` — the RDS CA bundle is baked
into the image — `REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC=true`, `NO_COLOR=1`)
and inject secrets from Secrets Manager; see `infra/docs/DEPLOYMENT.md`.
