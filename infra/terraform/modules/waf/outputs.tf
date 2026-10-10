output "web_acl_arn" {
  value = aws_wafv2_web_acl.this.arn
}

output "web_acl_name" {
  value = aws_wafv2_web_acl.this.name
}

output "log_group_name" {
  description = "WAF log group (the data-protection policy attaches to it)."
  value       = aws_cloudwatch_log_group.waf.name
}
