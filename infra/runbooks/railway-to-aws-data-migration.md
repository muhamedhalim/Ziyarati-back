# Railway → AWS RDS data migration — SUPERSEDED, DO NOT RUN

> **2026-10-08: the owner confirmed Railway holds NO real production data.** AWS is a clean deployment with an empty
> database; no pg_dump/pg_restore, no `zt/production/railway-source-url`, no `zt-production-dbmigrate` task. This file is kept
> only in case real data ever has to be moved. Cutover now = `runbooks/dns-cutover-railway-to-aws.md`.

Status 2026-10-08. Nothing in this file has been run. `api.ziyaratech.com` still points to Railway;
Railway is untouched; the AWS stack (eu-central-1, acct 270370109141) is healthy with an **empty**
RDS (PG 17.9, 170 tables, 160 migrations applied, 426 migration-seeded rows, 17 MB).
Follows `infra/docs/MIGRATION.md` (phases M2/M3) and adds what that document does not cover.

Companion script (runs inside the task): `infra/scripts/railway-migrate-task.sh`.

---

## 0. Hard rules for the whole procedure

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

## 1. Go/no-go gates (all read-only; no gate has been evaluated yet)

| Gate | Check | Why it blocks |
|---|---|---|
| G1 | Railway server major **≤ 17** (RDS is 17.9) | A PG18 dump cannot be restored into PG17. If Railway is 18, RDS must be rebuilt on 18 (it is empty today, so cheap now, expensive later). **Never recorded anywhere in the repo (audit F-13).** |
| G2 | Railway extensions ⊆ {plpgsql, uuid-ossp, btree_gist, pg_trgm, vector} and `vector` ≤ 0.8.1 | RDS has exactly these. Anything else fails restore. |
| G3 | Every applied migration name on Railway ∈ the 160 in the image | Railway ahead of the image = the image would run against a newer schema. Railway behind is fine: `migrate run` applies the rest after restore. |
| G4 | `P0.3_PRODUCTION_VERIFICATION.sql` on Railway → `P03_STATUS=ENFORCED` | If a synchronize boot damaged the schema (P0.2/P0.3), the restore copies the damage. `migrate run` repairs most of it; know before, not after. |
| G5 | Railway `server_encoding=UTF8` and DB size known | Sizing the downtime (§4) and ephemeral disk (default 100 GiB; 200 max). |
| G6 | Railway **variable names** diffed against the AWS task env (§6.1) | Anything set on Railway and absent on AWS silently changes behaviour at cutover. |
| G7 | Fingerprints of `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` match (§6.2) | Mismatch = all sessions die and all stored tenant credentials become undecryptable. |

## 2. One-time setup (temporary resources, removed in §7)

Prepared as CLI steps, **not Terraform**, so the Terraform state is not touched and teardown is exact.
All carry tag `Purpose=railway-migration`.

### 2.1 Operator creates the source secret (the assistant never sees the value)

Use a Railway **public** (TCP proxy) connection string; ideally a role with SELECT only.

```bash
aws secretsmanager create-secret --region eu-central-1 \
  --name zt/production/railway-source-url --kms-key-id alias/zt-production-data \
  --secret-string 'postgresql://USER:PASSWORD@HOST:PORT/DBNAME' \
  --tags Key=Purpose,Value=railway-migration
```

### 2.2 Let the ops execution role read it (inline policy, removed in §7)

```bash
aws iam put-role-policy --role-name zt-production-ecs-ops-execution --policy-name tmp-railway-migration \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"arn:aws:secretsmanager:eu-central-1:270370109141:secret:zt/production/railway-source-url-*"}]}'
```

### 2.3 Register the one-off task definition `zt-production-dbmigrate`

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

### 2.4 Launcher (PowerShell). The script is passed base64-encoded; no data and no credential is in the override

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

## 3. Rehearsal (M2) — zero customer downtime, Railway keeps serving

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

## 4. Cutover (M3) — the only downtime

**Expected downtime: ≈ 20–40 min write-freeze**, dominated by (a) the final dump+restore and (b) Vercel redeploy.
Dump+restore of a database under ~1 GB takes minutes; the DB size is unknown until G5, so this is a **placeholder
until the rehearsal produces a measured number**. If the rehearsal's dump+restore exceeds 45 min, switch to the
logical-replication variant described in MIGRATION.md (needs `wal_level=logical` on Railway — unverified).
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

