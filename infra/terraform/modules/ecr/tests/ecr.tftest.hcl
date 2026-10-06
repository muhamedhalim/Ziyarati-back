# Image repository: immutable tags, scan on push, KMS encryption. (Images are D1,
# but the same no-replication rule applies — see region-gate.sh.)
#   terraform -chdir=infra/terraform/modules/ecr init -backend=false
#   terraform -chdir=infra/terraform/modules/ecr test

mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  repository_name = "ziyaratech/backend"
  kms_key_arn     = "arn:aws:kms:me-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
}

run "repository_is_immutable_scanned_and_encrypted" {
  command = plan

  assert {
    condition     = aws_ecr_repository.backend.image_tag_mutability == "IMMUTABLE"
    error_message = "A sha tag must always name the same bytes"
  }

  assert {
    condition     = one(aws_ecr_repository.backend.image_scanning_configuration).scan_on_push == true
    error_message = "Scan on push is the vulnerability signal the deploy gate reads"
  }

  assert {
    condition = (
      one(aws_ecr_repository.backend.encryption_configuration).encryption_type == "KMS" &&
      one(aws_ecr_repository.backend.encryption_configuration).kms_key == var.kms_key_arn
    )
    error_message = "Images must be encrypted with the env CMK"
  }
}
