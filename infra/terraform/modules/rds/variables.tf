variable "name" {
  description = "Resource name prefix"
  type        = string
}

variable "data_subnet_ids" {
  description = "Private data subnets"
  type        = list(string)
}

variable "security_group_id" {
  description = "RDS security group"
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for storage, PI, logs and the managed master secret"
  type        = string
}

variable "engine_major_version" {
  description = "Postgres major version. Must be >= the Railway source major (MIGRATION.md M0)."
  type        = string
  default     = "17"
}

variable "instance_class" {
  description = "Instance class (Phase 1: db.t4g.medium prod, db.t4g.micro staging)"
  type        = string
}

variable "multi_az" {
  description = "Synchronous standby in another AZ (production: true)"
  type        = bool
}

variable "max_connections" {
  description = "Explicit max_connections; the platform connection-budget precondition uses it"
  type        = number
}

variable "database_name" {
  description = "Initial database name"
  type        = string
  default     = "ziyarati"
}

variable "master_username" {
  description = "Master (bootstrap-only) username"
  type        = string
  default     = "ziyarati_admin"
}

variable "allocated_storage_gb" {
  description = "Initial gp3 storage"
  type        = number
  default     = 50
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling"
  type        = number
  default     = 200
}

variable "backup_retention_days" {
  description = "PITR window (production 14)"
  type        = number
  default     = 14
}

variable "backup_window" {
  description = "UTC backup window (22:00 UTC = 01:00 KSA)"
  type        = string
  default     = "22:00-23:00"
}

variable "maintenance_window" {
  description = "UTC maintenance window (Fri 00:00 UTC = 03:00 KSA)"
  type        = string
  default     = "fri:00:00-fri:01:00"
}

variable "deletion_protection" {
  description = "Deletion protection"
  type        = bool
  default     = true
}

variable "slow_query_ms" {
  description = "log_min_duration_statement (ms)"
  type        = number
  default     = 1000
}

variable "enhanced_monitoring_interval" {
  description = "Enhanced Monitoring interval (0 disables)"
  type        = number
  default     = 60
}

variable "log_retention_days" {
  description = "Postgres log retention"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
