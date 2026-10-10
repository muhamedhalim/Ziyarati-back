# Organisation guardrails (residency plan T14): service control policies for the
# data boundary. A SEPARATE root from the workload environments because it is
# applied once, by a human, from the organisation's MANAGEMENT account — never by
# the environment CI roles, which must not hold Organizations write access.
#
# NOT APPLIED. Read infra/runbooks/org-guardrails-rollout.md before the first plan:
# a wrong SCP locks a whole account out of its own APIs, so it goes to a test OU
# first and the root last.
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Partial configuration: bucket / region / key come from backend.hcl
  # (terraform init -backend-config=backend.hcl). The bucket lives in the
  # management account, in an approved region. The state holds policy JSON and
  # IDs, no secrets.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

# The Organizations API is served from one endpoint; the region below is only
# where the provider signs and calls it (see terraform.tfvars).
provider "aws" {
  region              = var.organizations_api_region
  allowed_account_ids = [var.management_account_id]
  default_tags {
    tags = {
      Project   = "ZiyaraTech"
      ManagedBy = "Terraform"
      Component = "org-guardrails"
    }
  }
}

module "org_guardrails" {
  source = "../../modules/org-guardrails"

  target_ids                       = var.target_ids
  approved_regions                 = var.approved_regions
  us_east_1_health_check_exception = var.us_east_1_health_check_exception
  approved_backup_vault_arns       = var.approved_backup_vault_arns
  audit_exempt_principal_arns      = var.audit_exempt_principal_arns
  lifted_data_copy_actions         = var.lifted_data_copy_actions
}
