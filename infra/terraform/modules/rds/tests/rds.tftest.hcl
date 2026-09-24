mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  name                 = "zt-test"
  data_subnet_ids      = ["subnet-a", "subnet-b", "subnet-c"]
  security_group_id    = "sg-rds"
  kms_key_arn          = "arn:aws:kms:me-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
  instance_class       = "db.t4g.medium"
  multi_az             = true
  max_connections      = 300
  engine_major_version = "17"
}

run "database_is_private_encrypted_and_protected" {
  command = plan

  assert {
    condition     = aws_db_instance.this.publicly_accessible == false
    error_message = "RDS must never be publicly accessible"
  }

  assert {
    condition     = aws_db_instance.this.storage_encrypted == true && aws_db_instance.this.kms_key_id == var.kms_key_arn
    error_message = "RDS storage must be encrypted with the env CMK"
  }

  assert {
    condition     = aws_db_instance.this.manage_master_user_password == true
    error_message = "Master password must be RDS-managed (never in Terraform state)"
  }

  assert {
    condition = (
      aws_db_instance.this.deletion_protection == true &&
      aws_db_instance.this.skip_final_snapshot == false &&
      aws_db_instance.this.backup_retention_period == 14
    )
    error_message = "Deletion protection, final snapshot and 14-day PITR are required"
  }

  assert {
    condition     = aws_db_instance.this.multi_az == true
    error_message = "Production DB is Multi-AZ"
  }
}

run "parameters_enforce_tls_and_phi_safe_logging" {
  command = plan

  assert {
    condition = alltrue([
      for want in ["rds.force_ssl=1", "log_parameter_max_length=0", "log_parameter_max_length_on_error=0", "max_connections=300"] :
      contains([for p in aws_db_parameter_group.this.parameter : "${p.name}=${p.value}"], want)
    ])
    error_message = "force_ssl, PHI-safe logging and explicit max_connections must be set"
  }
}
