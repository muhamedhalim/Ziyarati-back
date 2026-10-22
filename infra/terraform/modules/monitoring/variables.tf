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
  description = "Route 53 health check on the API. Nothing alarms on it: its metric exists only in another region and the project keeps no alert resources outside the platform region (infra/docs/DATA-RESIDENCY.md A.2b)"
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

# ── Structured-log alarms (logs.tf, LOGGING.md §Alerts) ─────────────────────
variable "http_5xx_ratio_percent" {
  description = "Application 5xx ratio (percent of access-log requests) that raises L-02."
  type        = number
  default     = 2
}

variable "http_5xx_min_requests" {
  description = "Minimum requests per evaluation period before the 5xx ratio is evaluated (quiet periods never alarm)."
  type        = number
  default     = 50
}

variable "http_5xx_period_seconds" {
  description = "Evaluation period for the application 5xx ratio."
  type        = number
  default     = 300
}

variable "failed_login_burst_threshold" {
  description = "Failed logins in 5 minutes, across all sources, that raise L-03."
  type        = number
  default     = 20
}

variable "failed_login_ip_threshold" {
  description = "Failed logins in 5 minutes from ONE source address that raise L-03b."
  type        = number
  default     = 10
}

variable "enable_failed_login_ip_rule" {
  description = "Create the Contributor Insights rule (+ alarm) ranking failed logins by client_ip (~USD 0.50/month plus matched events). OFF by default (LSA-08): browser logins reach the API through the Vercel rewrite, so client_ip is Vercel's shared egress network for every user; the rule would rank unrelated users together and a WAF block on that address would block everyone. Enable only once the edge-token path supplies the real client address."
  type        = bool
  default     = false
}

variable "alarm_providers" {
  description = "Provider labels (provider-instrumentation.ts) that get a failure alarm."
  type        = list(string)
  default     = ["meta_graph", "openai", "tap"]
}

variable "provider_failure_threshold" {
  description = "Provider 5xx/429/timeout/network failures per 5 minutes (sustained 10 minutes) that raise L-08."
  type        = number
  default     = 10
}

variable "enable_log_silence_alarms" {
  description = "Alarm when the api/worker app.heartbeat stops for 10 minutes. Disable alarm actions during planned scale-to-zero."
  type        = bool
  default     = true
}

variable "waf_mode" {
  description = "RL-09: the WAF mode (count|block) — WAF rate-rule alarms watch CountedRequests in count mode, BlockedRequests in block mode"
  type        = string
  default     = "count"
}

variable "http_429_burst_threshold" {
  description = "RL-09: app HTTP 429 responses per 5 minutes that raise the 429-burst alarm (14-day baseline: 0)"
  type        = number
  default     = 200
}

variable "waf_rate_rule_threshold" {
  description = "RL-09: requests per 5 minutes one WAF rate rule may count/block before alarming (14-day baseline: 0)"
  type        = number
  default     = 50
}
