# Whole-environment plan with a mocked AWS provider: proves the composition
# evaluates (for_each over the alarm catalogue, conditional modules, task
# definition JSON, precondition) without an AWS account.
#   terraform -chdir=infra/terraform/modules/platform init -backend=false
#   terraform -chdir=infra/terraform/modules/platform test

mock_provider "aws" {
  source = "../../testing/aws"
}

mock_provider "aws" {
  alias  = "dr"
  source = "../../testing/aws"
}

mock_provider "random" {}

variables {
  environment = "production"
  # TEST FIXTURE ONLY — this is not an approval of any hosting location.
  approved_regions      = ["me-central-1"]
  aws_region            = "me-central-1"
  availability_zone_ids = ["mec1-az1", "mec1-az2", "mec1-az3"]
  vpc_cidr              = "10.20.0.0/16"
  nat_gateway_count     = 2
  domain                = "ziyaratech.com"
  email_domain          = "ziyaratech.com"
  cookie_domain         = "ziyaratech.com"
  frontend_origins      = ["https://www.ziyaratech.com"]
  app_url               = "https://www.ziyaratech.com"
  image_tag             = "test"
  api = {
    cpu = 1024, memory = 2048, desired_count = 2, min_count = 2, max_count = 6, cpu_target = 60
  }
  worker = {
    cpu = 512, memory = 1024, desired_count = 1, min_count = 1, max_count = 3, cpu_target = 70
  }
  api_db_pool_max    = 10
  worker_db_pool_max = 10
  db = {
    engine_major_version     = "17"
    instance_class           = "db.t4g.medium"
    multi_az                 = true
    max_connections          = 300
    allocated_storage_gb     = 50
    max_allocated_storage_gb = 200
    backup_retention_days    = 14
  }
  redis = {
    node_type               = "cache.t4g.small"
    num_cache_clusters      = 2
    snapshot_retention_days = 7
  }
  app_environment = {
    EMAIL_FROM = "no-reply@ziyaratech.com"
    # A tfvars attempt to override a fixed platform decision must lose:
    STORAGE_PROVIDER = "r2"
    NODE_ENV         = "development"
  }
  api_app_secret_keys      = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"]
  worker_app_secret_keys   = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"]
  migrate_app_secret_keys  = []
  dmarc_rua                = "dmarc@ziyaratech.com"
  alert_emails             = ["alerts@example.com"]
  monthly_budget_usd       = 650
  github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  github_repository        = "muhamedhalim/Ziyarati-back"
  github_environment       = "production"
}

run "production_phase1_plans" {
  command = plan # mocked provider: no AWS account, real provider schema + plan logic

  assert {
    condition     = output.db_connection_budget == "220 / 240"
    error_message = "Connection budget math changed: ${output.db_connection_budget}"
  }

  assert {
    condition     = output.api_url == "https://api.ziyaratech.com"
    error_message = "API URL must be api.<domain>"
  }

  assert {
    condition     = local.common_env.STORAGE_PROVIDER == "s3" && local.common_env.NODE_ENV == "production"
    error_message = "Fixed platform env must override app_environment"
  }

  assert {
    condition     = local.common_env.REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC == "true" && local.common_env.DB_SSL_CA == "/app/certs/rds-global-bundle.pem"
    error_message = "Redis IaC attestation and RDS CA path must be set"
  }

  assert {
    condition     = local.worker_env.WORKER_ROLE == "all" && !contains(keys(local.api_env), "WORKER_ROLE")
    error_message = "WORKER_ROLE must be set on the worker and never on the API"
  }

  assert {
    condition     = length(module.backup) == 0
    error_message = "No cross-region copy may be created until decision D-1 sets dr_backup_region"
  }

  assert {
    condition     = local.api_domain == "api.ziyaratech.com"
    error_message = "The api CNAME must be in the DNS output"
  }
}

run "client_address_trust_is_one_hop_behind_an_append_alb" {
  command = plan

  assert {
    condition     = local.common_env.TRUST_PROXY_HOPS == "1"
    error_message = "The app must trust exactly the ALB hop (SEC-02)"
  }

  assert {
    condition     = module.alb.xff_mode == "append"
    error_message = "Trusting the last X-Forwarded-For entry is only safe if the ALB appends"
  }
}

run "connection_budget_blocks_unsafe_autoscaling" {
  command = plan

  variables {
    api = {
      cpu = 1024, memory = 2048, desired_count = 2, min_count = 2, max_count = 10, cpu_target = 60
    }
  }

  expect_failures = [terraform_data.db_connection_budget]
}

run "dr_copy_only_when_region_chosen" {
  command = plan

  variables {
    dr_backup_region         = "eu-central-1"
    approved_dr_destinations = ["eu-central-1"]
  }

  assert {
    condition     = length(module.backup) == 1
    error_message = "Setting dr_backup_region must enable the cross-region backup module"
  }
}

run "dr_region_must_differ_from_primary" {
  command = plan

  variables {
    dr_backup_region         = "me-central-1"
    approved_dr_destinations = ["me-central-1"]
  }

  expect_failures = [var.dr_backup_region]
}

