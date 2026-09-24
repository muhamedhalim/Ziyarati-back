variable "name" {
  description = "Resource name prefix"
  type        = string
}

variable "region" {
  description = "AWS region (for the CloudWatch Logs service principal)"
  type        = string
}

variable "deletion_window_in_days" {
  description = "KMS key deletion waiting period (30 in production: a scheduled deletion is the last chance to stop crypto-shredding every backup)"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
