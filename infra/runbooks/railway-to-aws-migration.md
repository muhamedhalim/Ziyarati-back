# Railway → AWS migration — plan, DNS cutover and data-migration runbooks

| | |
|---|---|
| **Last revised** | 2026-10-15 (consolidation); sources dated 2026-10-08 … 2026-10-10 |
| **Documentation status** | Consolidated. Part A is current-state and verification; later parts are preserved dated documents. |
| **Scope** | The move of the backend from Railway / R2 / Resend to AWS: original plan, DNS cutover procedure, and the superseded data-migration runbook. |
| **Code references** | `infra/scripts/railway-migrate-task.sh`, `infra/scripts/aws-e2e/` |

## Contents

- [Part A: Current state and verification](#part-a-current-state-and-verification)
  - [A.1 Where things stand](#a1-where-things-stand)
  - [A.2 Open items](#a2-open-items)
  - [A.3 Source documents merged into this file](#a3-source-documents-merged-into-this-file)
- [Part B: Migration plan (Railway / R2 / Resend → AWS)](#part-b-migration-plan-railway--r2--resend--aws)
  - [Phase M0 — decisions & measurements (week 0)](#phase-m0--decisions--measurements-week-0)
  - [Phase M1 — foundation (week 1)](#phase-m1--foundation-week-1)
  - [Phase M2 — rehearsal in the production account (week 2)](#phase-m2--rehearsal-in-the-production-account-week-2)
  - [Phase M3 — cutover (≈ 03:00 KSA, 30–60 min freeze)](#phase-m3--cutover--0300-ksa-3060-min-freeze)
  - [Email: Resend → SES](#email-resend--ses)
  - [Storage: R2 → S3](#storage-r2--s3)
  - [Redis: Railway → ElastiCache](#redis-railway--elasticache)
  - [Application changes required (minimum set, done in this change)](#application-changes-required-minimum-set-done-in-this-change)
  - [Verification list (run on staging, then production at cutover)](#verification-list-run-on-staging-then-production-at-cutover)
  - [Residency gates before cutover (residency plan sections 16, 22)](#residency-gates-before-cutover-residency-plan-sections-16-22)
- [Part C: DNS cutover runbook (Railway → AWS)](#part-c-dns-cutover-runbook-railway--aws)
  - [Facts (verified 2026-10-08)](#facts-verified-2026-10-08)
  - [Gates — everything in this table must be GREEN before the flip](#gates--everything-in-this-table-must-be-green-before-the-flip)
  - [Cutover (≈10 min, reversible in ≈1 min)](#cutover-10-min-reversible-in-1-min)
  - [Rollback (≈1 min, no data to reconcile — AWS has no customer data yet)](#rollback-1-min-no-data-to-reconcile--aws-has-no-customer-data-yet)
  - [After cutover (not blockers)](#after-cutover-not-blockers)
- [Part D: Data migration runbook (SUPERSEDED, DO NOT RUN)](#part-d-data-migration-runbook-superseded-do-not-run)
  - [0. Hard rules for the whole procedure](#0-hard-rules-for-the-whole-procedure)
  - [1. Go/no-go gates (all read-only; no gate has been evaluated yet)](#1-gono-go-gates-all-read-only-no-gate-has-been-evaluated-yet)
  - [2. One-time setup (temporary resources, removed in §7)](#2-one-time-setup-temporary-resources-removed-in-7)
  - [3. Rehearsal (M2) — zero customer downtime, Railway keeps serving](#3-rehearsal-m2--zero-customer-downtime-railway-keeps-serving)
  - [4. Cutover (M3) — the only downtime](#4-cutover-m3--the-only-downtime)
  - [5. Rollback](#5-rollback)
  - [6. Key and configuration preservation](#6-key-and-configuration-preservation)
  - [7. Teardown (after rehearsal, and again after cutover)](#7-teardown-after-rehearsal-and-again-after-cutover)
  - [8. Documents (R2 → S3) — separate, same freeze](#8-documents-r2--s3--separate-same-freeze)
  - [9. Validation checklist](#9-validation-checklist)

---


## Part A: Current state and verification

> Authored in the 2026-10-15 consolidation. Parts B–D are the three documents of the Railway → AWS move, kept
> in sequence: plan (B), DNS cutover runbook (C), data-migration runbook (D, superseded). Where Part A and a later
> part disagree, **Part A wins**.

### A.1 Where things stand

- **The migration happened as a clean deployment, not a data migration.** The owner confirmed on 2026-10-08 that
  Railway held **no real production data**; AWS runs an empty RDS (PG 17.9) populated by migrations + seed.
  Therefore Part B's freeze / `pg_dump` → `pg_restore` / 14-day Railway rollback plan was **not used**, and
  Part D is **SUPERSEDED, DO NOT RUN** (its own banner).
- **DNS cutover (Part C) is stale in its status line.** It is headed "PREPARED, NOT EXECUTED" (2026-10-08). The
  2026-10-14 logging audit recorded `api.ziyaratech.com` resolving to `zt-production-api-…elb.amazonaws.com`
  — i.e. the cutover **has happened** (by 2026-10-14). Which of Part C's gates were green at the moment of the
  flip is **Not Verified**.
- Region: Part B assumed `me-central-1`; the stack is in `eu-central-1` (D-1, 2026-10-08).
- Two gates of Part C remained red when written: SES production access / domain verification, and SNS alert
  subscription confirmation. The 2026-10-15 AWS audit shows alert subscriptions still pointing at a personal
  mailbox ([INFRASTRUCTURE-AUDITS.md](../docs/INFRASTRUCTURE-AUDITS.md) Part D).

### A.2 Open items

| Item | Status |
|---|---|
| Confirm SES production access + domain verification and send a real-inbox test | **Not Verified** |
| Billing posture (platform mode defaults to FREE; `subscription_plans` empty) | **Pending** owner decision |
| Decommission / archive Railway services and the data-migration runbook | **Pending** |

### A.2a Railway dependency inventory (2026-10-17)

Verified by repository search only; the live Railway account and AWS account were **not** inspected (AWS CLI
timed out against the profile region `me-south-1`; the stack is in `eu-central-1`).

| Class | Where | Decision |
|---|---|---|
| Runtime / CI | No `RAILWAY_*` env var is read by `src/`, no `railway` entry in `package.json` or `.github/workflows` | Nothing to replace |
| Operational docs (updated 2026-10-17) | `.env.example` ("Railway service" → ECS service), comments in `database-ssl.ts`, `health.controller.ts`, `migrate.ts`, `redis.config.ts`, `redis-io.adapter.ts`, `scripts/perf/cluster-shutdown-probe.js` | Reworded; comments only |
| Kept until decommission | `subprocessor-register.ts` entry `railway` (state `active`: a legal register, change only with deletion evidence); `infra/scripts/railway-migrate-task.sh` (SUPERSEDED, refuses to run without a new decision); `tfvars` / variable descriptions that cite the Railway source | Retained on purpose |
| Historical / audit | `scripts/incidents/2026-09-email-token-exposure/*` (uses `railway ssh`), this file's Parts B–D, `tests/load/**` reports, load-test deny-lists (`railway.app` is a safety guard) | Never rewritten |

### A.3 Source documents merged into this file


| Former file | Now |
|---|---|
| `Ziyarati-back/infra/docs/MIGRATION.md` | [Part B](#part-b-migration-plan-railway--r2--resend--aws) |
| `Ziyarati-back/infra/runbooks/dns-cutover-railway-to-aws.md` | [Part C](#part-c-dns-cutover-runbook-railway--aws) |
| `Ziyarati-back/infra/runbooks/railway-to-aws-data-migration.md` | [Part D](#part-d-data-migration-runbook-superseded-do-not-run) |


---

## Part B: Migration plan (Railway / R2 / Resend → AWS)

> **Former file:** `MIGRATION.md`

**Shape:** build everything in parallel. Rehearse the full cutover once against production-account resources. Then do a short (≈30–60 min) write freeze at ~03:00 KSA. Keep Railway intact for 14 days as the rollback target.

**Why a freeze instead of zero downtime:** there's a single Postgres writer. A consistent `pg_dump` → `pg_restore` of a small DB takes minutes. Logical replication from Railway would avoid the freeze, but it needs `wal_level=logical` and replication privileges on Railway's managed Postgres (unverified) plus sequence resync. Choose it only if the rehearsal shows restore time > 45 min (DB ≳ 20–30 GB).

### Phase M0 — decisions & measurements (week 0)

- [ ] **D-1** residency / DR region decision (SECURITY §6, DISASTER-RECOVERY)
- [ ] **D-2** separate staging domain purchased (ARCHITECTURE §2.3)
- [ ] **D-3** AWS Organizations: management + `zt-staging` + `zt-production` accounts; Identity Center users with MFA
- [ ] Record Railway facts: `SELECT version();`, `SELECT pg_size_pretty(pg_database_size(current_database()));`, `SELECT extname, extversion FROM pg_extension;`, Redis `INFO server`/`INFO memory`, R2 `rclone size`, monthly `email_logs` counts. **RDS major version must be ≥ the Railway major.**
- [ ] Export R2 bucket CORS/lifecycle from the Cloudflare dashboard (F-14)
- [ ] Apply pending P0.7 tenant-FK migrations on Railway first (or accept they run at cutover)

### Phase M1 — foundation (week 1)

1. `terraform/bootstrap` in each account (local state, once): state bucket + KMS + GitHub OIDC provider.
2. `environments/staging`: `terraform init && terraform plan && terraform apply`. The ACM validation waits until you add the validation CNAME in Vercel DNS (output `dns_records_to_create`).
3. Add every DNS record from the output (ACM, SES DKIM ×3, MAIL FROM MX+TXT, DMARC).
4. **Request SES production access** for both accounts (sandbox: 200 mails/day, verified recipients only). This takes 1–3 days; do it now.
5. Populate secrets (see §App secrets below).
6. Create the DB app role (§DB bootstrap), then write `zt/staging/database-url`.
7. Configure GitHub: Environments `staging`, `production` (required reviewer), `infra-staging`, `infra-production`; variables `AWS_ACCOUNT_ID_*`, `AWS_REGION`.
8. First deploy to staging via `deploy-aws.yml`. Run the verification list (§Verification) on staging with **synthetic data only**.

#### DB bootstrap (each env, once)

Run from a one-off ECS task (`aws ecs run-task … --overrides` with a `postgres:17-alpine` image) or via ECS Exec into a running task. There's no bastion; RDS isn't reachable from the internet.

```sql
-- connected as the RDS-managed master user (password in the RDS-managed secret)
CREATE ROLE ziyarati_app LOGIN PASSWORD '<openssl rand -base64 36>';
ALTER DATABASE ziyarati OWNER TO ziyarati_app;
\c ziyarati
-- extensions need rds_superuser; the migrations' IF NOT EXISTS then no-ops
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO ziyarati_app;
```

Then store `postgresql://ziyarati_app:<url-encoded pw>@<endpoint>:5432/ziyarati` (no `sslmode`) in `zt/<env>/database-url`.

The app role owns the schema because the API runs migrations. Splitting DDL and DML roles is Phase 3.

#### App secrets

`aws secretsmanager put-secret-value --secret-id zt/<env>/app --secret-string file://app.json`, where `app.json` holds the keys listed in SECURITY §3. **Copy `CREDENTIALS_ENCRYPTION_KEY`, `JWT_*`, `META_*` from Railway for production.** Generate fresh values for staging. Delete `app.json` afterwards (`shred -u`).

### Phase M2 — rehearsal in the production account (week 2)

Patient data never goes to staging.

1. `terraform apply` production (services at `desired=0`).
2. `pg_dump -Fc --no-owner --no-acl "$RAILWAY_DATABASE_PUBLIC_URL" > zt.dump` from a machine that can reach Railway, then upload to a restricted S3 prefix. Alternatively run pg_dump inside an ECS one-off task (NAT → Railway public endpoint).
3. Restore in AWS:
   ```bash
   pg_restore -l zt.dump | grep -v ' EXTENSION ' > restore.list
   pg_restore --no-owner --role=ziyarati_app -L restore.list -d "$MASTER_URL/ziyarati" zt.dump
   ```
4. Verify:
   - `node dist/src/migrate.js show` → nothing pending
   - `psql -f tests/load/reports/P0.3_PRODUCTION_VERIFICATION.sql` → `P03_STATUS=ENFORCED`
   - row counts of the top 20 tables match Railway (`SELECT relname, n_live_tup …` both sides)
   - `SELECT max(id)` / sequences sane.
5. **S3 pre-sync** (can run for days before cutover):
   ```bash
   rclone copy r2:<bucket> s3:zt-production-uploads-<acct> --metadata --checksum --transfers 16
   rclone check r2:<bucket> s3:zt-production-uploads-<acct> --one-way
   ```
   - Keys stay identical (`<tenantId>/<docType>/<uuid>.<ext>`), so **no DB rewrite** is needed.
   - `--metadata` preserves the `sha256` user metadata.
   - rclone needs R2 keys + an AWS profile with `s3:PutObject` + `kms:GenerateDataKey` on the bucket. Use a temporary Identity Center session, not a static key.
6. Start services (`desired=1`), hit readiness, log in as a test clinic, open a document (presigned URL from S3), send a test email to a verified inbox, trigger a WhatsApp template to a test number.
7. **Time every step.** Wipe the DB (`DROP DATABASE`/recreate + bootstrap) before the real cutover.

### Phase M3 — cutover (≈ 03:00 KSA, 30–60 min freeze)

| T | Step | Rollback point |
|---|---|---|
| −7 d | Lower TTL of the `api` DNS record to 60 s (it doesn't exist yet: create it at cutover with TTL 60). SES production access confirmed. S3 pre-sync running. | — |
| −1 h | Announce maintenance. Final `rclone copy` delta. | — |
| 0 | Railway API: enable maintenance (scale API to 0, or `503` at the edge). **Stop Railway worker after the `email`/`whatsapp-outbound` queues show 0 active** (Redis is *not* migrated; state re-drives from Postgres, audit §4). | restart Railway |
| +5 | Final `pg_dump` → `pg_restore` (as rehearsed) → verify counts + `P03_STATUS` | Railway untouched |
| +20 | Final `rclone copy` + `rclone check` | — |
| +25 | ECS API/worker `desired` → production values; readiness 200 | — |
| +30 | Vercel: `BACKEND_ORIGIN`, `NEXT_PUBLIC_WS_URL` → `https://api.ziyaratech.com`; redeploy | revert env + redeploy |
| +35 | **Meta**: change the webhook callback URL in the Meta app dashboard to `https://api.ziyaratech.com/api/v1/whatsapp/webhooks/events` (same verify token). **Tap**: update the webhook URL. | point back to Railway |
| +40 | Smoke: login, booking create/cancel, AI chat over WS (cookie now sent: F-3 fixed), upload + download, reminder scheduled row, email received, inbound WhatsApp message processed | full rollback below |
| +60 | End maintenance; watch dashboards for 2 h | — |

**Full rollback (within 14 days):** set the Vercel env and webhook URLs back to Railway, scale Railway back up, and replay AWS-side writes. Any writes made on AWS after cutover must be exported and replayed manually, so the practical rollback window is the first hours. Decide go/no-go at +60 min.

### Email: Resend → SES

- Resend has **never delivered** (domain unverified), so there's **no sender reputation to migrate** and no warm-up history. SES will be the first live provider. Warm up by volume: transactional first; hold marketing campaigns until SES bounce/complaint metrics are stable for 2 weeks.
- Switch is config-only: a region (`AWS_REGION`) on API **and worker** (the worker sends).
- ~~The Resend adapter stays in code for one release as rollback.~~ **Superseded 2026-10-17:** the Resend adapter, its webhook and `RESEND_*` / `EMAIL_PROVIDER` settings were removed; Amazon SES is the only provider and there is no rollback path to Resend.
- Remove the Resend DNS records (if ever added) after 30 days.

### Storage: R2 → S3

Config-only: `STORAGE_PROVIDER=s3`, `S3_BUCKET`, `AWS_REGION`, no keys. The R2 path stays selectable for rollback. Delete the R2 bucket after 30 days **and** after a successful quarterly restore test.

### Redis: Railway → ElastiCache

Not migrated, drained (see cutover step 0 and audit §4). Expected after cutover:
- repeatable jobs re-registered at worker boot
- due reminders re-queued by the reaper within 1 min
- outbox rows re-published.

### Application changes required (minimum set, done in this change)

| Change | Files | Why |
|---|---|---|
| S3 mode for `StorageService` (endpoint/keys optional → IAM role) | `src/modules/storage/storage.service.ts`, `env.validation.ts` | R2 → S3 |
| `SesProvider` (SESv2 SDK, IAM role, transient/permanent classification, 10 s timeout, single retry layer) | `src/modules/email/providers/ses.provider.ts`, factory, module, `env.validation.ts` | Resend → SES |
| SES feedback consumer (SQS long-poll in the worker) reusing the existing suppression/delivery logic | `src/modules/email/feedback/*`, `worker.module.ts` | bounce/complaint |
| RDS CA bundle in the image; `infra/` excluded from the build context | `Dockerfile`, `.dockerignore` | mandatory DB TLS validation |
| AWS deploy + terraform workflows | `.github/workflows/deploy-aws.yml`, `terraform.yml` | CI/CD |

**Not changed on purpose:** tenant context, auth, throttler keying (S-01 is an app decision), Redis/DB config code (already URL-driven and ElastiCache/RDS-ready), health endpoints.

### Verification list (run on staging, then production at cutover)

`terraform fmt/validate/test` · Docker build · task starts (secrets resolved) · `/api/v1/health` via ALB · readiness `ok` (DB + Redis over TLS) · `migrate show` clean · S3 upload/download/delete via the app · presigned URL expires after TTL · SES test email delivered + `email_logs=SENT` · SES simulator bounce (`bounce@simulator.amazonses.com`) → SQS → suppression row (campaign path) · Meta webhook verify handshake + signed event processed · a BullMQ job processed by the worker · WS connect with cookie from `www` → `api` · ECS deploy + circuit-breaker rollback (deploy a deliberately failing tag in staging) · alarms fire to email (set an alarm to ALARM with `set-alarm-state`).

### Residency gates before cutover (residency plan sections 16, 22)

Moving real data from Railway / R2 / Resend to AWS creates a new hosting location for patient data. Before Phase M3:

- The hosting Region is approved in writing and the `legal-hosting-approval` item in `compliance/production-gate.yaml` is satisfied (`Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part C)`). The owner's 2026-10-08 chat decision for `eu-central-1` is not that approval.
- `node infra/scripts/production-gate.cjs enforce` passes: DPAs, SCC or counsel's alternative, SCPs applied with simulator evidence, restore drill, incident-response runbook (`INCIDENT-RESPONSE.md`).
- Phase M2 rehearsal uses **synthetic data** until the first item is satisfied.
- The cutover is a **new stack and a new state key** for the target Region, never an in-place Region change.
- After cutover, collect deletion evidence from Railway, Cloudflare R2 and Resend and add it to the register (`SUBPROCESSORS.md`); the 14-day rollback window is a retention of patient data at the old host and should be as short as the rollback risk allows.

---

## Part C: DNS cutover runbook (Railway → AWS)

> **Former file:** `runbooks/dns-cutover-railway-to-aws.md`

Status 2026-10-08. `api.ziyaratech.com` still points to Railway. Railway holds **no real production data** (owner-confirmed),
so there is no data migration, no write freeze and no customer-visible downtime beyond DNS propagation (TTL 60 s).

### Facts (verified 2026-10-08)

| Item | Current | Target |
|---|---|---|
| `api.ziyaratech.com` | `CNAME wet4n3ld.up.railway.app.` (TTL 60) — **write this down for rollback** | `CNAME zt-production-api-1461747647.eu-central-1.elb.amazonaws.com.` |
| Certificate | — | ACM `ISSUED` for `api.ziyaratech.com` (CAA `amazon.com` added) |
| DNS host | Vercel DNS (`ns1/ns2.vercel-dns.com`) | same; change the existing `api` record's value (a name cannot hold CNAME + another record) |
| AWS stack | API 2/2, worker 1/1, image `sec-d3af6aa-1` (scan: 0 findings), ALB targets healthy | |
| Cookies | Railway: cross-site (`*.up.railway.app`) | AWS sets `COOKIE_DOMAIN=ziyaratech.com` (SameSite=Lax, Secure, HttpOnly) |

### Gates — everything in this table must be GREEN before the flip

| # | Gate | State 2026-10-08 |
|---|---|---|
| 1 | Hardened image deployed, scan clean | ✅ done |
| 2 | Auth, CRUD, RBAC, tenant isolation, S3, Redis, worker, Socket.IO validated on the ALB | ✅ done (see report) |
| 3 | **A real platform super-admin exists** (nothing can be approved without one — new clinics start `PENDING_VERIFICATION`) | ✅ created 2026-10-08 via the one-off seed task (below); login + clinic approval verified on the ALB. **Owner still has to**: read the one-time password from the temporary secret `zt/production/bootstrap-super-admin-password`, change it at first login, then delete that secret |
| 4 | SES: DNS records added (DKIM ×3, MAIL FROM MX+TXT, DMARC), identity `VERIFIED`, **production access** granted, then re-test a welcome email to a real inbox | ❌ pending (sandbox: 200/day, domain unverified) |
| 5 | SNS alert subscription `alerts@ziyaratech.com` confirmed | ❌ PendingConfirmation |
| 6 | Billing posture decided: `subscription_plans` is empty; platform billing mode defaults to FREE. Super-admin sets plans / mode in the console before onboarding paying clinics | ❌ owner decision |
| 7 | Meta (WhatsApp) webhook URL → `https://api.ziyaratech.com/api/v1/whatsapp/webhooks/events` (same verify token) — only if WhatsApp is live today | ⬜ owner |
| 8 | Tap stays OFF (`TAP_*_ENABLED=false`, no live key) until its own rollout step | ✅ intentional |
| 9 | Vercel env prepared (below) | ⬜ owner |
| 10 | Optional hardening: `EDGE_PROXY_TOKEN` (shared secret Vercel→API) so per-user throttling works behind the proxy | ⬜ recommended |

#### Create the real super-admin (gate 3) — one-off task, project's standard seed
Run `node dist/src/seed/seed.js` as a one-off task on the `zt-production-migrate` definition with `ADMIN_EMAIL` and `ADMIN_PASSWORD`
supplied for that run only (command: `sh -c 'DATABASE_URL="${DATABASE_URL}?sslmode=require" NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem node dist/src/seed/seed.js'`).
It is idempotent, never overwrites an existing password, and skips the admin when the two variables are unset. Prefer a one-time
password that is changed on first login; the value is visible in the task's overrides (CloudTrail), so do not reuse a real password.

### Cutover (≈10 min, reversible in ≈1 min)

1. **Vercel env (www / book projects):** `BACKEND_ORIGIN=https://api.ziyaratech.com` (usually already this), `NEXT_PUBLIC_WS_URL=https://api.ziyaratech.com`.
   `NEXT_PUBLIC_*` is inlined at build → **redeploy** and wait for READY. (Order matters only for the WS URL; the REST proxy follows DNS.)
2. **DNS:** in Vercel DNS edit the existing `api` CNAME → `zt-production-api-1461747647.eu-central-1.elb.amazonaws.com` (keep TTL 60).
3. Wait ≤ 2 min, then verify from a machine with no overrides:
   ```bash
   dig +short api.ziyaratech.com                      # -> the ALB name / its IPs, not railway
   curl -s https://api.ziyaratech.com/api/v1/system/health/readiness   # db up, redis up, schemaGuards 42/42
   curl -sI http://api.ziyaratech.com | head -1                         # 301 -> https
   ```
4. Smoke in a browser on `https://www.ziyaratech.com`: sign in as the super-admin → create/approve a clinic → clinic owner sign-in → create a
   customer → upload a file → open the AI chat (WebSocket connects) → sign out. Watch CloudWatch (`/ziyaratech/production/api`, `/worker`) and the ALB 5xx alarm for 30 min.
5. Meta / Tap webhook URLs (gate 7 / 8) now, if applicable.

### Rollback (≈1 min, no data to reconcile — AWS has no customer data yet)

1. Vercel DNS: set `api` back to `CNAME wet4n3ld.up.railway.app.` (TTL 60 → effective in ~1–2 min).
2. Vercel env back to the previous values + redeploy.
3. Webhooks back to the Railway URLs. Leave AWS running (it is idle without traffic) or scale it down — never delete.
Keep Railway untouched for 14 days after a successful cutover.

### After cutover (not blockers)
- Switch WAF `count` → `block` after 14 clean days (`terraform.tfvars` `waf_mode`).
- Set GitHub Environments/variables so `deploy-aws.yml` can deploy (OIDC roles already exist); the CI build step already uses `--provenance=false --sbom=false`.
- Align `image_tag` in tfvars with the deployed tag **in the same change that registers new task definitions** (a tag change makes Terraform replace the task-definition revisions).
- Back up `infra/terraform/bootstrap/terraform.tfstate` (local state, git-ignored).

---

## Part D: Data migration runbook (SUPERSEDED, DO NOT RUN)

> **Former file:** `runbooks/railway-to-aws-data-migration.md`

> **2026-10-08: the owner confirmed Railway holds NO real production data.** AWS is a clean deployment with an empty
> database; no pg_dump/pg_restore, no `zt/production/railway-source-url`, no `zt-production-dbmigrate` task. This file is kept
> only in case real data ever has to be moved. Cutover now = `Ziyarati-back/infra/runbooks/railway-to-aws-migration.md (Part C)`.

Status 2026-10-08. Nothing in this file has been run. `api.ziyaratech.com` still points to Railway;
Railway is untouched; the AWS stack (eu-central-1, acct 270370109141) is healthy with an **empty**
RDS (PG 17.9, 170 tables, 160 migrations applied, 426 migration-seeded rows, 17 MB).
Follows `Ziyarati-back/infra/runbooks/railway-to-aws-migration.md (Part B)` (phases M2/M3) and adds what that document does not cover.

Companion script (runs inside the task): `infra/scripts/railway-migrate-task.sh`.

---

### 0. Hard rules for the whole procedure

1. **Railway is read-only to us.** Every source session is forced `default_transaction_read_only=on`.
   We never stop, scale, edit or delete anything on Railway except at the cutover freeze (§4), by the operator.
2. **Never change `api.ziyaratech.com` DNS** until §4 step 9. Record the current value first:
   `api.ziyaratech.com. 60 IN CNAME wet4n3ld.up.railway.app.`
3. **AWS worker stays at 0 from the first restore until cutover.** The worker is what sends reminders,
   emails (SES) and WhatsApp (credentials in the DB decrypt with the same key). A restored copy of
   production data + a running AWS worker = duplicate messages to real patients while Railway is also sending.
4. No data at rest outside the two databases: the dump lives on the task's ephemeral encrypted disk and is
   deleted before the task ends. Nothing goes to a laptop or S3.
5. Destructive step exists in exactly one place: `reset` (drops schema `public` on **RDS** only), guarded by a
   confirmation variable and by host checks in the script.

### 1. Go/no-go gates (all read-only; no gate has been evaluated yet)

| Gate | Check | Why it blocks |
|---|---|---|
| G1 | Railway server major **≤ 17** (RDS is 17.9) | A PG18 dump cannot be restored into PG17. If Railway is 18, RDS must be rebuilt on 18 (it is empty today, so cheap now, expensive later). **Never recorded anywhere in the repo (audit F-13).** |
| G2 | Railway extensions ⊆ {plpgsql, uuid-ossp, btree_gist, pg_trgm, vector} and `vector` ≤ 0.8.1 | RDS has exactly these. Anything else fails restore. |
| G3 | Every applied migration name on Railway ∈ the 160 in the image | Railway ahead of the image = the image would run against a newer schema. Railway behind is fine: `migrate run` applies the rest after restore. |
| G4 | `P0.3_PRODUCTION_VERIFICATION.sql` on Railway → `P03_STATUS=ENFORCED` | If a synchronize boot damaged the schema (P0.2/P0.3), the restore copies the damage. `migrate run` repairs most of it; know before, not after. |
| G5 | Railway `server_encoding=UTF8` and DB size known | Sizing the downtime (§4) and ephemeral disk (default 100 GiB; 200 max). |
| G6 | Railway **variable names** diffed against the AWS task env (§6.1) | Anything set on Railway and absent on AWS silently changes behaviour at cutover. |
| G7 | Fingerprints of `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` match (§6.2) | Mismatch = all sessions die and all stored tenant credentials become undecryptable. |

### 2. One-time setup (temporary resources, removed in §7)

Prepared as CLI steps, **not Terraform**, so the Terraform state is not touched and teardown is exact.
All carry tag `Purpose=railway-migration`.

#### 2.1 Operator creates the source secret (the assistant never sees the value)

Use a Railway **public** (TCP proxy) connection string; ideally a role with SELECT only.

```bash
aws secretsmanager create-secret --region eu-central-1 \
  --name zt/production/railway-source-url --kms-key-id alias/zt-production-data \
  --secret-string 'postgresql://USER:PASSWORD@HOST:PORT/DBNAME' \
  --tags Key=Purpose,Value=railway-migration
```

#### 2.2 Let the ops execution role read it (inline policy, removed in §7)

```bash
aws iam put-role-policy --role-name zt-production-ecs-ops-execution --policy-name tmp-railway-migration \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"arn:aws:secretsmanager:eu-central-1:270370109141:secret:zt/production/railway-source-url-*"}]}'
```

#### 2.3 Register the one-off task definition `zt-production-dbmigrate`

Same shape as the existing `zt-production-psql` task (execution role = ops role, RDS master password from
the RDS-managed secret, TLS required) plus `SRC_URL`, 4 GiB RAM and 100 GiB ephemeral storage.
Image: `public.ecr.aws/docker/library/postgres:17-alpine` (use `:18-alpine` only if G1 forces an 18 rebuild).

```powershell
$def = @{
  family='zt-production-dbmigrate'; requiresCompatibilities=@('FARGATE'); networkMode='awsvpc'
  cpu='1024'; memory='4096'; ephemeralStorage=@{sizeInGiB=100}
  executionRoleArn='arn:aws:iam::270370109141:role/zt-production-ecs-ops-execution'
  runtimePlatform=@{operatingSystemFamily='LINUX'; cpuArchitecture='X86_64'}
  tags=@(@{key='Purpose';value='railway-migration'})
  containerDefinitions=@(@{
    name='dbmigrate'; image='public.ecr.aws/docker/library/postgres:17-alpine'; essential=$true
    environment=@(
      @{name='PGHOST';value='zt-production-pg.cj6ci86wm85b.eu-central-1.rds.amazonaws.com'},
      @{name='PGDATABASE';value='ziyarati'}, @{name='PGUSER';value='ziyarati_admin'}, @{name='PGSSLMODE';value='require'})
    secrets=@(
      @{name='PGPASSWORD';valueFrom='arn:aws:secretsmanager:eu-central-1:270370109141:secret:rds!db-51b486e2-ca1b-4cda-baef-64d81359e892-8eGNmz:password::'},
      @{name='SRC_URL';valueFrom='arn:aws:secretsmanager:eu-central-1:270370109141:secret:zt/production/railway-source-url-XXXXXX'})
    logConfiguration=@{logDriver='awslogs';options=@{'awslogs-group'='/ziyaratech/production/ops';'awslogs-region'='eu-central-1';'awslogs-stream-prefix'='ops'}}
  })
} | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText("$env:TEMP\dbmigrate-td.json", $def)
aws ecs register-task-definition --region eu-central-1 --cli-input-json file://$env:TEMP/dbmigrate-td.json
```

(`XXXXXX` = the random suffix Secrets Manager appends to the new secret's ARN.)

#### 2.4 Launcher (PowerShell). The script is passed base64-encoded; no data and no credential is in the override

```powershell
function Invoke-DbMigrate([string]$Mode, [hashtable]$ExtraEnv = @{}) {
  $sh  = (Get-Content infra\scripts\railway-migrate-task.sh -Raw) -replace "`r",""
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sh))
  $env_ = @(@{name='MODE';value=$Mode}) + ($ExtraEnv.GetEnumerator() | % { @{name=$_.Key;value=$_.Value} })
  $ov = @{containerOverrides=@(@{name='dbmigrate';environment=$env_;command=@('sh','-c',"echo $b64 | base64 -d | sh")})} | ConvertTo-Json -Depth 6 -Compress
  [IO.File]::WriteAllText("$env:TEMP\dbm-ov.json", $ov)
  $net = '{"awsvpcConfiguration":{"subnets":["subnet-07e4545a8df19d665","subnet-04f4b1db6668c1baa","subnet-0e9a9e92b5f69b451"],"securityGroups":["sg-06449ff5618aaad5c"],"assignPublicIp":"DISABLED"}}'
  [IO.File]::WriteAllText("$env:TEMP\dbm-net.json", $net)
  $arn = aws ecs run-task --region eu-central-1 --cluster zt-production --launch-type FARGATE `
    --task-definition zt-production-dbmigrate --network-configuration file://$env:TEMP/dbm-net.json `
    --overrides file://$env:TEMP/dbm-ov.json --query 'tasks[0].taskArn' --output text
  $id = ($arn -split '/')[-1]; aws ecs wait tasks-stopped --region eu-central-1 --cluster zt-production --tasks $id
  "exit=" + (aws ecs describe-tasks --region eu-central-1 --cluster zt-production --tasks $id --query 'tasks[0].containers[0].exitCode' --output text)
  aws logs get-log-events --region eu-central-1 --log-group-name /ziyaratech/production/ops --log-stream-name "ops/dbmigrate/$id" --query 'events[].message' --output text
}
```

### 3. Rehearsal (M2) — zero customer downtime, Railway keeps serving

```powershell
# 3.1 AWS compute off (worker MUST be 0; API 0 too during the restore).  TF will show a diff for the autoscaling min until §7.
foreach ($s in 'worker','api') {
  aws application-autoscaling register-scalable-target --region eu-central-1 --service-namespace ecs `
    --scalable-dimension ecs:service:DesiredCount --resource-id service/zt-production/zt-production-$s --min-capacity 0 --max-capacity 6
  aws ecs update-service --region eu-central-1 --cluster zt-production --service zt-production-$s --desired-count 0
}
# 3.2 Safety net: manual RDS snapshot
aws rds create-db-snapshot --region eu-central-1 --db-instance-identifier zt-production-pg --db-snapshot-identifier pre-restore-rehearsal-$(Get-Date -f yyyyMMdd-HHmm)

# 3.3 Gates G1-G5 (read-only on Railway) — STOP here if any gate fails
Invoke-DbMigrate preflight
# also run tests/load/reports/P0.3_PRODUCTION_VERIFICATION.sql against the source (G4)

# 3.4 DESTRUCTIVE (RDS only): wipe the migration-seeded schema, re-add extensions
Invoke-DbMigrate reset @{CONFIRM_WIPE='wipe-rds-ziyarati'}

# 3.5 Dump (source, read-only snapshot) -> restore (target, no extensions)
Invoke-DbMigrate restore

# 3.6 Bring the schema to the image's level (applies migrations Railway lacks; no-op if equal)
foreach ($cmd in 'run','show') {   # 'run' must exit 0; 'show' must list nothing pending
  [IO.File]::WriteAllText("$env:TEMP\mig-ov.json", (@{containerOverrides=@(@{name='migrate';command=@('node','dist/src/migrate.js',$cmd)})} | ConvertTo-Json -Depth 5 -Compress))
  $arn = aws ecs run-task --region eu-central-1 --cluster zt-production --launch-type FARGATE --task-definition zt-production-migrate `
    --network-configuration file://$env:TEMP/dbm-net.json --overrides file://$env:TEMP/mig-ov.json --query 'tasks[0].taskArn' --output text
  $id = ($arn -split '/')[-1]; aws ecs wait tasks-stopped --region eu-central-1 --cluster zt-production --tasks $id
  aws ecs describe-tasks --region eu-central-1 --cluster zt-production --tasks $id --query 'tasks[0].containers[0].exitCode' --output text
  aws logs get-log-events --region eu-central-1 --log-group-name /ziyaratech/production/migrate --log-stream-name "migrate/migrate/$id" --query 'events[].message' --output text
}

# 3.7 Exact per-table row counts, source vs target; exit 1 on any difference
Invoke-DbMigrate counts

# 3.8 Decrypt canary (§6.3) and P0.3 SQL on RDS
# 3.9 Time every step. These numbers ARE the cutover downtime estimate.
```

After 3.7/3.8 are green: API → 1 for a read-only smoke (login as a test user, open a patient, open a document),
**worker stays 0**. Then wipe again (`reset`) before the real cutover so the final copy is a clean one.

### 4. Cutover (M3) — the only downtime

**Expected downtime: ≈ 20–40 min write-freeze**, dominated by (a) the final dump+restore and (b) Vercel redeploy.
Dump+restore of a database under ~1 GB takes minutes; the DB size is unknown until G5, so this is a **placeholder
until the rehearsal produces a measured number**. If the rehearsal's dump+restore exceeds 45 min, switch to the
logical-replication variant described in Ziyarati-back/infra/runbooks/railway-to-aws-migration.md (Part B) (needs `wal_level=logical` on Railway — unverified).
Read paths on Vercel can show a maintenance page; no data is lost because writes are frozen, not dropped.

| T | Action | Who | Reversible by |
|---|---|---|---|
| −7 d | `api` TTL is already 60 s (observed). SES prod access granted. R2→S3 pre-sync running (§8). Rehearsal done twice. | us | — |
| −1 h | Announce maintenance. Last `rclone copy` delta. Take final RDS snapshot. | operator | — |
| 0 | Railway: API → maintenance/0, then worker stop **after** `email` & `whatsapp-outbound` queues show 0 active. | operator | restart Railway |
| +5 | `reset` → `restore` → `migrate run` → `counts` → P0.3 SQL → decrypt canary | us | Railway untouched |
| +20 | Final S3 delta + `rclone check` | us | — |
| +25 | AWS API → 2, worker → 1 (re-set autoscaling min 2 / 1); readiness 200 | us | scale back to 0 |
| +30 | Vercel `BACKEND_ORIGIN`, `NEXT_PUBLIC_WS_URL` → `https://api.ziyaratech.com`; redeploy | operator | revert env + redeploy |
| +35 | Meta webhook callback URL; Tap webhook URL (per payments runbook) | operator | point back to Railway |
| +40 | **DNS**: `api` CNAME `wet4n3ld.up.railway.app` → `zt-production-api-1461747647.eu-central-1.elb.amazonaws.com` (TTL 60) | operator | set the CNAME back (60 s) |
| +45 | Smoke: login, booking create/cancel, AI chat over WS, upload+download, reminder row, email received, inbound WhatsApp | us + operator | full rollback |
| +60 | End maintenance. Go/no-go. Watch dashboards 2 h. | — | — |

Order note: DNS is **after** Vercel/webhooks in Ziyarati-back/infra/runbooks/railway-to-aws-migration.md (Part B) only because Vercel proxies; because `api.ziyaratech.com`
is already a Railway custom domain, flip DNS last so the ALB certificate (`api.ziyaratech.com`, ISSUED) is exercised
by real traffic only once everything else is ready.

### 5. Rollback

| Point | State | Rollback |
|---|---|---|
| Any time before §4 step +40 | Railway is the only live system, DB untouched (dump is read-only) | Abort: scale AWS to 0, delete temp resources (§7). **No customer impact.** |
| After DNS flip, first hours | AWS live, Railway frozen | (1) `api` CNAME back to `wet4n3ld.up.railway.app`; (2) Vercel env back + redeploy; (3) Meta + Tap webhook URLs back; (4) restart Railway API + worker. **Writes made on AWS since T+40 are NOT on Railway** — export them (rows with `created_at`/`updated_at` > cutover timestamp) and replay manually. This is why go/no-go is decided at +60 min. |
| Bad restore on RDS (before DNS) | RDS corrupted/partial | `reset` + `restore` again, or restore the pre-restore RDS snapshot. |
| Data damage after go-live | — | RDS PITR (DR-6, 14-day retention). |
| Railway | Keep **intact for 14 days** after cutover. Do not delete. | — |

### 6. Key and configuration preservation

#### 6.1 Variable parity (gate G6)
Operator runs, in the Railway service shell/CLI, and sends **names only**:
`railway variables --kv | cut -d= -f1 | sort`. The assistant diffs that list against the ECS API/worker task
environment + `zt/production/app` keys. Known on AWS already: 10 secret keys + `META_GRAPH_API_VERSION`
(present in the secret but **not injected**: add it to `app_secret_keys` if Railway sets it, otherwise the app uses `v21.0`).
Likely gaps to check: `EDGE_PROXY_TOKEN`, `UPLOAD_MAX_BYTES`, `SUBSCRIPTION_GRACE_DAYS`, `ANTHROPIC_API_KEY`,
`AI_*` routing/model flags, `TAP_*` (kept off by design), `WHATSAPP_*`, `QUEUE_ENV_PREFIX`, `PUBLIC_COOKIE_*`.

#### 6.2 JWT_* and CREDENTIALS_ENCRYPTION_KEY — preserved by copying, proven by fingerprint
Values are never printed. AWS fingerprints (first 12 hex of SHA-256, taken 2026-10-08 from `zt/production/app`):

| Key | AWS fingerprint | length |
|---|---|---|
| `JWT_ACCESS_SECRET` | `e97fee6a9044` | 47 |
| `JWT_REFRESH_SECRET` | `e76b171b2b29` | 47 |
| `CREDENTIALS_ENCRYPTION_KEY` | `f4dabf2e93fc` | 44 |

Operator computes the same on the Railway value (no echo of the value):
```bash
printf %s "$JWT_ACCESS_SECRET" | sha256sum | cut -c1-12
```
**All three must match.** If any differs: put the Railway value into `zt/production/app` (`put-secret-value`, merge
the JSON), and restart tasks. Never "fix" it by re-encrypting data.
Effect when they match: refresh tokens stored in the restored DB remain valid, existing sessions survive, and
`enc:v1:` ciphertext in `whatsapp_accounts.access_token`, integration connection/webhook/OAuth ciphertext and
`api_key_ciphertext` stays decryptable (AES-256-GCM, tamper-evident: a wrong key makes `decrypt` throw, never garble).
Caveat: AWS sets `COOKIE_DOMAIN=ziyaratech.com`; browsers holding an older host-only cookie may need one re-login. Not data loss.

#### 6.3 Decrypt canary (after every restore)
One-off task from the **API** task definition (it already has the secrets) with a command override that
decrypts up to 20 sampled `enc:v1:` values with the app's own algorithm and prints only `ok=N fail=M`.
Pass criterion: `fail=0` and `ok>0`. (If Railway has no encrypted rows, ok=0 is acceptable and G7 alone governs.)

### 7. Teardown (after rehearsal, and again after cutover)

```powershell
aws iam delete-role-policy --role-name zt-production-ecs-ops-execution --policy-name tmp-railway-migration
aws secretsmanager delete-secret --region eu-central-1 --secret-id zt/production/railway-source-url --recovery-window-in-days 7
aws ecs deregister-task-definition --region eu-central-1 --task-definition zt-production-dbmigrate:1
# restore autoscaling floors to Terraform's values (api 2 / worker 1) or run `terraform apply` once
```
Keep the pre-restore RDS snapshots for 14 days.

### 8. Documents (R2 → S3) — separate, same freeze

Open question D2: **where does `rclone` run?** A laptop would pass patient documents through it. Recommended: a one-off
ECS task (task role with S3 write + KMS on the uploads bucket, R2 keys in a temp secret) — needs one more temp task
definition. Pre-flight: confirm production really uses `STORAGE_PROVIDER=r2` today and measure `rclone size`.
Keys are identical (`<tenantId>/<docType>/<uuid>.<ext>`), so no DB rewrite is needed.

### 9. Validation checklist

- [ ] G1–G7 green · [ ] pre-restore RDS snapshot exists · [ ] `restore` exit 0 · [ ] `migrate run` exit 0, `show` = nothing pending
- [ ] `counts` = every table equal (170 tables) · [ ] constraints 582 / indexes 509+ / exclusion constraint = 1 on RDS (≥ source)
- [ ] `P03_STATUS=ENFORCED` on RDS · [ ] decrypt canary `fail=0` · [ ] sequences sane (`max(id)` vs `last_value`)
- [ ] readiness 200 with `schemaGuards.requiredFailed=0` · [ ] CloudWatch api/worker ERROR count 0 after scale-up
- [ ] rehearsal timings recorded · [ ] smoke list in §4 passes · [ ] `rclone check --one-way` clean
