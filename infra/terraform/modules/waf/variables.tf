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

variable "rate_limit_auth_source_ip_per_5min" {
  description = "Requests per 5 min per SOURCE IP on /api/v1/auth/* while edge_proxy_token is UNSET (unforgeable key; high because Vercel egress IPs front many users)"
  type        = number
  default     = 1500
}

variable "rate_limit_auth_direct_per_5min" {
  description = "Requests per 5 min per SOURCE IP on /api/v1/auth/* for DIRECT callers (no edge header) once edge_proxy_token is set"
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
  description = "Per SOURCE IP flood guard while edge_proxy_token is UNSET (count-only: Vercel egress IPs carry all REST traffic)"
  type        = number
  default     = 50000
}

variable "rate_limit_direct_flood_per_5min" {
  description = "Per SOURCE IP flood guard for DIRECT callers (no edge header) once edge_proxy_token is set; follows mode"
  type        = number
  default     = 10000
}

variable "rate_limit_public_direct_per_5min" {
  description = "Requests per 5 min per SOURCE IP on /api/v1/public/* for DIRECT callers (no edge header) once edge_proxy_token is set"
  type        = number
  default     = 300
}

variable "edge_proxy_token" {
  description = "RL-01/RL-02: secret the Vercel proxy sends in X-ZT-Edge-Token (same value as the API's EDGE_PROXY_TOKEN). Forwarded-IP rules trust X-Forwarded-For only on requests carrying it. Supply via TF_VAR_edge_proxy_token from Secrets Manager; never commit it."
  type        = string
  default     = null
  sensitive   = true

  # null = header-blind rules exactly as before RL-02 (safe until the Vercel
  # proxy actually sends the header — see docs/rate-limit-proposed-changes).
  validation {
    condition     = var.edge_proxy_token == null || length(coalesce(var.edge_proxy_token, "")) >= 32
    error_message = "edge_proxy_token must be at least 32 characters (or null)."
  }
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
