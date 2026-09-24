# One customer-managed "data" key per environment. It encrypts RDS (+ PI,
# snapshots, the RDS-managed master secret), S3 uploads, ElastiCache,
# Secrets Manager, CloudWatch Logs, SNS and SQS. One key keeps Phase 1 simple;
# splitting keys per data class is a Phase 3 separation-of-duties step.
#
# Account-principal access is delegated to IAM (standard root statement);
# service principals that act on their own behalf (Logs, SNS publishing from
# SES, CloudWatch alarms publishing to SNS) are granted explicitly and scoped
# to this account.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  tags       = merge(var.tags, { Component = "kms" })
}

data "aws_iam_policy_document" "key" {
  statement {
    sid       = "AccountRootDelegatesToIAM"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*",
      "kms:GenerateDataKey*", "kms:Describe*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${var.region}:${local.account_id}:log-group:*"]
    }
  }

  # SES → SNS (encrypted topic), CloudWatch alarms → SNS, SNS → SQS.
  statement {
    sid       = "ServicePublishersToEncryptedTopicsAndQueues"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type = "Service"
      identifiers = [
        "ses.amazonaws.com",
        "sns.amazonaws.com",
        "cloudwatch.amazonaws.com",
        "events.amazonaws.com", # GuardDuty findings → alert topic
      ]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "${var.name} data key (RDS, S3, ElastiCache, Secrets, Logs, SNS/SQS)"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.key.json
  tags                    = local.tags
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}
