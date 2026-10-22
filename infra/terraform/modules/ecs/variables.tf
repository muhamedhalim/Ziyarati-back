variable "name" {
  description = "Resource name prefix / cluster name"
  type        = string
}

variable "environment" {
  description = "staging | production (log group path)"
  type        = string
}

variable "region" {
  description = "AWS region"
  type        = string
}

variable "repository_url" {
  description = "ECR repository URL"
  type        = string
}

variable "image_tag" {
  description = "Image tag Terraform registers. CI replaces it on every deploy (DEPLOYMENT.md §2)."
  type        = string
}

variable "cpu_architecture" {
  description = "X86_64 (Phase 1; bcrypt arm64-musl prebuild unverified) or ARM64"
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "container_port" {
  description = "API container port"
  type        = number
  default     = 3000
}

variable "app_subnet_ids" {
  description = "Private app subnets"
  type        = list(string)
}

variable "api_security_group_id" {
  description = "API SG"
  type        = string
}

variable "worker_security_group_id" {
  description = "Worker/migrate/ops SG"
  type        = string
}

variable "target_group_arn" {
  description = "ALB target group for the API"
  type        = string
}

variable "alb_request_count_resource_label" {
  description = "RL-03: \"<alb arn suffix>/<target group arn suffix>\" for ALBRequestCountPerTarget scaling; required only when api_requests_per_target_per_min is set"
  type        = string
  default     = null
}

variable "api_requests_per_target_per_min" {
  description = "RL-03: request-count scaling target per API task per minute; null = no request-count policy"
  type        = number
  default     = null
}

variable "api" {
  description = "API sizing and scaling"
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
  description = "Worker sizing and scaling"
  type = object({
    cpu           = number
    memory        = number
    desired_count = number
    min_count     = number
    max_count     = number
    cpu_target    = number
  })
}

variable "common_environment" {
  description = "Non-secret env for every root"
  type        = map(string)
}

variable "api_environment" {
  description = "Non-secret env for the API only"
  type        = map(string)
  default     = {}
}

variable "worker_environment" {
  description = "Non-secret env for the worker only"
  type        = map(string)
  default     = {}
}

variable "database_url_secret_arn" {
  description = "Secret holding DATABASE_URL"
  type        = string
}

variable "redis_url_secret_arn" {
  description = "Secret holding REDIS_URL"
  type        = string
}

variable "app_secret_arn" {
  description = "JSON app secret"
  type        = string
}

variable "api_app_secret_keys" {
  description = "Keys of the JSON app secret injected into the API (a missing key fails the task start — intentional)"
  type        = list(string)
}

variable "worker_app_secret_keys" {
  description = "Keys injected into the worker"
  type        = list(string)
}

variable "migrate_app_secret_keys" {
  description = "Keys injected into the migrate task (env validation runs there too)"
  type        = list(string)
}

variable "kms_key_arn" {
  description = "Env KMS key"
  type        = string
}

variable "uploads_bucket_arn" {
  description = "Uploads bucket"
  type        = string
}

variable "ses_identity_arn" {
  description = "SES domain identity ARN"
  type        = string
}

variable "ses_configuration_set_arn" {
  description = "SES configuration set ARN"
  type        = string
}

variable "ses_feedback_queue_arn" {
  description = "SQS queue with SES bounce/complaint events"
  type        = string
}

variable "rds_endpoint" {
  description = "RDS hostname (psql ops task)"
  type        = string
}

variable "rds_database_name" {
  description = "Database name (psql ops task)"
  type        = string
}

variable "rds_master_username" {
  description = "Master username (psql ops task)"
  type        = string
}

variable "rds_master_secret_arn" {
  description = "RDS-managed master secret (psql ops task only)"
  type        = string
}

variable "psql_image" {
  description = "Image for the break-glass psql task"
  type        = string
  default     = "public.ecr.aws/docker/library/postgres:17-alpine"
}

variable "enable_execute_command" {
  description = "ECS Exec (audited). Forces a writable root filesystem."
  type        = bool
  default     = false
}

variable "readonly_root_filesystem" {
  description = "Read-only root FS with a writable /tmp (ignored when ECS Exec is on)"
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "App log retention (data minimisation: 30 prod / 14 staging)"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
