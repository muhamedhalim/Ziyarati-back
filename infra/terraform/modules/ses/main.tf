# SES v2 — the only email provider. DNS is on Vercel DNS, so this module OUTPUTS the
# DKIM / MAIL FROM / DMARC records; SES verifies asynchronously once they
# exist. Bounce + complaint events flow SES → SNS → SQS → worker
# (SesFeedbackConsumer) — no public webhook to forge (ARCHITECTURE.md §7).
#
# NOTE: a new SES account is in the SANDBOX (verified recipients only,
# 200/day). Production access is a support request, not an API call —
# MIGRATION.md M1 step 4.

data "aws_caller_identity" "current" {}

locals {
  tags             = merge(var.tags, { Component = "ses" })
  mail_from_domain = "${var.mail_from_subdomain}.${var.domain}"
  account_id       = data.aws_caller_identity.current.account_id
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = var.name

  delivery_options {
    # Emails carry appointment details and account links: never cross the
    # internet in plaintext. A recipient server without STARTTLS bounces
    # (visible in the feedback stream) rather than silently downgrading.
    tls_policy = var.tls_policy
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  # Transactional mail never re-sends to a hard-bounced/complaining address.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  tags = local.tags
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity         = var.domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = local.tags
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# ── Feedback: SNS (encrypted) → SQS (encrypted) + DLQ ───────────────────────
resource "aws_sns_topic" "feedback" {
  name              = "${var.name}-ses-feedback"
  kms_master_key_id = var.kms_key_arn
  tags              = local.tags
}

data "aws_iam_policy_document" "feedback_topic" {
  statement {
    sid       = "AllowSesPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.feedback.arn]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "feedback" {
  arn    = aws_sns_topic.feedback.arn
  policy = data.aws_iam_policy_document.feedback_topic.json
}

resource "aws_sesv2_configuration_set_event_destination" "feedback" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "bounce-complaint-to-sns"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]

    sns_destination {
      topic_arn = aws_sns_topic.feedback.arn
    }
  }

  depends_on = [aws_sns_topic_policy.feedback]
}

resource "aws_sqs_queue" "feedback_dlq" {
  name                      = "${var.name}-ses-feedback-dlq"
  message_retention_seconds = 1209600 # 14 days
  kms_master_key_id         = var.kms_key_arn
  tags                      = local.tags
}

resource "aws_sqs_queue" "feedback" {
  name                       = "${var.name}-ses-feedback"
  message_retention_seconds  = 345600 # 4 days
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20
  kms_master_key_id          = var.kms_key_arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.feedback_dlq.arn
    maxReceiveCount     = 5
  })

  tags = local.tags
}

data "aws_iam_policy_document" "feedback_queue" {
  statement {
    sid       = "AllowFeedbackTopic"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.feedback.arn]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.feedback.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "feedback" {
  queue_url = aws_sqs_queue.feedback.id
  policy    = data.aws_iam_policy_document.feedback_queue.json
}

resource "aws_sns_topic_subscription" "feedback" {
  topic_arn            = aws_sns_topic.feedback.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.feedback.arn
  raw_message_delivery = true
  depends_on           = [aws_sqs_queue_policy.feedback]
}
