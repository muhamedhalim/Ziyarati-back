# VPC Flow Logs, REJECT traffic only (SECURITY.md / SCALING-ROADMAP U12).
# Why REJECT-only: it records every connection a security group or NACL denied
# (port scans, a mis-wired task, a probe at the data tier) for a few dollars a
# month, while ACCEPT records would multiply the volume for little forensic gain
# at this stage. Records contain IPs/ports/bytes only — no payload, no PHI.
#
# Delivered to S3, not CloudWatch: no ingestion charge, no IAM role to maintain,
# and a lifecycle rule bounds retention. S3 flow-log delivery supports SSE-S3
# (AES256) or KMS; SSE-S3 avoids another key policy for delivery.logs.amazonaws.com.

data "aws_caller_identity" "current" {}

locals {
  flow_bucket = "${var.name}-flowlogs-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "flow_logs" {
  count         = var.enable_flow_logs ? 1 : 0
  bucket        = local.flow_bucket
  force_destroy = false
  tags          = merge(local.tags, { Name = local.flow_bucket })
}

resource "aws_s3_bucket_public_access_block" "flow_logs" {
  count                   = var.enable_flow_logs ? 1 : 0
  bucket                  = aws_s3_bucket.flow_logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "flow_logs" {
  count  = var.enable_flow_logs ? 1 : 0
  bucket = aws_s3_bucket.flow_logs[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "flow_logs" {
  count  = var.enable_flow_logs ? 1 : 0
  bucket = aws_s3_bucket.flow_logs[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "flow_logs" {
  count  = var.enable_flow_logs ? 1 : 0
  bucket = aws_s3_bucket.flow_logs[0].id
  rule {
    id     = "expire-flow-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.flow_log_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  statement {
    sid       = "FlowLogDeliveryWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.flow_logs[0].arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid       = "FlowLogDeliveryAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.flow_logs[0].arn]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.flow_logs[0].arn, "${aws_s3_bucket.flow_logs[0].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "flow_logs" {
  count      = var.enable_flow_logs ? 1 : 0
  bucket     = aws_s3_bucket.flow_logs[0].id
  policy     = data.aws_iam_policy_document.flow_logs[0].json
  depends_on = [aws_s3_bucket_public_access_block.flow_logs]
}

resource "aws_flow_log" "reject" {
  count                    = var.enable_flow_logs ? 1 : 0
  vpc_id                   = aws_vpc.this.id
  traffic_type             = "REJECT"
  log_destination_type     = "s3"
  log_destination          = aws_s3_bucket.flow_logs[0].arn
  max_aggregation_interval = 600
  tags                     = merge(local.tags, { Name = "${var.name}-reject-flow-log" })

  depends_on = [aws_s3_bucket_policy.flow_logs]
}
