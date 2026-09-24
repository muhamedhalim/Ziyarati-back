variable "name" {
  description = "Resource name prefix"
  type        = string
}

variable "data_subnet_ids" {
  description = "Private data subnets"
  type        = list(string)
}

variable "security_group_id" {
  description = "Redis security group"
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for at-rest encryption and logs"
  type        = string
}

variable "engine_version" {
  description = "Valkey engine version"
  type        = string
  default     = "8.0"
}

variable "node_type" {
  description = "Node type (Phase 1: cache.t4g.small prod, cache.t4g.micro staging)"
  type        = string
}

variable "num_cache_clusters" {
  description = "1 = single node; 2 = primary + replica with Multi-AZ failover"
  type        = number

  validation {
    condition     = var.num_cache_clusters >= 1 && var.num_cache_clusters <= 6
    error_message = "num_cache_clusters must be 1-6."
  }
}

variable "snapshot_retention_days" {
  description = "Daily snapshot retention (convenience only; Postgres is authoritative)"
  type        = number
  default     = 7
}

variable "snapshot_window" {
  description = "UTC snapshot window"
  type        = string
  default     = "23:00-00:00"
}

variable "maintenance_window" {
  description = "UTC maintenance window"
  type        = string
  default     = "fri:01:00-fri:02:00"
}

variable "log_retention_days" {
  description = "Slow-log retention"
  type        = number
  default     = 14
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
