terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Partial configuration: bucket + region + key + kms_key_id come from backend.hcl
  # (terraform init -backend-config=backend.hcl). Native S3 lockfile — no
  # DynamoDB table.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

locals {
  default_tags = {
    Project     = "ZiyaraTech"
    Environment = var.environment
    ManagedBy   = "Terraform"
    # Conservative label for the whole stack: it holds patient health data.
    # It is a classification, NOT a statement about where the data may live.
    DataClassification = "restricted-health"
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = merge(local.default_tags, { Region = var.aws_region })
  }
}

# Route 53 health-check metrics exist only in us-east-1.
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = local.default_tags
  }
}

# Decision D-1 DR copy region (falls back to the primary region when disabled;
# nothing is created through it then).
provider "aws" {
  alias               = "dr"
  region              = var.dr_backup_region != "" ? var.dr_backup_region : var.aws_region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = local.default_tags
  }
}

module "platform" {
  source = "../../modules/platform"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    aws.dr        = aws.dr
  }

  environment              = var.environment
  approved_regions         = var.approved_regions
  approved_dr_destinations = var.approved_dr_destinations
  aws_region               = var.aws_region
  availability_zone_ids    = var.availability_zone_ids
  vpc_cidr                 = var.vpc_cidr
  nat_gateway_count        = var.nat_gateway_count

  domain       = var.domain
  email_domain = var.domain
  # Cookie scope. Same-origin proxy (default): all three staff cookies on the parent
  # domain. Direct API routing (P9): only the readable csrf hint is shared; the
  # access/refresh cookies stay host-only on the API host. No leading dot — the
  # API rejects ".example.com" at boot.
  cookie_domain      = var.direct_api_routing ? "" : var.domain
  csrf_cookie_domain = var.direct_api_routing ? var.domain : ""
  frontend_origins   = var.frontend_origins
  app_url            = var.app_url

  enable_interface_endpoints = var.enable_interface_endpoints

  image_tag               = var.image_tag
  api                     = var.api
  worker                  = var.worker
  api_db_pool_max         = var.api_db_pool_max
  worker_db_pool_max      = var.worker_db_pool_max
  app_environment         = var.app_environment
  api_app_secret_keys     = var.app_secret_keys
  worker_app_secret_keys  = var.app_secret_keys
  migrate_app_secret_keys = []

  db    = var.db
  redis = var.redis

  waf_mode  = var.waf_mode
  dmarc_rua = var.dmarc_rua

  alert_emails       = var.alert_emails
  monthly_budget_usd = var.monthly_budget_usd
  dr_backup_region   = var.dr_backup_region

  log_retention_days     = 14
  deletion_protection    = false
  enable_execute_command = true

  github_oidc_provider_arn = "arn:aws:iam::${var.account_id}:oidc-provider/token.actions.githubusercontent.com"
  github_repository        = var.github_repository
  github_environment       = "staging"
}
