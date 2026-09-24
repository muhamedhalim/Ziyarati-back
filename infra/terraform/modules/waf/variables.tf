variable "name" {
  description = "Resource name prefix"
  type        = string
}

variable "alb_arn" {
  description = "ALB to protect"
  type        = string
}

variable "mode" {
  description = "\"count\" (observe, first 14 days) or \"block\""
  type        = string
  default     = "count"

  validation {
    condition     = contains(["count", "block"], var.mode)
    error_message = "mode must be count or block."
  }
}

variable "rate_limit_auth_per_5min" {
  description = "Requests per 5 min per forwarded client IP on /api/v1/auth/*"
  type        = number
  default     = 100
}

variable "rate_limit_public_per_5min" {
  description = "Requests per 5 min per forwarded client IP on /api/v1/public/*"
  type        = number
  default     = 300
}

variable "rate_limit_socketio_per_5min" {
  description = "Requests per 5 min per source IP on /socket.io/*"
  type        = number
  default     = 600
}

variable "rate_limit_global_per_5min" {
  description = "Requests per 5 min per forwarded client IP, all paths"
  type        = number
  default     = 3000
}

variable "rate_limit_source_ip_per_5min" {
  description = "Per SOURCE IP flood guard (count-only). Vercel egress IPs carry all REST traffic."
  type        = number
  default     = 50000
}

variable "kms_key_arn" {
  description = "KMS key for the WAF log group"
  type        = string
}

variable "log_retention_days" {
  description = "WAF log retention"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
