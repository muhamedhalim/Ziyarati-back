# Audit boundary: CloudTrail is validated, encrypted with its own single-Region
# key, delivered to a private non-replicable bucket, and reads of the audited
# (patient-document) buckets are recorded.
#   terraform -chdir=infra/terraform/modules/account-baseline init -backend=false
#   terraform -chdir=infra/terraform/modules/account-baseline test

mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  name               = "zt-test"
  region             = "me-central-1"
  alerts_topic_arn   = "arn:aws:sns:me-central-1:123456789012:zt-test-alerts"
  monthly_budget_usd = 100
  budget_emails      = ["ops@example.test"]
  audited_bucket_arns = [
    "arn:aws:s3:::zt-test-uploads-123456789012",
  ]
}

run "trail_is_validated_encrypted_and_private" {
  command = plan

  assert {
    condition = (
      aws_cloudtrail.this.enable_log_file_validation == true &&
      aws_cloudtrail.this.is_multi_region_trail == true &&
      aws_cloudtrail.this.include_global_service_events == true
    )
    error_message = "Trail needs log-file validation, all-region coverage and global service events"
  }

  assert {
    condition     = aws_kms_key.trail.multi_region == false && aws_kms_key.trail.enable_key_rotation == true
    error_message = "The trail key must be a single-Region, rotating key"
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.trail.block_public_acls &&
      aws_s3_bucket_public_access_block.trail.block_public_policy &&
      aws_s3_bucket_public_access_block.trail.ignore_public_acls &&
      aws_s3_bucket_public_access_block.trail.restrict_public_buckets
    )
    error_message = "All four Block Public Access settings are required on the trail bucket"
  }

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.trail_bucket.statement :
      s.sid == "DenyReplicationConfiguration" && contains(s.actions, "s3:PutReplicationConfiguration")
    ])
    error_message = "The trail bucket must deny replication"
  }
}

run "reads_of_audited_buckets_are_recorded" {
  command = plan

  assert {
    condition     = length(aws_cloudtrail.this.event_selector) == 1
    error_message = "Data events are expected when audited_bucket_arns is set"
  }
}
