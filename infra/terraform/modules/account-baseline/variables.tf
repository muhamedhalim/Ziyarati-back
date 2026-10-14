variable "name" {
  description = "Resource name prefix"
  type        = string
}

variable "region" {
  description = "Home region (trail ARN)"
  type        = string
}

variable "alerts_topic_arn" {
  description = "Env alert topic (receives GuardDuty high findings; this module owns its policy)"
  type        = string
}

variable "cloudtrail_retention_days" {
  description = "CloudTrail log retention in S3"
  type        = number
  default     = 365
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget (COST-MODEL.md)"
  type        = number
}

variable "anomaly_threshold_usd" {
  description = "Minimum absolute anomaly impact (USD) to email about. Daily spend is ~$14, so 20 could only catch a >2x day."
  type        = number
  default     = 5
}

variable "budget_emails" {
  description = "Budget / anomaly recipients"
  type        = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "audited_bucket_arns" {
  description = "S3 buckets whose OBJECT-level reads/writes are recorded as CloudTrail data events (the patient-document bucket). Empty = none."
  type        = list(string)
  default     = []
}
