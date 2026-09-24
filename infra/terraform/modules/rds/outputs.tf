output "endpoint" {
  description = "Hostname (without port)"
  value       = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "identifier" {
  value = aws_db_instance.this.identifier
}

output "arn" {
  value = aws_db_instance.this.arn
}

output "master_user_secret_arn" {
  description = "RDS-managed master secret (bootstrap only)"
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "database_name" {
  value = aws_db_instance.this.db_name
}
