variable "secret_prefix" {
  description = "Secret name prefix, e.g. zt/production"
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for the secrets"
  type        = string
}

variable "redis_url" {
  description = "Full rediss:// URL incl. AUTH token"
  type        = string
  sensitive   = true
}

variable "recovery_window_in_days" {
  description = "Deleted-secret recovery window"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
