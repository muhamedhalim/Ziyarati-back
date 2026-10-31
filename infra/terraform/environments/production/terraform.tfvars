# ZiyaraTech — PRODUCTION (Phase 1). No secrets in this file: secret values
# live in Secrets Manager (zt/production/*). account_id comes from
# TF_VAR_account_id. Sizing rationale: infra/docs/ARCHITECTURE.md.

# Regions this environment may be deployed to. EMPTY ON PURPOSE: no hosting
# location is approved yet (infra/docs/SECURITY.md §6, decision D-1). With an
# empty list every plan fails closed (modules/platform variable validation and
# infra/scripts/region-gate.sh). Add a region ONLY after the hosting-location
# decision is approved in writing; aws_region below must then be a member.
approved_regions = ["eu-central-1"] # D-1 confirmed by the owner in chat, 2026-10-08

aws_region            = "eu-central-1"
availability_zone_ids = ["euc1-az1", "euc1-az2", "euc1-az3"]
vpc_cidr              = "10.20.0.0/16"
nat_gateway_count     = 1 # 2026-10-16: was 2 (owner-approved cost cut; one-AZ egress SPOF accepted)

domain = "ziyaratech.com"
# Every browser origin that opens a socket or sends credentialed requests: the marketing/dashboard site
# AND the patient marketplace (book.), whose AI widget dials wss://api.ziyaratech.com directly.
frontend_origins = ["https://www.ziyaratech.com", "https://ziyaratech.com", "https://book.ziyaratech.com"]
app_url          = "https://www.ziyaratech.com"

# First apply: a tag already pushed to ECR (see DEPLOYMENT.md §2).
image_tag = "bootstrap"

# 0.5 vCPU = half a Node core (~110 req/s per task at the k6 per-core rate, SCALING-ROADMAP).
# Measured 2026-10-08..14 (AWS-COST-FORENSICS.md F-2): CPU avg 0.66%, memory max 266 MB, peak 4.6 req/s.
# Was 1024/2048. Autoscaling (60% CPU target, max 6) still scales out; min_count stays 2 for AZ resilience.
api = {
  cpu           = 512
  memory        = 1024
  desired_count = 2
  min_count     = 2
  max_count     = 6
  cpu_target    = 60
}

# Kept at 512/1024 (the live value). Avg CPU 3%, but 5-min peaks hit 64-74% of 0.5 vCPU several times a
# week (2026-10-12..16), which would saturate 0.25 vCPU; the saving was only ~$8.5/mo. Revisit 256/1024
# once job volume is characterised. Memory max 281 MB of 1024 MB; the OOM-kill alarm is at 85%.
worker = {
  cpu           = 512
  memory        = 1024
  desired_count = 1
  min_count     = 1
  max_count     = 3
  cpu_target    = 70
}

# Budget: 6×2×(10+2) + 3×2×(10+1) + 10 = 220 <= 0.8 × 300 = 240 (checked at plan)
api_db_pool_max    = 10
worker_db_pool_max = 10

db = {
  engine_major_version = "17"          # must be >= the Railway major (MIGRATION.md M0)
  instance_class       = "db.t3.small" # TRIAL-PHASE cost cut 2026-10-16 (was db.t3.medium live; db.t4g.medium was proposed, never applied). 2 vCPU burstable / 2 GB.
  # 2026-10-08 note said t4g.medium was not orderable here; DescribeOrderableDBInstanceOptions (PostgreSQL 17.9, gp3, Multi-AZ,
  # eu-central-1a/b/c) lists it on 2026-10-15. The modify call fails fast, before any change, if the account still cannot order it.
  multi_az                 = false # 2026-10-16: owner-approved cost cut (was true)
  max_connections          = 300
  allocated_storage_gb     = 50
  max_allocated_storage_gb = 200
  backup_retention_days    = 14    # value used when backup_enabled = true (official launch)
  backup_enabled           = true  # re-enabled 2026-10-16: retention = backup_retention_days (14); trial phase over
  apply_immediately        = false # was true for the 2026-10-16 changes (applied); keep false
}

redis = {
  node_type               = "cache.t4g.micro" # was cache.t4g.small; memory 2.7% max, engine CPU 1.4% (AWS-COST-FORENSICS.md F-4)
  num_cache_clusters      = 2                 # primary + replica, Multi-AZ failover
  snapshot_retention_days = 7
}

# RL-02 — owner-approved 2026-10-22: switch to "block" only AFTER the edge
# token is live (RL-01) and the edge-aware rules have run a few days in "count"
# with acceptable counts (see docs/RATE-LIMITING-DOS-AUDIT.md G.9 step 5).
# Already in place for block mode: NoUserAgent_HEADER pinned to COUNT, and
# /api/v1/integrations/* exempt from ip-reputation.
# P0.6 (2026-10-31): PROPOSED flip, NOT APPLIED. 7-day Logs Insights review
# (docs/security-compliance/assessment/P0-6-WAF-OBSERVATION.md) found the only
# counted traffic was scanner noise; no real route, webhook or clinic hit.
# Rollback = set back to "count". rate-source-ip-flood stays COUNT while the
# edge token is unset (module logic); SizeRestrictions_BODY stays COUNT.
waf_mode = "block"
# Rate rules stay COUNT in the first apply; flip to true after thresholds are reviewed.
waf_rate_rules_block = false
dmarc_rua            = "dmarc@ziyaratech.com"

