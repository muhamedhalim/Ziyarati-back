variable "name" {
  description = "Resource name prefix"
  type        = string
}

variable "environment" {
  description = "staging | production"
  type        = string
}

variable "region" {
  description = "AWS region (dashboard widgets)"
  type        = string
}

variable "alert_emails" {
  description = "Alarm recipients (confirm the SNS subscription email once)"
  type        = list(string)
}

variable "kms_key_arn" {
  description = "KMS key for the alert topic"
  type        = string
}

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffix" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "api_service_name" {
  type = string
}

variable "worker_service_name" {
  type = string
}

variable "api_min_count" {
  type = number
}

variable "api_log_group_name" {
  type = string
}

variable "worker_log_group_name" {
  type = string
}

variable "rds_identifier" {
  type = string
}

variable "rds_max_connections" {
  type = number
}

variable "rds_allocated_storage_gb" {
  type = number
}

variable "redis_replication_group_id" {
  type = string
}

variable "redis_num_cache_clusters" {
  type = number
}

variable "ses_feedback_dlq_name" {
  type = string
}

variable "api_domain" {
  description = "Public API hostname for the external health check"
  type        = string
}

variable "enable_external_health_check" {
  description = "Route 53 health check + us-east-1 alarm"
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
