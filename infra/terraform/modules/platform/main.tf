# ZiyaraTech platform composition: one environment = one call of this module.
# Environment roots (environments/<env>) only choose sizes and names; every
# architectural decision lives here or in the component modules.

locals {
  name       = "zt-${var.environment}"
  api_domain = "${var.api_subdomain}.${var.domain}"
  tags       = var.tags

  # ── Fixed runtime contract (DEPLOYMENT.md §4). tfvars cannot override these:
  #    they encode decisions (TLS CA, IaC-verified Redis policy, S3/SES
  #    providers, logging posture) rather than tuning.
  fixed_common_env = {
    NODE_ENV                             = "production"
    PORT                                 = tostring(var.container_port)
    NO_COLOR                             = "1"             # plain-text CloudWatch lines (F-8)
    APP_ENV                              = var.environment # `env` on every log line (staging also runs NODE_ENV=production)
    AWS_REGION                           = var.aws_region
    DB_SSL_CA                            = "/app/certs/rds-global-bundle.pem"
    DB_MAX_CONNECTIONS                   = tostring(var.db.max_connections)
    API_DB_POOL_MAX                      = tostring(var.api_db_pool_max)
    WORKER_DB_POOL_MAX                   = tostring(var.worker_db_pool_max)
    REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC = "true" # noeviction set in the parameter group
    TYPEORM_SYNCHRONIZE                  = "false"
    TYPEORM_LOGGING                      = "false"
    SEED_ON_STARTUP                      = "false"
    STORAGE_PROVIDER                     = "s3"
    S3_BUCKET                            = module.s3_uploads.bucket_name
    SES_CONFIGURATION_SET                = module.ses.configuration_set_name
    FRONTEND_ORIGIN                      = join(",", var.frontend_origins)
    APP_URL                              = var.app_url
    API_BASE_URL                         = "https://${local.api_domain}"
    COOKIE_SAMESITE                      = "lax"
    # SEC-02: trust exactly one reverse proxy (the ALB, xff mode pinned to
    # "append") so req.ip is the ALB's real peer, not the ALB itself.
    TRUST_PROXY_HOPS = "1"
  }

  # Emitted only when set: the API's Joi schema rejects an EMPTY string for a
  # hostname variable, so "" must mean "absent", not an empty env value.
  cookie_scope_env = merge(
    var.cookie_domain != "" ? { COOKIE_DOMAIN = var.cookie_domain } : {},
    var.csrf_cookie_domain != "" ? { CSRF_COOKIE_DOMAIN = var.csrf_cookie_domain } : {},
  )

  common_env = merge(var.app_environment, local.fixed_common_env, local.cookie_scope_env)

  api_env = {
    API_CLUSTER_WORKERS = "1" # scale with tasks, not in-task cluster (ARCHITECTURE §2.2)
  }

  worker_env = {
    WORKER_ROLE            = var.worker_role
    SES_FEEDBACK_QUEUE_URL = module.ses.feedback_queue_url
  }

  # ── Postgres connection budget (ARCHITECTURE.md §4) ──────────────────────
  # ECS may run 2× desired during a rolling deploy. Per task: API = pool +
  # readiness client + migration-lock client; worker = pool + migration lock.
  db_connection_budget = (
    var.api.max_count * 2 * (var.api_db_pool_max + 2) +
    var.worker.max_count * 2 * (var.worker_db_pool_max + 1) +
    10
  )
  db_connection_ceiling = floor(var.db.max_connections * 0.8)
}

# Fails `terraform plan` — autoscaling limits or pool sizes can never be
# raised past what Postgres accepts without this being re-examined.
resource "terraform_data" "db_connection_budget" {
  input = {
    budget  = local.db_connection_budget
    ceiling = local.db_connection_ceiling
  }

  lifecycle {
    precondition {
      condition     = local.db_connection_budget <= local.db_connection_ceiling
      error_message = "Postgres connection budget exceeded: worst case ${local.db_connection_budget} connections (api_max ${var.api.max_count}×2×(${var.api_db_pool_max}+2) + worker_max ${var.worker.max_count}×2×(${var.worker_db_pool_max}+1) + 10) > 80% of max_connections ${var.db.max_connections} (${local.db_connection_ceiling}). Lower max counts/pool sizes, or raise db.max_connections with a larger instance class. See ARCHITECTURE.md §4."
    }
  }
}

module "kms" {
  source                  = "../kms"
  name                    = local.name
  region                  = var.aws_region
  deletion_window_in_days = var.kms_deletion_window_days
  tags                    = local.tags
}