# Data boundary (residency plan T1/T4): a region outside the approved list, an
# empty list, and an unapproved backup destination must all fail at plan time.
run "region_must_be_approved" {
  command = plan

  variables {
    aws_region = "eu-central-1"
  }

  expect_failures = [var.aws_region]
}

run "empty_approved_regions_block_every_plan" {
  command = plan

  variables {
    approved_regions = []
  }

  expect_failures = [var.aws_region]
}

run "dr_destination_must_be_approved" {
  command = plan

  variables {
    dr_backup_region         = "eu-central-1"
    approved_dr_destinations = []
  }

  expect_failures = [var.dr_backup_region]
}

run "no_backup_module_without_an_approved_destination" {
  command = plan

  assert {
    condition     = length(module.backup) == 0
    error_message = "No cross-region backup copy may exist when dr_backup_region is empty"
  }
}

run "rejects_frontend_origin_with_trailing_slash" {
  command = plan

  variables {
    frontend_origins = ["https://www.ziyaratech.com/"]
  }

  expect_failures = [var.frontend_origins]
}

# WELL-ARCHITECTED-REVIEW.md fixes: they must be wired through the composition,
# not just exist in their modules.
run "review_fixes_are_wired" {
  command = plan

  assert {
    condition = alltrue([
      contains(module.monitoring.alarm_names, "zt-production-critical-acm-certificate-expiry"),
      contains(module.monitoring.alarm_names, "zt-production-warning-worker-cpu"),
      contains(module.monitoring.alarm_names, "zt-production-warning-ses-feedback-queue-age"),
      contains(module.monitoring.alarm_names, "zt-production-critical-rds-disk-queue"),
    ])
    error_message = "The review's added alarms must be part of the catalogue"
  }

  assert {
    condition     = length([for n in module.monitoring.alarm_names : n if startswith(n, "zt-production-critical-nat-port-allocation-")]) == 2
    error_message = "One ErrorPortAllocation alarm per NAT gateway (test fixture has 2)"
  }

  assert {
    condition     = length(module.account_baseline) == 1
    error_message = "Account baseline (with the uploads-bucket data events) must be enabled by default"
  }
}

# Cookie scope (residency plan P9). The API validates COOKIE_DOMAIN with Joi
# hostname(), which REJECTS a leading dot — the previous ".<domain>" value would
# have failed the task's env validation at boot, so a regression here is a boot
# loop, not a cosmetic issue.
run "cookie_domain_is_a_bare_hostname_and_scopes_all_cookies_by_default" {
  command = plan

  assert {
    condition     = local.common_env.COOKIE_DOMAIN == "ziyaratech.com"
    error_message = "COOKIE_DOMAIN must be the bare parent domain (no leading dot)"
  }

  assert {
    condition     = !contains(keys(local.common_env), "CSRF_COOKIE_DOMAIN")
    error_message = "Without direct API routing the csrf cookie follows COOKIE_DOMAIN; CSRF_COOKIE_DOMAIN must be absent"
  }
}

run "direct_api_routing_scopes_only_the_csrf_cookie" {
  command = plan

  variables {
    cookie_domain      = ""
    csrf_cookie_domain = "ziyaratech.com"
  }

  assert {
    condition     = local.common_env.CSRF_COOKIE_DOMAIN == "ziyaratech.com"
    error_message = "The readable session hint must be shared with the app host"
  }

  assert {
    condition     = !contains(keys(local.common_env), "COOKIE_DOMAIN")
    error_message = "With COOKIE_DOMAIN unset the access/refresh cookies stay host-only on the API host, never sent to the page-serving tier"
  }
}

run "a_leading_dot_cookie_domain_is_refused" {
  command = plan

  variables {
    cookie_domain = ".ziyaratech.com"
  }

  expect_failures = [var.cookie_domain]
}

run "a_leading_dot_csrf_cookie_domain_is_refused" {
  command = plan

  variables {
    csrf_cookie_domain = ".ziyaratech.com"
  }

  expect_failures = [var.csrf_cookie_domain]
}

run "interface_endpoints_are_opt_in_and_reach_the_network_module" {
  command = plan

  assert {
    condition     = length(output.interface_endpoint_services) == 0
    error_message = "Interface endpoints are billed per AZ-hour and must default to off"
  }
}

run "interface_endpoints_can_be_enabled" {
  command = plan

  variables {
    enable_interface_endpoints = true
  }

  assert {
    condition     = toset(output.interface_endpoint_services) == toset(["secretsmanager", "kms", "ecr.api", "ecr.dkr", "logs", "sqs", "email", "sts"])
    error_message = "Enabling the flag must create the plan T15 endpoint set"
  }
}

run "log_data_protection_covers_every_owned_log_group" {
  command = plan

  assert {
    condition = toset(output.log_data_protection_groups) == toset([
      "ecs-api", "ecs-worker", "ecs-migrate", "ecs-ops",
      "rds-postgresql", "rds-upgrade", "elasticache-slow", "waf",
    ])
    error_message = "Every log group the stack owns must carry the data-protection policy (T16)"
  }
}

run "log_data_protection_can_be_switched_off" {
  command = plan

  variables {
    enable_log_data_protection = false
  }

  assert {
    condition     = length(output.log_data_protection_groups) == 0
    error_message = "The toggle must remove the policies"
  }
}
