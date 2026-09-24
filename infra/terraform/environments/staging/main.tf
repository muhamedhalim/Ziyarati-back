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

  # Partial configuration: bucket + kms_key_id come from backend.hcl
  # (terraform init -backend-config=backend.hcl). Native S3 lockfile — no
  # DynamoDB table.
  backend "s3" {
    key          = "platform/terraform.tfstate"
    region       = "me-central-1"
    encrypt      = true
    use_lockfile = true
  }
}

locals {
  default_tags = {
    Project     = "ZiyaraTech"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = local.default_tags
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

  environment           = var.environment
  aws_region            = var.aws_region
  availability_zone_ids = var.availability_zone_ids
  vpc_cidr              = var.vpc_cidr
  nat_gateway_count     = var.nat_gateway_count

  domain           = var.domain
  email_domain     = var.domain
  cookie_domain    = ".${var.domain}"
  frontend_origins = var.frontend_origins
  app_url          = var.app_url

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
