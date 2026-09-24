output "dr_vault_arn" {
  value = aws_backup_vault.dr.arn
}

output "plan_id" {
  value = aws_backup_plan.this.id
}