module "network" {
  source                       = "../network"
  name                         = local.name
  region                       = var.aws_region
  vpc_cidr                     = var.vpc_cidr
  availability_zone_ids        = var.availability_zone_ids
  nat_gateway_count            = var.nat_gateway_count
  api_container_port           = var.container_port
  allow_worker_egress_any_port = var.allow_worker_egress_any_port
  enable_interface_endpoints   = var.enable_interface_endpoints
  tags                         = local.tags
}

module "ecr" {
  source          = "../ecr"
  repository_name = "ziyaratech/backend"
  kms_key_arn     = module.kms.key_arn
  tags            = local.tags
}

module "alb" {
  source                = "../alb"
  name                  = local.name
  api_domain            = local.api_domain
  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  alb_security_group_id = module.network.security_group_ids.alb
  container_port        = var.container_port
  deletion_protection   = var.deletion_protection
  tags                  = local.tags
}

module "waf" {
  source                        = "../waf"
  name                          = local.name
  alb_arn                       = module.alb.alb_arn
  mode                          = var.waf_mode
  edge_proxy_token              = var.edge_proxy_token
  rate_limit_auth_per_5min      = var.waf_rate_limits.auth
  rate_limit_public_per_5min    = var.waf_rate_limits.public
  rate_limit_socketio_per_5min  = var.waf_rate_limits.socketio
  rate_limit_global_per_5min    = var.waf_rate_limits.global
  rate_limit_source_ip_per_5min = var.waf_rate_limits.source_ip
  kms_key_arn                   = module.kms.key_arn
  log_retention_days            = var.log_retention_days
  tags                          = local.tags
}

module "rds" {
  source                   = "../rds"
  name                     = local.name
  data_subnet_ids          = module.network.data_subnet_ids
  security_group_id        = module.network.security_group_ids.rds
  kms_key_arn              = module.kms.key_arn
  engine_major_version     = var.db.engine_major_version
  instance_class           = var.db.instance_class
  multi_az                 = var.db.multi_az
  max_connections          = var.db.max_connections
  allocated_storage_gb     = var.db.allocated_storage_gb
  max_allocated_storage_gb = var.db.max_allocated_storage_gb
  backup_retention_days    = var.db.backup_enabled ? var.db.backup_retention_days : 0
  apply_immediately        = var.db.apply_immediately
  deletion_protection      = var.deletion_protection
  log_retention_days       = var.log_retention_days
  tags                     = local.tags

  depends_on = [terraform_data.db_connection_budget]
}

module "elasticache" {
  source                  = "../elasticache"
  name                    = local.name
  data_subnet_ids         = module.network.data_subnet_ids
  security_group_id       = module.network.security_group_ids.redis
  kms_key_arn             = module.kms.key_arn
  node_type               = var.redis.node_type
  num_cache_clusters      = var.redis.num_cache_clusters
  snapshot_retention_days = var.redis.snapshot_retention_days
  log_retention_days      = var.log_retention_days
  tags                    = local.tags
}

module "s3_uploads" {
  source               = "../s3-uploads"
  name                 = local.name
  kms_key_arn          = module.kms.key_arn
  cors_allowed_origins = var.uploads_cors_allowed_origins
  tags                 = local.tags
}

module "ses" {
  source      = "../ses"
  name        = local.name
  region      = var.aws_region
  domain      = var.email_domain
  dmarc_rua   = var.dmarc_rua
  tls_policy  = var.ses_tls_policy
  kms_key_arn = module.kms.key_arn
  tags        = local.tags
}

module "secrets" {
  source                  = "../secrets"
  secret_prefix           = "zt/${var.environment}"
  kms_key_arn             = module.kms.key_arn
  redis_url               = module.elasticache.redis_url
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = local.tags
}

module "ecs" {
  source                   = "../ecs"
  name                     = local.name
  environment              = var.environment
  region                   = var.aws_region
  repository_url           = module.ecr.repository_url
  image_tag                = var.image_tag
  cpu_architecture         = var.cpu_architecture
  container_port           = var.container_port
  app_subnet_ids           = module.network.app_subnet_ids
  api_security_group_id    = module.network.security_group_ids.api
  worker_security_group_id = module.network.security_group_ids.worker
  target_group_arn         = module.alb.target_group_arn
  # RL-03: scale the API on ALB requests per target as well as CPU.
  alb_request_count_resource_label = "${module.alb.alb_arn_suffix}/${module.alb.target_group_arn_suffix}"
  api_requests_per_target_per_min  = var.api_requests_per_target_per_min
  api                              = var.api
  worker                           = var.worker

  common_environment = local.common_env
  api_environment    = local.api_env
  worker_environment = local.worker_env

