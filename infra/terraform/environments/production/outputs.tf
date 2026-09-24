output "api_url" {
  value = module.platform.api_url
}

output "db_connection_budget" {
  value = module.platform.db_connection_budget
}

output "dns_records_to_create" {
  value = module.platform.dns_records_to_create
}

output "ecr_repository_url" {
  value = module.platform.ecr_repository_url
}

output "cluster_name" {
  value = module.platform.cluster_name
}

output "services" {
  value = module.platform.services
}

output "task_families" {
  value = module.platform.task_families
}

output "run_task_network" {
  value = module.platform.run_task_network
}

output "github_deploy_role_arn" {
  value = module.platform.github_deploy_role_arn
}

output "secret_arns" {
  value = module.platform.secret_arns
}

output "rds_endpoint" {
  value = module.platform.rds_endpoint
}

output "uploads_bucket" {
  value = module.platform.uploads_bucket
}

output "nat_egress_ips" {
  value = module.platform.nat_egress_ips
}
