# Data boundary: every secret container uses the env CMK, and none is replicated
# to another region (a replica would copy the secret value out of the boundary).
#   terraform -chdir=infra/terraform/modules/secrets init -backend=false
#   terraform -chdir=infra/terraform/modules/secrets test

mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  secret_prefix = "zt/test"
  kms_key_arn   = "arn:aws:kms:me-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
  redis_url     = "rediss://:mock@redis:6379/0"
}

run "secrets_use_the_env_key_and_have_no_replicas" {
  command = plan

  assert {
    condition = alltrue([
      for s in [aws_secretsmanager_secret.database_url, aws_secretsmanager_secret.redis_url, aws_secretsmanager_secret.app] :
      s.kms_key_id == var.kms_key_arn && length(s.replica) == 0
    ])
    error_message = "Secrets must be encrypted with the env CMK and must not declare replica regions"
  }

  assert {
    condition = alltrue([
      for s in [aws_secretsmanager_secret.database_url, aws_secretsmanager_secret.redis_url, aws_secretsmanager_secret.app] :
      startswith(s.name, "${var.secret_prefix}/")
    ])
    error_message = "Secrets must live under the environment prefix"
  }
}
