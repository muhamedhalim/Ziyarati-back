output "policy_ids" {
  value = module.org_guardrails.policy_ids
}

output "document_sizes" {
  description = "Characters per SCP (limit 5,120)"
  value       = module.org_guardrails.document_sizes
}

output "allowed_regions" {
  value = module.org_guardrails.allowed_regions
}

output "attachments" {
  value = module.org_guardrails.attachments
}
