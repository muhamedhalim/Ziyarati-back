mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  name        = "zt-test"
  kms_key_arn = "arn:aws:kms:me-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
}

run "uploads_bucket_is_private_encrypted_versioned" {
  command = plan

  assert {
    condition = (
      aws_s3_bucket_public_access_block.this.block_public_acls &&
      aws_s3_bucket_public_access_block.this.block_public_policy &&
      aws_s3_bucket_public_access_block.this.ignore_public_acls &&
      aws_s3_bucket_public_access_block.this.restrict_public_buckets
    )
    error_message = "All four Block Public Access settings are required"
  }

  assert {
    condition     = one([for r in aws_s3_bucket_ownership_controls.this.rule : r.object_ownership]) == "BucketOwnerEnforced"
    error_message = "ACLs must be disabled (BucketOwnerEnforced)"
  }

  assert {
    condition = alltrue([
      for r in aws_s3_bucket_server_side_encryption_configuration.this.rule :
      r.apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms" &&
      r.apply_server_side_encryption_by_default[0].kms_master_key_id == var.kms_key_arn
    ])
    error_message = "Default encryption must be SSE-KMS with the env key"
  }

  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Enabled"
    error_message = "Versioning is the accidental-deletion recovery mechanism"
  }

  assert {
    condition     = length(aws_s3_bucket_cors_configuration.this) == 0
    error_message = "No CORS unless explicitly required"
  }
}
