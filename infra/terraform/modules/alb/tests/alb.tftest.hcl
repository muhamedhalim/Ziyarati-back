# Edge boundary: the ALB log bucket is private, bounded in time and cannot be
# replicated; the XFF mode is pinned (client-address trust depends on it); TLS
# policy is modern; HTTP only redirects.
#   terraform -chdir=infra/terraform/modules/alb init -backend=false
#   terraform -chdir=infra/terraform/modules/alb test

mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  name                  = "zt-test"
  api_domain            = "api.example.test"
  vpc_id                = "vpc-123"
  public_subnet_ids     = ["subnet-a", "subnet-b", "subnet-c"]
  alb_security_group_id = "sg-alb"
}

run "log_bucket_is_private_bounded_and_not_replicable" {
  command = plan

  assert {
    condition = (
      aws_s3_bucket_public_access_block.logs.block_public_acls &&
      aws_s3_bucket_public_access_block.logs.block_public_policy &&
      aws_s3_bucket_public_access_block.logs.ignore_public_acls &&
      aws_s3_bucket_public_access_block.logs.restrict_public_buckets
    )
    error_message = "All four Block Public Access settings are required on the access-log bucket"
  }

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.logs.statement :
      s.sid == "DenyReplicationConfiguration" && contains(s.actions, "s3:PutReplicationConfiguration")
    ])
    error_message = "The access-log bucket must deny replication"
  }

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.logs.statement : s.sid == "DenyInsecureTransport"
    ])
    error_message = "TLS-only policy is required on the access-log bucket"
  }

  assert {
    condition     = one([for r in aws_s3_bucket_lifecycle_configuration.logs.rule : one(r.expiration).days]) == var.access_log_retention_days
    error_message = "Access logs (they hold query strings) must expire after access_log_retention_days"
  }
}

run "alb_pins_xff_mode_and_modern_tls" {
  command = plan

  assert {
    condition     = aws_lb.this.xff_header_processing_mode == "append"
    error_message = "append mode makes the last X-Forwarded-For entry unforgeable (SEC-02)"
  }

  assert {
    condition     = aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-2021-06"
    error_message = "HTTPS listener must use the TLS 1.3/1.2 policy"
  }

  assert {
    condition     = aws_lb.this.internal == false && one(aws_lb.this.access_logs).enabled == true
    error_message = "ALB is the only public entry point and must log access"
  }
}
