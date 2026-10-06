# Residency control: the backup module's own key is single-Region, and the
# copy rule only targets the DR vault the module creates in the aliased
# provider's Region (the root decides that Region; see platform variable
# approved_dr_destinations).
#   terraform -chdir=infra/terraform/modules/backup init -backend=false
#   terraform -chdir=infra/terraform/modules/backup test

mock_provider "aws" {
  source = "../../testing/aws"
}

mock_provider "aws" {
  alias  = "dr"
  source = "../../testing/aws"
}

variables {
  name        = "zt-test"
  kms_key_arn = "arn:aws:kms:me-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
  rds_arn     = "arn:aws:rds:me-central-1:123456789012:db:zt-mock-pg"
}

run "dr_key_is_single_region" {
  command = plan

  providers = {
    aws    = aws
    aws.dr = aws.dr
  }

  assert {
    condition     = aws_kms_key.dr.multi_region == false
    error_message = "The DR backup key must not be a multi-Region key"
  }

  assert {
    condition     = length(one(aws_backup_plan.this.rule).copy_action) == 1
    error_message = "Exactly one copy action (to the DR vault) is expected"
  }
}
