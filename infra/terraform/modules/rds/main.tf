# RDS for PostgreSQL (ARCHITECTURE.md §3). The master password is
# RDS-managed in Secrets Manager (never in Terraform state) and used only to
# bootstrap the `ziyarati_app` role (MIGRATION.md §DB bootstrap). The
# application never connects as the master user.

locals {
  tags       = merge(var.tags, { Component = "rds" })
  identifier = "${var.name}-pg"
}

resource "aws_db_subnet_group" "this" {
  name        = "${var.name}-data"
  description = "Private data subnets (no default route)"
  subnet_ids  = var.data_subnet_ids
  tags        = local.tags
}

resource "aws_db_parameter_group" "this" {
  name        = "${var.name}-pg${var.engine_major_version}"
  family      = "postgres${var.engine_major_version}"
  description = "ZiyaraTech Postgres ${var.engine_major_version}"
  tags        = local.tags

  # TLS only. The app already refuses to connect without CA validation.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Known, explicit ceiling so the connection budget (platform module) is
  # computed against a real number, not an instance-RAM formula.
  parameter {
    name         = "max_connections"
    value        = tostring(var.max_connections)
    apply_method = "pending-reboot"
  }

  # Slow-query visibility WITHOUT bind values: a parameter can be a patient
  # name, phone or note (CURRENT-STATE-AUDIT F-11).
  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.slow_query_ms)
  }
  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }
  parameter {
    name  = "log_parameter_max_length_on_error"
    value = "0"
  }

  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Pre-created so retention + KMS are ours, not "never expire".
resource "aws_cloudwatch_log_group" "postgresql" {
  name              = "/aws/rds/instance/${local.identifier}/postgresql"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "upgrade" {
  name              = "/aws/rds/instance/${local.identifier}/upgrade"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = local.tags
}

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  name               = "${var.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  role       = aws_iam_role.monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier     = local.identifier
  engine         = "postgres"
  engine_version = var.engine_major_version
  instance_class = var.instance_class

  db_name  = var.database_name
  username = var.master_username

  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  storage_type          = "gp3"
  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.this.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"
  network_type           = "IPV4"

  backup_retention_period  = var.backup_retention_days
  backup_window            = var.backup_window
  maintenance_window       = var.maintenance_window
  copy_tags_to_snapshot    = true
  delete_automated_backups = false

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.identifier}-final"

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = false

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 7

  monitoring_interval = var.enhanced_monitoring_interval
  monitoring_role_arn = var.enhanced_monitoring_interval > 0 ? aws_iam_role.monitoring.arn : null

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = local.tags

  depends_on = [
    aws_cloudwatch_log_group.postgresql,
    aws_cloudwatch_log_group.upgrade,
  ]

  lifecycle {
    # Minor versions move under auto_minor_version_upgrade; don't fight them.
    ignore_changes = [engine_version]
  }
}
