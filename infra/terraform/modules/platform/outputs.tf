output "api_url" {
  value = "https://${local.api_domain}"
}

output "db_connection_budget" {
  description = "Worst-case connections vs 80% of max_connections"
  value       = "${local.db_connection_budget} / ${local.db_connection_ceiling}"
}

output "dns_records_to_create" {
  description = "Add these in Vercel DNS (DNS stays on Vercel; Route 53 is not used)"
  value = concat(
    [{ name = local.api_domain, type = "CNAME", value = module.alb.alb_dns_name }],
    module.alb.acm_validation_records,
    module.ses.dns_records,
  )
}

output "ecr_repository_url" {
  value = module.ecr.repository_url
}

output "cluster_name" {
  value = module.ecs.cluster_name
}

output "services" {
  value = {
    api    = module.ecs.api_service_name
    worker = module.ecs.worker_service_name
  }
}

output "task_families" {
  value = module.ecs.task_families
}

output "run_task_network" {
  description = "awsvpcConfiguration for `aws ecs run-task` (migrate / psql)"
  value = {
    subnets        = module.network.app_subnet_ids
    securityGroups = [module.network.security_group_ids.worker]
    assignPublicIp = "DISABLED"
  }
}

output "github_deploy_role_arn" {
  value = module.github_deploy.role_arn
}

output "secret_arns" {
  value = {
    database_url = module.secrets.database_url_arn
    redis_url    = module.secrets.redis_url_arn
    app          = module.secrets.app_arn
    rds_master   = module.rds.master_user_secret_arn
  }
}

output "rds_endpoint" {
  value = module.rds.endpoint
}

output "uploads_bucket" {
  value = module.s3_uploads.bucket_name
}

output "ses_feedback_queue_url" {
  value = module.ses.feedback_queue_url
}

output "nat_egress_ips" {
  value = module.network.nat_public_ips
}

output "alerts_topic_arn" {
  value = module.monitoring.alerts_topic_arn
}

output "interface_endpoint_services" {
  description = "AWS services reached through PrivateLink interface endpoints (empty while enable_interface_endpoints is false)"
  value       = module.network.interface_endpoint_services
}

output "log_data_protection_groups" {
  description = "Log groups carrying the CloudWatch data-protection policy (empty while enable_log_data_protection is false)"
  value       = one(module.log_protection[*].protected_log_groups) == null ? [] : one(module.log_protection[*].protected_log_groups)
}