# Non-secret application config. Fixed platform keys (NODE_ENV, DB_SSL_CA,
# STORAGE_PROVIDER, S3_BUCKET, SES_CONFIGURATION_SET, ...) are set by the platform module.
app_environment = {
  EMAIL_FROM                           = "no-reply@ziyaratech.com"
  EMAIL_FROM_NAME                      = "ZiyaraTech"
  EMAIL_ENABLED                        = "true"
  PAYMENT_PROVIDER                     = "tap"
  AUTH_REGISTER_OWNER_ENDPOINT_CEILING = "60" # RL-07: owner-approved 2026-10-22 (was 1000); 1 sign-up in 14 days
  # RL-07 FLIP — owner-approved 5/h per client; uncomment ONLY after RL-01 is
  # live (before that, browser sign-ups share Vercel's egress addresses).
  # AUTH_REGISTER_OWNER_MAX_PER_CLIENT = "5"
  DEFAULT_LOCALE           = "ar"
  ENABLE_API_DOCS          = "false"
  ENABLE_INTEGRATION_DOCS  = "false"
  PLATFORM_API_LOG_ENABLED = "false"

  # P0.9 (2026-10-31, PROPOSED, not applied): pin the AI privacy flags to the
  # values the code already defaults to, so a missing variable can never loosen
  # them. AI_DATA_RESIDENCY_ENABLED is deliberately NOT pinned - owner decision (G-D).
  AI_MINIMIZER_ENABLED = "true"
  AI_VISION_ENABLED    = "false"

  # MFA rollout (approved policy). NOT ENFORCED while these are commented out.
  # Uncomment ONLY after infra/runbooks/mfa-rollout.md preconditions 1-5 are verified, then
  # Review the plan first - a bare ECS target also pulls in RDS and Tap changes (see the runbook).
  # Tier 1 (super admin, platform staff, clinic owner/manager/branch manager): MFA_ENFORCE_FROM.
  # Tier 2 (doctors, nurses, anyone with clinical-records access): MFA_ENFORCE_CLINICAL_FROM.
  # Removing the line and re-applying is the rollback. ISO 8601, UTC.
  # MFA_ENFORCE_FROM = "2026-11-08T00:00:00Z"

  # Tap — production boots only with the credentials below (env.validation.ts fails closed).
  # Follow the checklist in infra/runbooks/tap-payments-rollout.md §5 before the first deploy.
  # The two flags stay "false" until their own rollout step (runbook §5 steps 6 and 8).
  TAP_ENV                      = "live"
  TAP_WEBHOOK_URL              = "https://api.ziyaratech.com/api/v1/payments/webhooks/tap"
  TAP_RECURRING_ENABLED        = "false"
  TAP_BOOKING_PAYMENTS_ENABLED = "false"
  # PHASE 8 FLIP: the dashboard "Merchant ID" (an identifier, not a secret) — runbook §5 step 3:
  # TAP_MERCHANT_ID = "<numeric id>"
}

# Every key MUST exist in the zt/production/app JSON secret. Copy
# CREDENTIALS_ENCRYPTION_KEY / JWT_* / META_* from Railway —
# a new CREDENTIALS_ENCRYPTION_KEY makes stored tenant credentials unreadable.
app_secret_keys = [
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "CREDENTIALS_ENCRYPTION_KEY",
  "METRICS_TOKEN",
  "OPENAI_API_KEY",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_EMBEDDED_SIGNUP_CONFIG_ID",
  "META_WEBHOOK_VERIFY_TOKEN",
  "EMAIL_UNSUBSCRIBE_SECRET",
  # RL-01 FLIP — uncomment ONLY after the EDGE_PROXY_TOKEN key exists in
  # zt/production/app (a listed key that is absent stops every task from
  # starting). Until Vercel sends the header, the API ignores it.
  # "EDGE_PROXY_TOKEN",
  # PHASE 8 FLIP — add ONLY after `aws secretsmanager put-secret-value` has stored the key in
  # zt/production/app; a key listed here but absent from the JSON stops every ECS task from
  # starting. Production carries the LIVE key only (never TAP_TEST_SECRET_KEY).
  "TAP_LIVE_SECRET_KEY",
  "TAP_MERCHANT_ID",
]

# The live SNS alert topics had ONE confirmed subscriber (below) and no Terraform-managed one; list both so a
# human receives alerts even if the shared mailbox is unattended. Keep at least one monitored address here.
alert_emails       = ["alerts@ziyaratech.com", "mohamedhalemm40@gmail.com"]
monthly_budget_usd = 450 # GROSS usage (credits excluded since 2026-10); was 650 incl. credits, which never alerted

# Decision D-1 — OPEN (DISASTER-RECOVERY.md). Do NOT fill this in without the
# residency sign-off: the copy moves encrypted patient data out of eu-central-1.
# Empty = no cross-region copy (region loss => unbounded RPO, accepted only if
# recorded in writing). Must differ from aws_region.
dr_backup_region = ""
