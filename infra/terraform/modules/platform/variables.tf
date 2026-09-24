variable "environment" {
  description = "staging | production"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production (dev runs locally with docker-compose)."
  }
}

variable "aws_region" {
  description = "Primary region (me-central-1 until the KSA region is GA and D-1 says otherwise)"
  type        = string
}

variable "availability_zone_ids" {
  description = "AZ IDs for subnets, e.g. [\"mec1-az1\",\"mec1-az2\",\"mec1-az3\"]"
  type        = list(string)
}

variable "vpc_cidr" {
  description = "VPC /16 (distinct per env so they can ever be peered)"
  type        = string
}

variable "nat_gateway_count" {
  description = "1 (staging) / 2 (production)"
  type        = number
}

# ── Naming / DNS ─────────────────────────────────────────────────────────────
variable "domain" {
  description = "Registrable domain of the env (production: ziyaratech.com; staging: a DIFFERENT registrable domain — ARCHITECTURE §2.3)"
  type        = string
}

variable "api_subdomain" {
  description = "API host label → <api_subdomain>.<domain>"
  type        = string
  default     = "api"
}

variable "email_domain" {
  description = "SES sending domain"
  type        = string
}

variable "cookie_domain" {
  description = "COOKIE_DOMAIN, e.g. .ziyaratech.com (shared by www. and api. so the WebSocket carries the auth cookie)"
  type        = string
}

variable "frontend_origins" {
  description = "Exact browser origins (no trailing slash) — REST CORS and the Socket.IO origin check"
  type        = list(string)

  validation {
    condition     = alltrue([for o in var.frontend_origins : can(regex("^https://[^/]+$", o))])
    error_message = "frontend_origins must be https://host with no path or trailing slash."
  }
}

variable "app_url" {
  description = "Base URL for links inside emails (APP_URL) — unset in Railway caused dead links (2026-09 incident)"
  type        = string
}

# ── Application image & runtime ──────────────────────────────────────────────
variable "image_tag" {
  description = "Image tag registered by Terraform; CI replaces it per deploy"
  type        = string
}

variable "cpu_architecture" {
  type    = string
  default = "X86_64"
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "api" {
  description = "API sizing: cpu (units), memory (MiB), desired/min/max count, CPU target %"
  type = object({
    cpu           = number
    memory        = number
    desired_count = number
    min_count     = number
    max_count     = number
    cpu_target    = number
  })
}

variable "worker" {
  description = "Worker sizing"
  type = object({
    cpu           = number
    memory        = number
    desired_count = number
    min_count     = number
    max_count     = number
    cpu_target    = number
  })
}

variable "worker_role" {
  description = "WORKER_ROLE for the worker service (all | critical); dispatch split is Phase 2"
  type        = string
  default     = "all"
}

variable "api_db_pool_max" {
  description = "API_DB_POOL_MAX per API task (k6: demand <= 5 at 100 it/s)"
  type        = number
  default     = 10
}

variable "worker_db_pool_max" {
  description = "WORKER_DB_POOL_MAX per worker task"
  type        = number
  default     = 10
}

variable "app_environment" {
  description = "Non-secret app config (EMAIL_FROM, AUTH_REGISTER_OWNER_ENDPOINT_CEILING, AI flags, ...). Fixed keys in platform/main.tf win."
  type        = map(string)
  default     = {}
}

variable "api_app_secret_keys" {
  description = "Keys of zt/<env>/app injected into the API"
  type        = list(string)
}

variable "worker_app_secret_keys" {
  description = "Keys of zt/<env>/app injected into the worker"
  type        = list(string)
}

variable "migrate_app_secret_keys" {
  description = "Keys of zt/<env>/app injected into the migrate task"
  type        = list(string)
}

# ── Data tier ────────────────────────────────────────────────────────────────
variable "db" {
  description = "RDS settings"
  type = object({
    engine_major_version     = string
    instance_class           = string
    multi_az                 = bool
    max_connections          = number
    allocated_storage_gb     = number
    max_allocated_storage_gb = number
    backup_retention_days    = number
  })
}

variable "redis" {
  description = "ElastiCache settings"
  type = object({
    node_type               = string
    num_cache_clusters      = number
    snapshot_retention_days = number
  })
}

variable "uploads_cors_allowed_origins" {
  type    = list(string)
  default = []
}

# ── Edge ─────────────────────────────────────────────────────────────────────
variable "waf_mode" {
  description = "count (first 14 days) | block"
  type        = string
  default     = "count"
}

variable "waf_rate_limits" {
  description = "Requests per 5 min"
  type = object({
    auth      = number
    public    = number
    socketio  = number
    global    = number
    source_ip = number
  })
  default = {
    auth      = 100
    public    = 300
    socketio  = 600
    global    = 3000
    source_ip = 50000
  }
}

# ── Email ────────────────────────────────────────────────────────────────────
variable "dmarc_rua" {
  description = "DMARC aggregate report mailbox"
  type        = string
}

variable "ses_tls_policy" {
  type    = string
  default = "REQUIRE"
}

# ── Operations ───────────────────────────────────────────────────────────────
variable "alert_emails" {
  description = "Alarm / budget recipients"
  type        = list(string)
}

variable "monthly_budget_usd" {
  description = "AWS Budgets monthly limit"
  type        = number
}

variable "enable_account_baseline" {
  description = "CloudTrail/GuardDuty/Access Analyzer/Budgets (once per account)"
  type        = bool
  default     = true
}

variable "enable_external_health_check" {
  type    = bool
  default = true
}

variable "dr_backup_region" {
  description = "Decision D-1: region for daily cross-region RDS backup copies (\"\" = disabled)"
  type        = string
  default     = ""
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "deletion_protection" {
  description = "RDS + ALB deletion protection"
  type        = bool
  default     = true
}

variable "kms_deletion_window_days" {
  type    = number
  default = 30
}

variable "secret_recovery_window_days" {
  type    = number
  default = 30
}

variable "enable_execute_command" {
  type    = bool
  default = false
}

variable "readonly_root_filesystem" {
  type    = bool
  default = true
}

variable "allow_worker_egress_any_port" {
  type    = bool
  default = false
}

# ── CI ───────────────────────────────────────────────────────────────────────
variable "github_oidc_provider_arn" {
  description = "From bootstrap/ output"
  type        = string
}

variable "github_repository" {
  description = "owner/repo allowed to deploy"
  type        = string
}

variable "github_environment" {
  description = "GitHub Environment allowed to deploy (staging | production)"
  type        = string
}

variable "tags" {
  description = "Extra tags (Project/Environment/ManagedBy come from provider default_tags)"
  type        = map(string)
  default     = {}
}