Order note: DNS is **after** Vercel/webhooks in MIGRATION.md only because Vercel proxies; because `api.ziyaratech.com`
is already a Railway custom domain, flip DNS last so the ALB certificate (`api.ziyaratech.com`, ISSUED) is exercised
by real traffic only once everything else is ready.

## 5. Rollback

| Point | State | Rollback |
|---|---|---|
| Any time before §4 step +40 | Railway is the only live system, DB untouched (dump is read-only) | Abort: scale AWS to 0, delete temp resources (§7). **No customer impact.** |
| After DNS flip, first hours | AWS live, Railway frozen | (1) `api` CNAME back to `wet4n3ld.up.railway.app`; (2) Vercel env back + redeploy; (3) Meta + Tap webhook URLs back; (4) restart Railway API + worker. **Writes made on AWS since T+40 are NOT on Railway** — export them (rows with `created_at`/`updated_at` > cutover timestamp) and replay manually. This is why go/no-go is decided at +60 min. |
| Bad restore on RDS (before DNS) | RDS corrupted/partial | `reset` + `restore` again, or restore the pre-restore RDS snapshot. |
| Data damage after go-live | — | RDS PITR (DR-6, 14-day retention). |
| Railway | Keep **intact for 14 days** after cutover. Do not delete. | — |

## 6. Key and configuration preservation

### 6.1 Variable parity (gate G6)
Operator runs, in the Railway service shell/CLI, and sends **names only**:
`railway variables --kv | cut -d= -f1 | sort`. The assistant diffs that list against the ECS API/worker task
environment + `zt/production/app` keys. Known on AWS already: 10 secret keys + `META_GRAPH_API_VERSION`
(present in the secret but **not injected**: add it to `app_secret_keys` if Railway sets it, otherwise the app uses `v21.0`).
Likely gaps to check: `EDGE_PROXY_TOKEN`, `UPLOAD_MAX_BYTES`, `SUBSCRIPTION_GRACE_DAYS`, `ANTHROPIC_API_KEY`,
`AI_*` routing/model flags, `TAP_*` (kept off by design), `WHATSAPP_*`, `QUEUE_ENV_PREFIX`, `PUBLIC_COOKIE_*`.

### 6.2 JWT_* and CREDENTIALS_ENCRYPTION_KEY — preserved by copying, proven by fingerprint
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

### 6.3 Decrypt canary (after every restore)
One-off task from the **API** task definition (it already has the secrets) with a command override that
decrypts up to 20 sampled `enc:v1:` values with the app's own algorithm and prints only `ok=N fail=M`.
Pass criterion: `fail=0` and `ok>0`. (If Railway has no encrypted rows, ok=0 is acceptable and G7 alone governs.)

## 7. Teardown (after rehearsal, and again after cutover)

```powershell
aws iam delete-role-policy --role-name zt-production-ecs-ops-execution --policy-name tmp-railway-migration
aws secretsmanager delete-secret --region eu-central-1 --secret-id zt/production/railway-source-url --recovery-window-in-days 7
aws ecs deregister-task-definition --region eu-central-1 --task-definition zt-production-dbmigrate:1
# restore autoscaling floors to Terraform's values (api 2 / worker 1) or run `terraform apply` once
```
Keep the pre-restore RDS snapshots for 14 days.

## 8. Documents (R2 → S3) — separate, same freeze

Open question D2: **where does `rclone` run?** A laptop would pass patient documents through it. Recommended: a one-off
ECS task (task role with S3 write + KMS on the uploads bucket, R2 keys in a temp secret) — needs one more temp task
definition. Pre-flight: confirm production really uses `STORAGE_PROVIDER=r2` today and measure `rclone size`.
Keys are identical (`<tenantId>/<docType>/<uuid>.<ext>`), so no DB rewrite is needed.

## 9. Validation checklist

- [ ] G1–G7 green · [ ] pre-restore RDS snapshot exists · [ ] `restore` exit 0 · [ ] `migrate run` exit 0, `show` = nothing pending
- [ ] `counts` = every table equal (170 tables) · [ ] constraints 582 / indexes 509+ / exclusion constraint = 1 on RDS (≥ source)
- [ ] `P03_STATUS=ENFORCED` on RDS · [ ] decrypt canary `fail=0` · [ ] sequences sane (`max(id)` vs `last_value`)
- [ ] readiness 200 with `schemaGuards.requiredFailed=0` · [ ] CloudWatch api/worker ERROR count 0 after scale-up
- [ ] rehearsal timings recorded · [ ] smoke list in §4 passes · [ ] `rclone check --one-way` clean
