output "policy_ids" {
  description = "SCP name -> policy ID"
  value       = { for k, p in aws_organizations_policy.this : k => p.id }
}

output "document_sizes" {
  description = "SCP name -> characters (limit 5,120)"
  value       = module.policies.document_sizes
}

output "allowed_regions" {
  description = "Regions the region deny lets through"
  value       = module.policies.allowed_regions
}

output "attachments" {
  description = "policy/target pairs that are attached"
  value       = sort(keys(aws_organizations_policy_attachment.this))
}
