# ZiyaraTech — PRODUCTION (Phase 1). No secrets in this file: secret values
# live in Secrets Manager (zt/production/*). account_id comes from
# TF_VAR_account_id. Sizing rationale: infra/docs/ARCHITECTURE.md.

aws_region            = "me-central-1"
availability_zone_ids = ["mec1-az1", "mec1-az2", "mec1-az3"]
vpc_cidr              = "10.20.0.0/16"
nat_gateway_count     = 2

domain           = "ziyaratech.com"
frontend_origins = ["https://www.ziyaratech.com", "https://ziyaratech.com"]
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
  PAYMENT_PROVIDER                     = "moyasar"
  AUTH_REGISTER_OWNER_ENDPOINT_CEILING = "1000" # copy the live Railway value
  DEFAULT_LOCALE                       = "ar"
  ENABLE_API_DOCS                      = "false"
  ENABLE_INTEGRATION_DOCS              = "false"
  PLATFORM_API_LOG_ENABLED             = "false"
}

# Every key MUST exist in the zt/production/app JSON secret. Copy
# CREDENTIALS_ENCRYPTION_KEY / JWT_* / META_* / MOYASAR_* from Railway —
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
  "MOYASAR_SECRET_KEY",
  "MOYASAR_WEBHOOK_SECRET",
  "MOYASAR_PUBLISHABLE_KEY",
  "EMAIL_UNSUBSCRIBE_SECRET",
]

alert_emails       = ["alerts@ziyaratech.com"] # set the real on-call mailbox(es)
monthly_budget_usd = 650

# Decision D-1 (DISASTER-RECOVERY.md): e.g. "eu-central-1" once residency is
# signed off. Empty = no cross-region copy (region loss => unbounded RPO).
dr_backup_region = ""
