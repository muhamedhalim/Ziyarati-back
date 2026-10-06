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
  description = "Route 53 health check + its alarm (health-check metrics exist only in the aws.us_east_1 alias region)"
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "nat_gateway_count" {
  description = "Number of NAT gateways (plan-time known: keys the per-NAT alarms)"
  type        = number
  default     = 0
}

variable "nat_gateway_ids" {
  description = "NAT gateway ids, same order/length as nat_gateway_count"
  type        = list(string)
  default     = []
}

variable "certificate_arn" {
  description = "ACM certificate of the API listener; \"\" disables the expiry alarm"
  type        = string
  default     = ""
}

variable "ses_feedback_queue_name" {
  description = "SES bounce/complaint queue (age alarm); \"\" disables it"
  type        = string
  default     = ""
}

# for_each keys must be known at plan time, and the ARN / queue name are not
# (they are apply-time attributes) — so the alarms are switched by plain flags.
variable "enable_acm_alarm" {
  description = "Create the certificate-expiry alarm (needs certificate_arn)"
  type        = bool
  default     = false
}

variable "enable_ses_queue_alarm" {
  description = "Create the SES feedback queue age alarm (needs ses_feedback_queue_name)"
  type        = bool
  default     = false
}
