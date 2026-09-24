# Daily cross-region copy of the RDS instance (DISASTER-RECOVERY.md §2).
# Only instantiated when decision D-1 chose a DR region: the copy moves
# (encrypted) patient data out of the primary region.

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 6.0"
      configuration_aliases = [aws.dr]
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  tags = merge(var.tags, { Component = "backup" })
}

# Primary-region vault (AWS Backup needs a source vault even for RDS).
resource "aws_backup_vault" "primary" {
  name        = "${var.name}-primary"
  kms_key_arn = var.kms_key_arn
  tags        = local.tags
}

# DR-region key + vault. A separate key in the DR region: KMS keys are
# regional, and snapshot copies must be re-encrypted there.
data "aws_iam_policy_document" "dr_key" {
  statement {
    sid       = "AccountRootDelegatesToIAM"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "dr" {
  provider                = aws.dr
  description             = "${var.name} DR backup copies"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.dr_key.json
  tags                    = local.tags
}

resource "aws_backup_vault" "dr" {
  provider    = aws.dr
  name        = "${var.name}-dr"
  kms_key_arn = aws_kms_key.dr.arn
  tags        = local.tags
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_plan" "this" {
  name = "${var.name}-daily-dr"

  rule {
    rule_name         = "daily-with-dr-copy"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = var.schedule
    start_window      = 60
    completion_window = 360

    lifecycle {
      delete_after = var.retention_days
    }

    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle {
        delete_after = var.retention_days
      }
    }
  }

  tags = local.tags
}

resource "aws_backup_selection" "rds" {
  name         = "${var.name}-rds"
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [var.rds_arn]
}
