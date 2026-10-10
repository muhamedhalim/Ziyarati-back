output "primary_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "replication_group_id" {
  description = "Known at plan time (not the resource attribute) so alarm keys can use it"
  value       = local.replication_group_id
}

output "member_clusters" {
  value = aws_elasticache_replication_group.this.member_clusters
}

output "redis_url" {
  description = "rediss:// URL with the AUTH token — goes into Secrets Manager only"
  value       = "rediss://:${random_password.auth.result}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379/0"
  sensitive   = true
}

output "slow_log_group_name" {
  description = "Slow-log group (the data-protection policy attaches to it)."
  value       = aws_cloudwatch_log_group.slow.name
}
