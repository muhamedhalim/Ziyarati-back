variable "name" {
  description = "Resource name prefix"
  type        = string
}

variable "kms_key_arn" {
  description = "Primary-region env key"
  type        = string
}

variable "rds_arn" {
  description = "RDS instance to protect"
  type        = string
}

variable "schedule" {
  description = "Backup cron (UTC). 00:30 UTC = 03:30 KSA."
  type        = string
  default     = "cron(30 0 * * ? *)"
}

variable "retention_days" {
  description = "Retention in both vaults"
  type        = number
  default     = 14
}

variable "tags" {
  type    = map(string)
  default = {}
}
