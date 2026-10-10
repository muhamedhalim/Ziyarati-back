output "protected_log_groups" {
  description = "Keys of the log groups that carry the policy."
  value       = sort(keys(aws_cloudwatch_log_data_protection_policy.this))
}

output "policy_document" {
  description = "The rendered policy JSON (one document for every group)."
  value       = local.policy_document
}

output "custom_identifiers" {
  description = "name => regex actually applied (defaults merged with extras)."
  value       = local.custom_identifiers
}
