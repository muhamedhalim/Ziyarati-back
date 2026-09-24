output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "task_families" {
  value = {
    api     = aws_ecs_task_definition.api.family
    worker  = aws_ecs_task_definition.worker.family
    migrate = aws_ecs_task_definition.migrate.family
    psql    = aws_ecs_task_definition.psql.family
  }
}

output "role_arns" {
  description = "Roles the CI deploy role may pass (never the ops execution role)"
  value = {
    execution = aws_iam_role.execution.arn
    api       = aws_iam_role.api.arn
    worker    = aws_iam_role.worker.arn
    migrate   = aws_iam_role.migrate.arn
  }
}

output "log_group_names" {
  value = { for k, g in aws_cloudwatch_log_group.this : k => g.name }
}

output "log_group_arns" {
  value = { for k, g in aws_cloudwatch_log_group.this : k => g.arn }
}
