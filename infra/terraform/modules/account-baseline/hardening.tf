# Account-wide guardrails that no single resource module owns. All are account
# (or account+region) singletons — hence they live in the once-per-account
# baseline, like CloudTrail and GuardDuty.

# Any bucket created later (by anyone, by mistake) is private by default.
resource "aws_s3_account_public_access_block" "this" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Every new EBS volume/snapshot in this region is encrypted (Fargate ephemeral
# storage is already encrypted; this covers anything an operator launches later).
resource "aws_ebs_encryption_by_default" "this" {
  enabled = true
}

# Console/IAM-user hygiene. Day-to-day access should be SSO/Identity Center;
# this only bounds any IAM user that exists anyway (CIS 1.8-1.11).
resource "aws_iam_account_password_policy" "this" {
  minimum_password_length        = 14
  require_lowercase_characters   = true
  require_uppercase_characters   = true
  require_numbers                = true
  require_symbols                = true
  allow_users_to_change_password = true
  max_password_age               = 365
  password_reuse_prevention      = 24
}
