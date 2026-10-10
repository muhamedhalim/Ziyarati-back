output "documents" {
  description = "SCP name -> policy JSON (minified, so the character count is the real size)."
  value       = local.documents
}

output "document_sizes" {
  description = "SCP name -> characters. AWS limit is 5,120 per policy."
  value       = { for k, v in local.documents : k => length(v) }
}

output "data_copy_catalogue" {
  description = "Every action the data-copy guard denies, grouped by feature."
  value       = local.data_copy_catalogue
}

output "allowed_regions" {
  description = "Regions the region deny lets through (approved + the health-check exception region, if any)."
  value       = local.allowed_regions
}
