# ZiyaraTech — STAGING. Same architecture as production, smaller and
# single-AZ where that only costs availability. SYNTHETIC DATA ONLY — never
# restore production data here (SECURITY.md §5).
#
# Separate registrable domain on purpose: with COOKIE_DOMAIN=ziyaratech.com
# in production, any *.ziyaratech.com staging host would receive production
# auth cookies (ARCHITECTURE.md §2.3). Replace with the domain chosen in D-2.

# Regions this environment may be deployed to. EMPTY ON PURPOSE: no hosting
# location is approved yet (infra/docs/SECURITY.md §6, decision D-1). With an
# empty list every plan fails closed (modules/platform variable validation and
# infra/scripts/region-gate.sh). Add a region ONLY after the hosting-location
# decision is approved in writing; aws_region below must then be a member.
approved_regions = []

aws_region            = "me-central-1"
availability_zone_ids = ["mec1-az1", "mec1-az2"]
vpc_cidr              = "10.30.0.0/16"
nat_gateway_count     = 1

domain           = "ziyaratech-staging.com"
frontend_origins = ["https://www.ziyaratech-staging.com"]
app_url          = "https://www.ziyaratech-staging.com"

image_tag = "bootstrap"

api = {
  cpu           = 512
  memory        = 1024
  desired_count = 1
  min_count     = 1
  max_count     = 2
  cpu_target    = 60
}

worker = {
  cpu           = 512
  memory        = 1024
  desired_count = 1
  min_count     = 1
  max_count     = 2
  cpu_target    = 70
}

# Budget: 2×2×(5+2) + 2×2×(5+1) + 10 = 62 <= 0.8 × 80 = 64
api_db_pool_max    = 5
worker_db_pool_max = 5

db = {
  engine_major_version     = "17"
  instance_class           = "db.t4g.micro"
  multi_az                 = false
  max_connections          = 80
  allocated_storage_gb     = 20
  max_allocated_storage_gb = 50
  backup_retention_days    = 7
}

redis = {
  node_type               = "cache.t4g.micro"
  num_cache_clusters      = 1
  snapshot_retention_days = 1
}

waf_mode  = "count"
dmarc_rua = "dmarc@ziyaratech-staging.com"

app_environment = {
  EMAIL_FROM                           = "no-reply@ziyaratech-staging.com"
  EMAIL_FROM_NAME                      = "ZiyaraTech Staging"
  EMAIL_ENABLED                        = "true"
  PAYMENT_PROVIDER                     = "moyasar" # Moyasar TEST keys in zt/staging/app
  AUTH_REGISTER_OWNER_ENDPOINT_CEILING = "1000"
  DEFAULT_LOCALE                       = "ar"
  ENABLE_API_DOCS                      = "false"
  ENABLE_INTEGRATION_DOCS              = "false"

  # Tap — safe to ship while PAYMENT_PROVIDER is still "moyasar" (nothing reads these until it is "tap").
  # PHASE 8 FLIP: PAYMENT_PROVIDER becomes "tap" here FIRST, on sandbox keys (runbook §4).
  TAP_ENV                      = "sandbox"
  TAP_WEBHOOK_URL              = "https://api.ziyaratech-staging.com/api/v1/payments/webhooks/tap"
  TAP_RECURRING_ENABLED        = "false"
  TAP_BOOKING_PAYMENTS_ENABLED = "false"
  # PHASE 8 FLIP: the dashboard "Merchant ID" (an identifier, not a secret):
  # TAP_MERCHANT_ID = "<numeric id>"
}

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
  # PHASE 8 FLIP — add ONLY after the key is stored in zt/staging/app (a listed key that is absent
  # from the JSON stops every ECS task from starting). Staging carries the TEST key only.
  # "TAP_TEST_SECRET_KEY",
]

alert_emails       = ["alerts@ziyaratech.com"]
monthly_budget_usd = 200
dr_backup_region   = ""
