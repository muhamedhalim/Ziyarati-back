mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  name        = "zt-test"
  alb_arn     = "arn:aws:elasticloadbalancing:me-central-1:123456789012:loadbalancer/app/zt-test/abc"
  kms_key_arn = "arn:aws:kms:me-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
  # Test-only value; real one comes from Secrets Manager via TF_VAR_edge_proxy_token.
  edge_proxy_token = "test-edge-token-0123456789abcdef0123456789"
}

# RL-02: every FORWARDED_IP rule must only trust X-Forwarded-For on requests
# carrying the edge header — otherwise a direct caller rotates the first entry.
run "forwarded_ip_rules_require_the_edge_header" {
  command = plan

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule :
      strcontains(jsonencode(r.statement[0].rate_based_statement[0].scope_down_statement), "x-zt-edge-token")
      if length(r.statement[0].rate_based_statement) > 0 && try(r.statement[0].rate_based_statement[0].aggregate_key_type, "") == "FORWARDED_IP"
    ])
    error_message = "Every FORWARDED_IP rate rule must be scoped to requests carrying x-zt-edge-token"
  }

  assert {
    condition = length([
      for r in aws_wafv2_web_acl.this.rule : r.name
      if length(r.statement[0].rate_based_statement) > 0 && try(r.statement[0].rate_based_statement[0].aggregate_key_type, "") == "FORWARDED_IP"
    ]) == 3
    error_message = "Expected exactly the three forwarded-IP rules (auth, public, global) — the check above must not pass vacuously"
  }
}

# RL-02: the flood guard must follow the mode switch (it was hard-coded count).
run "flood_guard_blocks_in_block_mode" {
  command = plan

  variables {
    mode = "block"
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule :
      length(r.action[0].block) == 1
      if r.name == "rate-source-ip-flood" || r.name == "rate-public-source-ip"
    ])
    error_message = "mode=block must block on the flood guard and the direct-caller public rule"
  }
}

run "edge_token_must_be_long" {
  command = plan

  variables {
    edge_proxy_token = "short"
  }

  expect_failures = [var.edge_proxy_token]
}

# Rule 4 trusts X-Forwarded-For, which a direct caller forges; rule 4b keys on
# the TCP source and must therefore exist and follow the mode switch.
run "auth_is_rate_limited_by_unforgeable_source_ip" {
  command = plan

  assert {
    condition     = contains([for r in aws_wafv2_web_acl.this.rule : r.name], "rate-auth-source-ip")
    error_message = "A source-IP keyed /auth/ rate rule must exist"
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule :
      r.statement[0].rate_based_statement[0].aggregate_key_type == "IP"
      if r.name == "rate-auth-source-ip"
    ])
    error_message = "rate-auth-source-ip must aggregate on the real source IP"
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule :
      length(r.action[0].count) == 1 && length(r.action[0].block) == 0
      if r.name == "rate-auth-source-ip"
    ])
    error_message = "In count mode the new rule must only count"
  }
}

run "block_mode_blocks_the_source_ip_rule" {
  command = plan

  variables {
    mode = "block"
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule :
      length(r.action[0].block) == 1
      if r.name == "rate-auth-source-ip"
    ])
    error_message = "mode=block must block on the source-IP rule"
  }
}

# WAF logs carry request metadata: finite retention and the env CMK.
run "waf_logs_are_retained_and_encrypted" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_group.waf.retention_in_days > 0 && aws_cloudwatch_log_group.waf.kms_key_id == var.kms_key_arn
    error_message = "WAF log group needs a finite retention and the env CMK"
  }
}

# RL-02: until the token exists (null), every rule must behave exactly as the
# live, header-blind ACL — otherwise applying this module before the Vercel
# proxy sends the header would rate-limit all browsers on Vercel's few IPs.
run "token_unset_keeps_the_header_blind_rules" {
  command = plan

  variables {
    edge_proxy_token = null
    mode             = "block"
  }

  assert {
    condition     = !contains([for r in aws_wafv2_web_acl.this.rule : r.name], "rate-public-source-ip")
    error_message = "The direct-caller public rule must not exist without the edge token"
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule :
      !strcontains(jsonencode(r.statement), "x-zt-edge-token")
    ])
    error_message = "No rule may reference the edge header while the token is unset"
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule :
      r.statement[0].rate_based_statement[0].limit == 1500
      if r.name == "rate-auth-source-ip"
    ])
    error_message = "Without the token the source-IP auth limit must stay at the Vercel-safe 1500"
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule :
      length(r.action[0].count) == 1 && length(r.action[0].block) == 0
      if r.name == "rate-source-ip-flood"
    ])
    error_message = "Without the token the flood guard must stay COUNT even in block mode (Vercel IPs carry all REST)"
  }
}

# RL-02: evidence from 14 days of WAF logs — this sub-rule matched our own API
# routes; it must never block, in either mode.
run "no_user_agent_rule_is_pinned_to_count" {
  command = plan

  variables {
    mode = "block"
  }

  assert {
    condition = anytrue([
      for r in aws_wafv2_web_acl.this.rule :
      contains([for o in r.statement[0].managed_rule_group_statement[0].rule_action_override : o.name], "NoUserAgent_HEADER")
      if r.name == "aws-common"
    ])
    error_message = "NoUserAgent_HEADER must be overridden to COUNT"
  }
}

# RL-01: the edge token is a shared secret and must never reach the WAF log.
run "edge_token_header_is_redacted_from_waf_logs" {
  command = plan

  assert {
    condition = contains(
      [for f in aws_wafv2_web_acl_logging_configuration.this.redacted_fields : f.single_header[0].name],
      "x-zt-edge-token"
    )
    error_message = "x-zt-edge-token must be in the WAF log redacted_fields"
  }
}

# RL-02 (owner decision 2026-10-22): API-key clients on reputation-listed cloud
# addresses must not be blocked on the integration API — and only there.
run "ip_reputation_exempts_only_the_integration_api" {
  command = plan

  variables {
    mode = "block"
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule :
      r.statement[0].managed_rule_group_statement[0].scope_down_statement[0].not_statement[0].statement[0].byte_match_statement[0].search_string == "/api/v1/integrations/"
      if r.name == "aws-ip-reputation"
    ])
    error_message = "ip-reputation must exempt exactly /api/v1/integrations/"
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule :
      length(r.override_action[0].none) == 1
      if r.name == "aws-ip-reputation"
    ])
    error_message = "ip-reputation must still block everything else in block mode"
  }
}