  database_url_secret_arn = module.secrets.database_url_arn
  redis_url_secret_arn    = module.secrets.redis_url_arn
  app_secret_arn          = module.secrets.app_arn
  api_app_secret_keys     = var.api_app_secret_keys
  worker_app_secret_keys  = var.worker_app_secret_keys
  migrate_app_secret_keys = var.migrate_app_secret_keys

  kms_key_arn               = module.kms.key_arn
  uploads_bucket_arn        = module.s3_uploads.bucket_arn
  ses_identity_arn          = module.ses.identity_arn
  ses_configuration_set_arn = module.ses.configuration_set_arn
  ses_feedback_queue_arn    = module.ses.feedback_queue_arn

  rds_endpoint          = module.rds.endpoint
  rds_database_name     = module.rds.database_name
  rds_master_username   = "ziyarati_admin"
  rds_master_secret_arn = module.rds.master_user_secret_arn

  enable_execute_command   = var.enable_execute_command
  readonly_root_filesystem = var.readonly_root_filesystem
  log_retention_days       = var.log_retention_days
  tags                     = local.tags
}

module "monitoring" {
  source = "../monitoring"
  providers = {
    aws = aws
  }

  name                         = local.name
  environment                  = var.environment
  region                       = var.aws_region
  alert_emails                 = var.alert_emails
  kms_key_arn                  = module.kms.key_arn
  alb_arn_suffix               = module.alb.alb_arn_suffix
  target_group_arn_suffix      = module.alb.target_group_arn_suffix
  cluster_name                 = module.ecs.cluster_name
  api_service_name             = module.ecs.api_service_name
  worker_service_name          = module.ecs.worker_service_name
  api_min_count                = var.api.min_count
  api_log_group_name           = module.ecs.log_group_names.api
  worker_log_group_name        = module.ecs.log_group_names.worker
  rds_identifier               = module.rds.identifier
  rds_max_connections          = var.db.max_connections
  rds_allocated_storage_gb     = var.db.allocated_storage_gb
  redis_replication_group_id   = module.elasticache.replication_group_id
  redis_num_cache_clusters     = var.redis.num_cache_clusters
  ses_feedback_dlq_name        = module.ses.feedback_dlq_name
  ses_feedback_queue_name      = module.ses.feedback_queue_name
  enable_ses_queue_alarm       = true
  certificate_arn              = module.alb.certificate_arn
  enable_acm_alarm             = true
  nat_gateway_count            = var.nat_gateway_count
  nat_gateway_ids              = module.network.nat_gateway_ids
  api_domain                   = local.api_domain
  enable_external_health_check = var.enable_external_health_check
  waf_mode                     = var.waf_mode
  tags                         = local.tags
}

module "account_baseline" {
  source = "../account-baseline"
  count  = var.enable_account_baseline ? 1 : 0

  name               = local.name
  region             = var.aws_region
  alerts_topic_arn   = module.monitoring.alerts_topic_arn
  monthly_budget_usd = var.monthly_budget_usd
  budget_emails      = var.alert_emails

  # Patient documents: record object-level access in CloudTrail.
  audited_bucket_arns = [module.s3_uploads.bucket_arn]
  tags                = local.tags
}

module "backup" {
  source = "../backup"
  count  = var.db.backup_enabled && var.dr_backup_region != "" ? 1 : 0
  providers = {
    aws    = aws
    aws.dr = aws.dr
  }

  name           = local.name
  kms_key_arn    = module.kms.key_arn
  rds_arn        = module.rds.arn
  retention_days = var.db.backup_retention_days
  tags           = local.tags
}

module "github_deploy" {
  source                = "../github-deploy"
  name                  = local.name
  oidc_provider_arn     = var.github_oidc_provider_arn
  github_repository     = var.github_repository
  github_environment    = var.github_environment
  ecr_repository_arn    = module.ecr.repository_arn
  cluster_arn           = module.ecs.cluster_arn
  passable_role_arns    = values(module.ecs.role_arns)
  migrate_log_group_arn = module.ecs.log_group_arns.migrate
  tags                  = local.tags
}

# Residency plan T16. One policy document on every log group this stack owns.
# Keys are literal so for_each is known at plan time; names may be computed.
module "log_protection" {
  count  = var.enable_log_data_protection ? 1 : 0
  source = "../log-protection"
  log_groups = merge(
    { for k, n in module.ecs.log_group_names : "ecs-${k}" => n },
    { for k, n in module.rds.log_group_names : "rds-${k}" => n },
    {
      "elasticache-slow" = module.elasticache.slow_log_group_name
      "waf"              = module.waf.log_group_name
    },
  )
}
