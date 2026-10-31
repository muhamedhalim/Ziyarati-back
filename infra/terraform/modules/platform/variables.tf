variable "environment" {
  description = "staging | production"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production (dev runs locally with docker-compose)."
  }
}

variable "approved_regions" {
  description = <<-EOT
    The ONLY regions this stack may be deployed to. No default on purpose: a region
    is added here after the hosting-location decision is approved in writing
    (infra/docs/SECURITY.md §6, decision D-1). An empty list blocks every plan.
  EOT
  type        = list(string)
}

variable "aws_region" {
  description = "Primary region. Must be a member of approved_regions; changing it on an existing state recreates the stack, so a region move is a NEW state (section 22 of the residency plan), never an in-place edit."
  type        = string

  validation {
    condition     = contains(var.approved_regions, var.aws_region)
    error_message = "aws_region is not in approved_regions. No region is approved until the hosting location is signed off in writing; do not add one without that decision."
  }
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
  description = <<-EOT
    COOKIE_DOMAIN, e.g. ziyaratech.com — scopes ALL THREE staff cookies (access, refresh, csrf)
    to the parent domain, shared by www. and api. so a WebSocket on a sibling host carries the
    auth cookie. Same-origin-proxy topology only. "" leaves them host-only (direct API routing:
    set csrf_cookie_domain instead). NO leading dot: the API's env validation (Joi hostname())
    rejects ".ziyaratech.com" and the task would fail to boot; browsers treat both forms alike.
  EOT
  type        = string

  validation {
    condition     = !startswith(var.cookie_domain, ".")
    error_message = "cookie_domain must not start with a dot (the API rejects \".example.com\" at boot); use \"example.com\" — browsers scope it to subdomains either way."
  }
}

variable "csrf_cookie_domain" {
  description = <<-EOT
    CSRF_COOKIE_DOMAIN — scopes ONLY the readable csrf_token / session-hint cookie to the parent
    domain, leaving the access and refresh cookies host-only on the API host. This is the cookie
    layout for direct API routing (residency plan P9): the app host can read the hint, but the
    page-serving tier is never sent a bearer credential. Use with cookie_domain = "". "" = unset
    (the csrf cookie follows cookie_domain). No leading dot.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = !startswith(var.csrf_cookie_domain, ".")
    error_message = "csrf_cookie_domain must not start with a dot; use \"example.com\"."
  }
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
    # Phase switch. false = trial phase: automated backups OFF (RDS retention 0,
    # no AWS Backup plan) while backup_retention_days is kept for re-enable.
    backup_enabled    = optional(bool, true)
    apply_immediately = optional(bool, false) # true = apply RDS class/retention changes now, not in the maintenance window
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

variable "waf_rate_rules_block" {
  description = "With waf_mode = block, also enforce the WAF rate rules (false = rate rules stay COUNT)."
  type        = bool
  default     = true
}

variable "edge_proxy_token" {
  description = "RL-01/RL-02: shared secret between the Vercel proxy, the WAF and the API (EDGE_PROXY_TOKEN). From TF_VAR_edge_proxy_token, sourced from Secrets Manager. null = header-blind WAF (pre-RL-02)."
  type        = string
  default     = null
  sensitive   = true
}

variable "api_requests_per_target_per_min" {
  description = "RL-03: ALBRequestCountPerTarget scaling target per API task per minute; null (default) = CPU scaling only. If enabled, ~1200 sits under the measured ~50-100 req/s per-core knee for a 0.5 vCPU task."
  type        = number
  default     = null
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

variable "approved_dr_destinations" {
  description = "Regions a backup copy may leave the primary region for. Empty until the DR scenario is approved in writing: a backup is patient data and a foreign copy is a cross-border transfer."
  type        = list(string)
  default     = []
}

variable "dr_backup_region" {
  description = "Decision D-1: region for daily cross-region RDS backup copies (\"\" = disabled)"
  type        = string
  default     = ""

  validation {
    condition     = var.dr_backup_region == "" || var.dr_backup_region != var.aws_region
    error_message = "dr_backup_region must differ from aws_region: a same-region copy gives no protection against a regional loss (use \"\" to disable)."
  }

  validation {
    condition     = var.dr_backup_region == "" || contains(var.approved_dr_destinations, var.dr_backup_region)
    error_message = "dr_backup_region is not in approved_dr_destinations. A backup copy is a transfer of patient data; approve the destination in writing first."
  }
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

variable "enable_interface_endpoints" {
  description = "Residency plan T15: PrivateLink interface endpoints (Secrets Manager, KMS, ECR api+dkr, CloudWatch Logs, SQS, SES, STS) so the tasks' AWS API calls stay off the NAT path. Billed per endpoint per AZ-hour (infra/docs/COST-MODEL.md). Default false = current behaviour."
  type        = bool
  default     = false
}

variable "enable_log_data_protection" {
  description = "Residency plan T16: attach a CloudWatch Logs data-protection policy (mask e-mail, Saudi mobile / national ID patterns, JWTs, pre-signed signatures) to every log group this stack owns. A backstop behind application-side scrubbing. Needs logs:PutDataProtectionPolicy on the apply role; set false only if that is refused and record why."
  type        = bool
  default     = true
}
