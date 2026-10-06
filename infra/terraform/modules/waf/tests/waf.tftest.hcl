mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  name        = "zt-test"
  alb_arn     = "arn:aws:elasticloadbalancing:me-central-1:123456789012:loadbalancer/app/zt-test/abc"
  kms_key_arn = "arn:aws:kms:me-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
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
