# Run ONCE per AWS account, by an admin, with LOCAL state (it creates the
# remote-state bucket everything else uses). Keep the resulting
# terraform.tfstate out of git (see infra/.gitignore); it holds no secrets.
#
#   terraform -chdir=infra/terraform/bootstrap init
#   terraform -chdir=infra/terraform/bootstrap apply -var-file=production.tfvars

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project     = "ZiyaraTech"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Component   = "bootstrap"
    }
  }
}

data "aws_partition" "current" {}

locals {
  state_bucket = "zt-${var.environment}-tfstate-${var.account_id}"
  # Plans run on pull requests and on pushes to the default branch only — not on
  # arbitrary branches/tags/environments of the repository.
  gh_sub_plan = [
    "repo:${var.github_repository}:pull_request",
    "repo:${var.github_repository}:ref:refs/heads/master",
  ]
  gh_sub_apply = "repo:${var.github_repository}:environment:infra-${var.environment}"
}

# ── State encryption key ─────────────────────────────────────────────────────
resource "aws_kms_key" "state" {
  # Single-Region: a multi-Region key would replicate key material to another Region.
  multi_region            = false
  description             = "Terraform state (zt-${var.environment})"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "state" {
  name          = "alias/zt-${var.environment}-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

# ── State bucket: versioned, KMS, private, TLS-only. Locking uses Terraform's
#    native S3 lockfile (use_lockfile = true) — no DynamoDB table needed. ────
resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "noncurrent-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
  depends_on = [aws_s3_bucket_versioning.state]
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
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

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json
}

# ── GitHub OIDC ──────────────────────────────────────────────────────────────
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "tf_plan_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Plans run on PRs and on master; PR-supplied Terraform executes under this
    # role, so it is read-only AND denied log/object content (see tf_plan_deny).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.gh_sub_plan
    }
  }
}

data "aws_iam_policy_document" "tf_apply_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Apply only from the protected GitHub Environment (required reviewers).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.gh_sub_apply]
    }
  }
}

# READ-ONLY: the plan job runs `terraform plan -lock=false`, so it never writes
# state or a lockfile. A malicious PR therefore cannot tamper with state.
data "aws_iam_policy_document" "state_access" {
  statement {
    sid       = "StateObjects"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.state.arn}/*"]
  }
  statement {
    sid       = "StateBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }
  statement {
    sid       = "StateKey"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.state.arn]
  }
}

# ReadOnlyAccess includes object reads on every bucket and log reads on every
# log group — i.e. patient documents and application logs. The plan role needs
# neither (Terraform reads configuration, not content).
data "aws_iam_policy_document" "tf_plan_deny" {
  statement {
    sid           = "NoObjectContentExceptState"
    effect        = "Deny"
    actions       = ["s3:GetObject", "s3:GetObjectVersion"]
    not_resources = ["${aws_s3_bucket.state.arn}/*"]
  }
  statement {
    sid    = "NoLogContent"
    effect = "Deny"
    actions = [
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:GetLogRecord",
      "logs:StartQuery",
      "logs:GetQueryResults",
      "logs:StartLiveTail",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "tf_plan_deny" {
  name   = "deny-content-reads"
  role   = aws_iam_role.tf_plan.id
  policy = data.aws_iam_policy_document.tf_plan_deny.json
}

resource "aws_iam_role" "tf_plan" {
  name               = "zt-${var.environment}-tf-plan"
  assume_role_policy = data.aws_iam_policy_document.tf_plan_assume.json
}

resource "aws_iam_role_policy_attachment" "tf_plan_readonly" {
  role       = aws_iam_role.tf_plan.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/ReadOnlyAccess"
}

# ReadOnlyAccess cannot read secret VALUES, which is what we want — but plan
# must read the Redis URL secret version it manages; it only needs Describe/
# GetSecretValue on that one secret, plus state access and lockfile writes.
resource "aws_iam_role_policy" "tf_plan_state" {
  name   = "state"
  role   = aws_iam_role.tf_plan.id
  policy = data.aws_iam_policy_document.state_access.json
}

data "aws_iam_policy_document" "tf_plan_managed_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${var.account_id}:secret:zt/${var.environment}/redis-url-*"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "tf_plan_managed_secret" {
  name   = "managed-secret"
  role   = aws_iam_role.tf_plan.id
  policy = data.aws_iam_policy_document.tf_plan_managed_secret.json
}

resource "aws_iam_role" "tf_apply" {
  name                 = "zt-${var.environment}-tf-apply"
  assume_role_policy   = data.aws_iam_policy_document.tf_apply_assume.json
  max_session_duration = 7200 # ACM/RDS creation can take > 1 h on first apply
}

# The apply role builds the whole environment (VPC, IAM, KMS, RDS ...).
# Its protection is WHO can assume it: only the protected infra-<env> GitHub
# Environment with required reviewers. SCPs (Phase 2) bound it further.
resource "aws_iam_role_policy_attachment" "tf_apply_admin" {
  role       = aws_iam_role.tf_apply.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AdministratorAccess"
}
