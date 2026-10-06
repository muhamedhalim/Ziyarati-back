# Private tenant-document bucket (replaces Cloudflare R2). Keys are built
# server-side as <tenantId>/<docType>/<uuid>.<ext>; every read/delete is
# prefix-checked by StorageService.assertKeyBelongsToTenant. One task role
# serves all tenants, so IAM cannot express per-tenant prefixes — the
# enforcement point is the application, and this bucket makes sure nothing
# else (public access, ACLs, plaintext transport, other accounts) can bypass it.

data "aws_caller_identity" "current" {}

locals {
  tags   = merge(var.tags, { Component = "s3-uploads" })
  bucket = "${var.name}-uploads-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "this" {
  bucket        = local.bucket
  force_destroy = false
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  # Accidental delete/overwrite recovery window. Current objects are NOT
  # expired: clinical-record retention is a legal policy (SECURITY.md §6).
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
    expiration {
      expired_object_delete_marker = true
    }
  }

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

data "aws_iam_policy_document" "this" {
  # Data boundary: nobody (console, CLI or a stolen role) may turn on replication
  # and copy this bucket's objects to another bucket or region.
  statement {
    sid       = "DenyReplicationConfiguration"
    effect    = "Deny"
    actions   = ["s3:PutReplicationConfiguration"]
    resources = [aws_s3_bucket.this.arn]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]
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

  statement {
    sid       = "DenyOutsideAccount"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  # Every object must be written with the env key (the bucket default applies
  # it; this blocks a client explicitly asking for SSE-S3 or another key).
  statement {
    sid       = "DenyWrongEncryptionKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.this.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [var.kms_key_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket     = aws_s3_bucket.this.id
  policy     = data.aws_iam_policy_document.this.json
  depends_on = [aws_s3_bucket_public_access_block.this]
}

# Only needed if the frontend ever fetch()es a presigned URL cross-origin
# (MIGRATION.md M0 checks R2's existing CORS). Downloads today are navigations.
resource "aws_s3_bucket_cors_configuration" "this" {
  count  = length(var.cors_allowed_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.this.id
  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["*"]
    max_age_seconds = 300
  }
}
