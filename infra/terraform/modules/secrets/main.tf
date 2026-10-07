# Three secrets per environment (SECURITY.md §3):
#   database-url : written by the operator after creating the ziyarati_app role
#                  (Terraform never sees the app DB password)
#   redis-url    : written by Terraform (the AUTH token is already in state,
#                  because ElastiCache needs it)
#   app          : JSON of application secrets, written by the operator;
#                  ECS injects individual keys with "<arn>:<KEY>::"
#
# Terraform creates the containers; values arrive out-of-band via
# `aws secretsmanager put-secret-value`, so they never enter state or git.

locals {
  tags = merge(var.tags, { Component = "secrets" })
}

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.secret_prefix}/database-url"
  description             = "postgresql://ziyarati_app:...@<rds>:5432/ziyarati (no sslmode param)"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "${var.secret_prefix}/redis-url"
  description             = "rediss://:<auth>@<primary>:6379/0 (managed by Terraform)"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
  tags                    = local.tags
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = var.redis_url
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.secret_prefix}/app"
  description             = "JSON: JWT_*, CREDENTIALS_ENCRYPTION_KEY, METRICS_TOKEN, OPENAI_API_KEY, META_*, TAP_LIVE_SECRET_KEY (production) / TAP_TEST_SECRET_KEY (staging), ..."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
  tags                    = local.tags
}
