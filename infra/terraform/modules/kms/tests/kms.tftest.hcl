# Residency control: the data key is a single-Region key (a multi-Region key
# replicates key material to another Region), rotates, and has a deletion window.
#   terraform -chdir=infra/terraform/modules/kms init -backend=false
#   terraform -chdir=infra/terraform/modules/kms test

mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  name   = "zt-test"
  region = "me-central-1"
}

run "data_key_is_single_region_and_rotating" {
  command = plan

  assert {
    condition     = aws_kms_key.data.multi_region == false
    error_message = "The data key must not be a multi-Region key"
  }

  assert {
    condition     = aws_kms_key.data.enable_key_rotation
    error_message = "Key rotation must stay enabled"
  }

  assert {
    condition     = aws_kms_key.data.deletion_window_in_days >= 30
    error_message = "A scheduled key deletion crypto-shreds every backup; keep the 30-day window"
  }
}
