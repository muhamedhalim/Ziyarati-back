# WAF for the API ALB. Traffic mix decides the design (SECURITY.md §4):
#   - REST arrives from VERCEL egress IPs (Next.js rewrite) with the real client
#     in X-Forwarded-For  → rate limits key on the FORWARDED IP;
#   - WebSocket (/socket.io) arrives straight from browsers → source IP;
#   - Meta / payment-provider (Tap) webhooks → managed signature
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

  # RL-01/RL-02: header-aware rules only once the edge token exists. Whether it
  # is set is not secret, so it may drive dynamic blocks.
  edge_aware  = nonsensitive(var.edge_proxy_token != null)
  edge_header = "x-zt-edge-token"

  webhook_prefixes = [
    "/api/v1/whatsapp/webhooks/",
    "/api/v1/payments/webhooks/",
  ]

  # RL-02 (owner decision 2026-10-22): API-key clients often run on cloud
  # addresses the reputation list flags (16 hits in 14 days, all on these
  # paths). They are authenticated per key and rate-limited per key in-app,
  # and every WAF rate rule still applies to them.
  ip_reputation_exempt_prefix = "/api/v1/integrations/"
}

resource "aws_wafv2_web_acl" "this" {
  name = "${var.name}-api"
  # No parentheses: the WAFv2 API only accepts [\w+=:#@/\-,\.] and spaces here.
  description = "ZiyaraTech API - ${var.mode} mode"
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

        scope_down_statement {
          not_statement {
            statement {
              byte_match_statement {
                search_string         = local.ip_reputation_exempt_prefix
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                # Express matches routes case-insensitively, so the exemption must too.
                text_transformation {
                  priority = 0
                  type     = "LOWERCASE"
                }
              }
            }
          }
        }
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

        # RL-02: 14 days of WAF logs (to 2026-10-22) show this rule matching
        # our own API routes (/api/v1/auth, /crm, /platform, /socket.io): API
        # clients and scripts that send no User-Agent. Not worth blocking on.
        rule_action_override {
          name = "NoUserAgent_HEADER"
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
  #    RL-02: once `edge_proxy_token` is set, X-Forwarded-For is trusted ONLY
  #    on requests carrying the secret edge header (added by the Vercel proxy,
  #    never by a browser). Without it a direct caller could rotate the first
  #    XFF entry freely; those requests are counted by rule 4b on the
  #    unforgeable source IP. Token unset = the original, header-blind rule.
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
          dynamic "byte_match_statement" {
            for_each = local.edge_aware ? [] : ["/api/v1/auth/"]
            content {
              search_string         = byte_match_statement.value
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
          dynamic "and_statement" {
            for_each = local.edge_aware ? ["/api/v1/auth/"] : []
            content {
              statement {
                byte_match_statement {
                  search_string         = and_statement.value
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
              statement {
                byte_match_statement {
                  search_string         = var.edge_proxy_token
                  positional_constraint = "EXACTLY"
                  field_to_match {
                    single_header {
                      name = local.edge_header
                    }
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

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-auth"
      sampled_requests_enabled   = true
    }
  }

  # ── 4b. Rate: auth endpoints, per SOURCE IP (unforgeable). Token unset: every
  #    request, and the limit must stay high because Vercel's few egress IPs
  #    front all browsers. Token set: DIRECT callers only (no edge header), so
  #    the stricter `rate_limit_auth_direct_per_5min` applies.
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
        limit                 = local.edge_aware ? var.rate_limit_auth_direct_per_5min : var.rate_limit_auth_source_ip_per_5min
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          dynamic "byte_match_statement" {
            for_each = local.edge_aware ? [] : ["/api/v1/auth/"]
            content {
              search_string         = byte_match_statement.value
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
          dynamic "and_statement" {
            for_each = local.edge_aware ? ["/api/v1/auth/"] : []
            content {
              statement {
                byte_match_statement {
                  search_string         = and_statement.value
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
              statement {
                not_statement {
                  statement {
                    byte_match_statement {
                      search_string         = var.edge_proxy_token
                      positional_constraint = "EXACTLY"
                      field_to_match {
                        single_header {
                          name = local.edge_header
                        }
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
      metric_name                = "${var.name}-rate-auth-source-ip"
      sampled_requests_enabled   = true
    }
  }

  # ── 5. Rate: public discovery/booking, per forwarded client IP ────────────
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

        # RL-02: forwarded IP trusted only with the edge header (see rule 4).
        scope_down_statement {
          dynamic "byte_match_statement" {
            for_each = local.edge_aware ? [] : ["/api/v1/public/"]
            content {
              search_string         = byte_match_statement.value
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
          dynamic "and_statement" {
            for_each = local.edge_aware ? ["/api/v1/public/"] : []
            content {
              statement {
                byte_match_statement {
                  search_string         = and_statement.value
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
              statement {
                byte_match_statement {
                  search_string         = var.edge_proxy_token
                  positional_constraint = "EXACTLY"
                  field_to_match {
                    single_header {
                      name = local.edge_header
                    }
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

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-public"
      sampled_requests_enabled   = true
    }
  }

  # ── 5b. Rate: public surface, DIRECT callers (no edge header), per source
  #    IP. Exists only with the edge token: without it rule 5 already sees all.
  dynamic "rule" {
    for_each = local.edge_aware ? ["/api/v1/public/"] : []
    content {
      name     = "rate-public-source-ip"
      priority = 55

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
          limit                 = var.rate_limit_public_direct_per_5min
          evaluation_window_sec = 300
          aggregate_key_type    = "IP"

          scope_down_statement {
            and_statement {
              statement {
                byte_match_statement {
                  search_string         = rule.value
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
              statement {
                not_statement {
                  statement {
                    byte_match_statement {
                      search_string         = var.edge_proxy_token
                      positional_constraint = "EXACTLY"
                      field_to_match {
                        single_header {
                          name = local.edge_header
                        }
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

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-rate-public-source-ip"
        sampled_requests_enabled   = true
      }
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

        # RL-02: forwarded IP trusted only with the edge header (see rule 4).
        dynamic "scope_down_statement" {
          for_each = local.edge_aware ? [1] : []
          content {
            byte_match_statement {
              search_string         = var.edge_proxy_token
              positional_constraint = "EXACTLY"
              field_to_match {
                single_header {
                  name = local.edge_header
                }
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

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-global"
      sampled_requests_enabled   = true
    }
  }

  # ── 8. Rate: per SOURCE IP flood guard.
  #    Token unset: Vercel egress IPs carry all REST traffic, so this stays a
  #    very high, COUNT-only signal (S-01 / F-2) whatever `mode` says.
  #    Token set: Vercel traffic is excluded (counted per real client by rule
  #    7), so it covers DIRECT callers only and follows `mode`.
  rule {
    name     = "rate-source-ip-flood"
    priority = 80

    action {
      dynamic "block" {
        for_each = local.blocking && local.edge_aware ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.blocking && local.edge_aware ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = local.edge_aware ? var.rate_limit_direct_flood_per_5min : var.rate_limit_source_ip_per_5min
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        dynamic "scope_down_statement" {
          for_each = local.edge_aware ? [1] : []
          content {
            not_statement {
              statement {
                byte_match_statement {
                  search_string         = var.edge_proxy_token
                  positional_constraint = "EXACTLY"
                  field_to_match {
                    single_header {
                      name = local.edge_header
                    }
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
  # RL-01: the edge token is a shared secret; never write it to the WAF log.
  redacted_fields {
    single_header {
      name = "x-zt-edge-token"
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
