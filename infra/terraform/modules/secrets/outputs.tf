output "database_url_arn" {
  value = aws_secretsmanager_secret.database_url.arn
}

output "redis_url_arn" {
  value = aws_secretsmanager_secret.redis_url.arn
}

output "app_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "all_arns" {
  value = [
    aws_secretsmanager_secret.database_url.arn,
    aws_secretsmanager_secret.redis_url.arn,
    aws_secretsmanager_secret.app.arn,
  ]
}
