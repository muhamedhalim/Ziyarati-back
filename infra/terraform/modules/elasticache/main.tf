# ElastiCache for Valkey, CLUSTER MODE DISABLED (ARCHITECTURE.md §5):
# BullMQ keys are not hash-tagged and the rate-limiter/lock Lua scripts touch
# several keys, so cluster mode (and ElastiCache Serverless) would CROSSSLOT.
#
# The AUTH token necessarily lives in Terraform state (ElastiCache needs the
# value). Mitigation: the state bucket is KMS-encrypted, versioned, TLS-only
# and readable only by the terraform roles (bootstrap module). The token is
# delivered to tasks through Secrets Manager inside REDIS_URL.

locals {
  tags     = merge(var.tags, { Component = "elasticache" })
  replicas = var.num_cache_clusters > 1
  # Deterministic, so dependents (alarm for_each keys) know it at PLAN time.
  replication_group_id = "${var.name}-valkey"
}

resource "random_password" "auth" {
  length  = 64
  special = false # ElastiCache forbids @ " / and spaces; alnum is simplest
}

resource "aws_elasticache_subnet_group" "this" {
  name        = "${var.name}-data"
  description = "Private data subnets"
  subnet_ids  = var.data_subnet_ids
  tags        = local.tags
}

resource "aws_elasticache_parameter_group" "this" {
  name        = "${var.name}-valkey8"
  family      = "valkey8"
  description = "BullMQ-safe: never evict queue keys"

  # BullMQ state must never be evicted. At 100% memory writes FAIL instead
  # (alarmed at 75%, SCALING-ROADMAP S-12). Because ElastiCache blocks
  # CONFIG GET, the app is told this was verified here:
  # REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC=true.
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }

  tags = local.tags
}

resource "aws_cloudwatch_log_group" "slow" {
  name              = "/aws/elasticache/${var.name}/slow-log"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = local.tags
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = local.replication_group_id
  description          = "ZiyaraTech BullMQ / Socket.IO / throttling"

  engine               = "valkey"
  engine_version       = var.engine_version
  node_type            = var.node_type
  num_cache_clusters   = var.num_cache_clusters
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.this.name

  automatic_failover_enabled = local.replicas
  multi_az_enabled           = local.replicas

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [var.security_group_id]

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.auth.result
  auth_token_update_strategy = "ROTATE"

  snapshot_retention_limit   = var.snapshot_retention_days
  snapshot_window            = var.snapshot_window
  maintenance_window         = var.maintenance_window
  auto_minor_version_upgrade = true
  apply_immediately          = false

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.slow.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  tags = local.tags
}
