# ZiyaraTech — STAGING. Same architecture as production, smaller and
# single-AZ where that only costs availability. SYNTHETIC DATA ONLY — never
# restore production data here (SECURITY.md §5).
#
# Separate registrable domain on purpose: with COOKIE_DOMAIN=.ziyaratech.com
# in production, any *.ziyaratech.com staging host would receive production
# auth cookies (ARCHITECTURE.md §2.3). Replace with the domain chosen in D-2.

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
]

alert_emails       = ["alerts@ziyaratech.com"]
monthly_budget_usd = 200
dr_backup_region   = ""
