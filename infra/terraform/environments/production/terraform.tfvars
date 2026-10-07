# ZiyaraTech — PRODUCTION (Phase 1). No secrets in this file: secret values
# live in Secrets Manager (zt/production/*). account_id comes from
# TF_VAR_account_id. Sizing rationale: infra/docs/ARCHITECTURE.md.

# Regions this environment may be deployed to. EMPTY ON PURPOSE: no hosting
# location is approved yet (infra/docs/SECURITY.md §6, decision D-1). With an
# empty list every plan fails closed (modules/platform variable validation and
# infra/scripts/region-gate.sh). Add a region ONLY after the hosting-location
# decision is approved in writing; aws_region below must then be a member.
approved_regions = []

aws_region            = "me-central-1"
availability_zone_ids = ["mec1-az1", "mec1-az2", "mec1-az3"]
vpc_cidr              = "10.20.0.0/16"
nat_gateway_count     = 2

domain = "ziyaratech.com"
# Every browser origin that opens a socket or sends credentialed requests: the marketing/dashboard site
# AND the patient marketplace (book.), whose AI widget dials wss://api.ziyaratech.com directly.
frontend_origins = ["https://www.ziyaratech.com", "https://ziyaratech.com", "https://book.ziyaratech.com"]
app_url          = "https://www.ziyaratech.com"

# First apply: a tag already pushed to ECR (see DEPLOYMENT.md §2).
image_tag = "bootstrap"

# 1 vCPU = one Node core (the API is CPU-bound on one core per k6).
api = {
  cpu           = 1024
  memory        = 2048
  desired_count = 2
  min_count     = 2
  max_count     = 6
  cpu_target    = 60
}

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
  engine_major_version     = "17" # must be >= the Railway major (MIGRATION.md M0)
  instance_class           = "db.t4g.medium"
  multi_az                 = true
  max_connections          = 300
  allocated_storage_gb     = 50
  max_allocated_storage_gb = 200
  backup_retention_days    = 14
}

redis = {
  node_type               = "cache.t4g.small"
  num_cache_clusters      = 2 # primary + replica, Multi-AZ failover
  snapshot_retention_days = 7
}

waf_mode  = "count" # switch to "block" after 14 clean days (SECURITY.md §4)
dmarc_rua = "dmarc@ziyaratech.com"

# Non-secret application config. Fixed platform keys (NODE_ENV, DB_SSL_CA,
# STORAGE_PROVIDER, EMAIL_PROVIDER, ...) are set by the platform module.
app_environment = {
  EMAIL_FROM                           = "no-reply@ziyaratech.com"
  EMAIL_FROM_NAME                      = "ZiyaraTech"
  EMAIL_ENABLED                        = "true"
  PAYMENT_PROVIDER                     = "tap"
  AUTH_REGISTER_OWNER_ENDPOINT_CEILING = "1000" # copy the live Railway value
  DEFAULT_LOCALE                       = "ar"
  ENABLE_API_DOCS                      = "false"
  ENABLE_INTEGRATION_DOCS              = "false"
  PLATFORM_API_LOG_ENABLED             = "false"

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
  # PHASE 8 FLIP — add ONLY after `aws secretsmanager put-secret-value` has stored the key in
  # zt/production/app; a key listed here but absent from the JSON stops every ECS task from
  # starting. Production carries the LIVE key only (never TAP_TEST_SECRET_KEY).
  # "TAP_LIVE_SECRET_KEY",
]

alert_emails       = ["alerts@ziyaratech.com"] # set the real on-call mailbox(es)
monthly_budget_usd = 650

# Decision D-1 — OPEN (DISASTER-RECOVERY.md). Do NOT fill this in without the
# residency sign-off: the copy moves encrypted patient data out of me-central-1.
# Empty = no cross-region copy (region loss => unbounded RPO, accepted only if
# recorded in writing). Must differ from aws_region.
dr_backup_region = ""
