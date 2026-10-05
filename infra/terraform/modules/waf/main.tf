# WAF for the API ALB. Traffic mix decides the design (SECURITY.md §4):
#   - REST arrives from VERCEL egress IPs (Next.js rewrite) with the real client
#     in X-Forwarded-For  → rate limits key on the FORWARDED IP;
#   - WebSocket (/socket.io) arrives straight from browsers → source IP;
#   - Meta / payment-provider (Tap; legacy Moyasar) webhooks → managed signature
#     rules are scoped OUT (their payloads trip SQLi/XSS/size signatures; they
#     are HMAC/secret-verified in-app instead). The Tap Connect callback
#     (/api/v1/payments/webhooks/tap/onboarding/<token>) lives under the same
#     prefix and is covered by it.
#
# `mode = "count"` for the first 14 days, then "block". KnownBadInputs blocks
# from day one (very low false-positive rate). SizeRestrictions_BODY stays
# COUNT permanently: the ALB lets WAF see only the first 8 KB of a body, so
# that rule would block every document upload and long AI prompt; body size
# is enforced in-app (multer 10 MB / guest 5 MB).

locals {
  tags     = merge(var.tags, { Component = "waf" })
  blocking = var.mode == "block"

  webhook_prefixes = [
    "/api/v1/whatsapp/webhooks/",
    "/api/v1/payments/webhooks/",
  ]
}

resource "aws_wafv2_web_acl" "this" {
  name        = "${var.name}-api"
  description = "ZiyaraTech API (${var.mode} mode)"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # ── 1. IP reputation ───────────────────────────────────────────────────────
  rule {
    name     = "aws-ip-reputation"
    priority = 10

    override_action {
      dynamic "none" {
        for_each = local.blocking ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.blocking ? [] : [1]
        content {}
      }
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  # ── 2. Known bad inputs — BLOCK from day one, webhooks excluded ────────────
  rule {
    name     = "aws-known-bad-inputs"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"

        scope_down_statement {
          not_statement {
            statement {
              or_statement {
                dynamic "statement" {
                  for_each = local.webhook_prefixes
                  content {
                    byte_match_statement {
                      search_string         = statement.value
                      positional_constraint = "STARTS_WITH"
                      field_to_match {
                        uri_path {}
                      }
                      text_transformation {
                        priority = 0
                        type     = "NONE"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # ── 3. Common rule set — webhooks excluded, body-size rule always COUNT ────
  rule {
    name     = "aws-common"
    priority = 30

    override_action {
      dynamic "none" {
        for_each = local.blocking ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.blocking ? [] : [1]
        content {}
      }
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }

        scope_down_statement {
          not_statement {
            statement {
              or_statement {
                dynamic "statement" {
                  for_each = local.webhook_prefixes
                  content {
                    byte_match_statement {
                      search_string         = statement.value
                      positional_constraint = "STARTS_WITH"
                      field_to_match {
                        uri_path {}
                      }
                      text_transformation {
                        priority = 0
                        type     = "NONE"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-common"
      sampled_requests_enabled   = true
    }
  }

  # ── 4. Rate: auth endpoints, per forwarded client IP ──────────────────────
  rule {
    name     = "rate-auth"
    priority = 40

    action {
      dynamic "block" {
        for_each = local.blocking ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.blocking ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.rate_limit_auth_per_5min
        evaluation_window_sec = 300
        aggregate_key_type    = "FORWARDED_IP"

        forwarded_ip_config {
          header_name       = "X-Forwarded-For"
          fallback_behavior = "NO_MATCH"
        }

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/v1/auth/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-auth"
      sampled_requests_enabled   = true
    }
  }

  # ── 4b. Rate: auth endpoints, per SOURCE IP ───────────────────────────────
  #    Rule 4 trusts the FIRST X-Forwarded-For entry. That is correct behind
  #    Vercel, but a client calling api.<domain> directly controls that value
  #    (the ALB appends, WAF reads the first) and can rotate it to dodge rule 4,
  #    or omit it (NO_MATCH => never counted). This rule keys on the TCP source,
  #    which cannot be forged. The limit is deliberately high: Vercel egress IPs
  #    front many users, so it only trips on one source hammering /auth/. It
  #    does not replace origin verification (WELL-ARCHITECTED-REVIEW.md SEC-01).
  rule {
    name     = "rate-auth-source-ip"
    priority = 45

    action {
      dynamic "block" {
        for_each = local.blocking ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.blocking ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.rate_limit_auth_source_ip_per_5min
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/v1/auth/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-auth-source-ip"
      sampled_requests_enabled   = true
    }
  }

  # ── 5. Rate: anonymous public surface (booking, guest AI REST) ────────────
  rule {
    name     = "rate-public"
    priority = 50

    action {
      dynamic "block" {
        for_each = local.blocking ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.blocking ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.rate_limit_public_per_5min
        evaluation_window_sec = 300
        aggregate_key_type    = "FORWARDED_IP"

        forwarded_ip_config {
          header_name       = "X-Forwarded-For"
          fallback_behavior = "NO_MATCH"
        }

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/v1/public/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-public"
      sampled_requests_enabled   = true
    }
  }

  # ── 6. Rate: Socket.IO handshakes/polling — browsers connect directly ─────
  rule {
    name     = "rate-socketio"
    priority = 60

    action {
      dynamic "block" {
        for_each = local.blocking ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.blocking ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.rate_limit_socketio_per_5min
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/socket.io/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-socketio"
      sampled_requests_enabled   = true
    }
  }

  # ── 7. Rate: global backstop per forwarded client IP ──────────────────────
  rule {
    name     = "rate-global-forwarded"
    priority = 70

    action {
      dynamic "block" {
        for_each = local.blocking ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.blocking ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.rate_limit_global_per_5min
        evaluation_window_sec = 300
        aggregate_key_type    = "FORWARDED_IP"

        forwarded_ip_config {
          header_name       = "X-Forwarded-For"
          fallback_behavior = "NO_MATCH"
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-global"
      sampled_requests_enabled   = true
    }
  }

  # ── 8. Rate: per SOURCE IP flood guard. Vercel egress IPs carry all REST
  #    traffic, so this limit must stay far above aggregate REST volume.
  #    Always COUNT until measured (S-01 / F-2).
  rule {
    name     = "rate-source-ip-flood"
    priority = 80

    action {
      count {}
    }

    statement {
      rate_based_statement {
        limit                 = var.rate_limit_source_ip_per_5min
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-source-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-api-acl"
    sampled_requests_enabled   = true
  }

  tags = local.tags
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

# ── Logging: only BLOCK/COUNT decisions, cookies/authorization redacted ─────
resource "aws_cloudwatch_log_group" "waf" {
  # WAF requires the "aws-waf-logs-" prefix.
  name              = "aws-waf-logs-${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = local.tags
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  logging_filter {
    default_behavior = "DROP"

    filter {
      behavior    = "KEEP"
      requirement = "MEETS_ANY"
      condition {
        action_condition {
          action = "BLOCK"
        }
      }
      condition {
        action_condition {
          action = "COUNT"
        }
      }
    }
  }
}
