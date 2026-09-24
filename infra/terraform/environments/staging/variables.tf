variable "account_id" {
  description = "Staging AWS account id (CI: TF_VAR_account_id from a repository variable)"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "environment" {
  type    = string
  default = "staging"
}

variable "aws_region" {
  type = string
}

variable "availability_zone_ids" {
  type = list(string)
}

variable "vpc_cidr" {
  type = string
}

variable "nat_gateway_count" {
  type = number
}

variable "domain" {
  type = string
}

variable "frontend_origins" {
  type = list(string)
}

variable "app_url" {
  type = string
}

variable "image_tag" {
  description = "Must exist in ECR before the first apply (or set api/worker desired_count = 0)"
  type        = string
}

variable "api" {
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
  type = object({
    cpu           = number
    memory        = number
    desired_count = number
    min_count     = number
    max_count     = number
    cpu_target    = number
  })
}

variable "api_db_pool_max" {
  type = number
}

variable "worker_db_pool_max" {
  type = number
}

variable "app_environment" {
  type = map(string)
}

variable "app_secret_keys" {
  description = "Keys that MUST exist in the zt/staging/app secret JSON (a missing key blocks task start)"
  type        = list(string)
}

variable "db" {
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
  type = object({
    node_type               = string
    num_cache_clusters      = number
    snapshot_retention_days = number
  })
}

variable "waf_mode" {
  type = string
}

variable "dmarc_rua" {
  type = string
}

variable "alert_emails" {
  type = list(string)
}

variable "monthly_budget_usd" {
  type = number
}

variable "dr_backup_region" {
  description = "Decision D-1 — empty until residency sign-off"
  type        = string
  default     = ""
}

variable "github_repository" {
  type    = string
  default = "muhamedhalim/Ziyarati-back"
}
