mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  name                     = "zt-test"
  environment              = "production"
  region                   = "me-central-1"
  repository_url           = "123456789012.dkr.ecr.me-central-1.amazonaws.com/ziyaratech/backend"
  image_tag                = "abc123"
  app_subnet_ids           = ["subnet-a", "subnet-b"]
  api_security_group_id    = "sg-api"
  worker_security_group_id = "sg-worker"
  target_group_arn         = "arn:aws:elasticloadbalancing:me-central-1:123456789012:targetgroup/zt/abc"
  api = {
    cpu = 1024, memory = 2048, desired_count = 2, min_count = 2, max_count = 6, cpu_target = 60
  }
  worker = {
    cpu = 512, memory = 1024, desired_count = 1, min_count = 1, max_count = 3, cpu_target = 70
  }
  common_environment        = { NODE_ENV = "production" }
  worker_environment        = { WORKER_ROLE = "all" }
  database_url_secret_arn   = "arn:aws:secretsmanager:me-central-1:123456789012:secret:zt/production/database-url-AbCdEf"
  redis_url_secret_arn      = "arn:aws:secretsmanager:me-central-1:123456789012:secret:zt/production/redis-url-AbCdEf"
  app_secret_arn            = "arn:aws:secretsmanager:me-central-1:123456789012:secret:zt/production/app-AbCdEf"
  api_app_secret_keys       = ["JWT_ACCESS_SECRET"]
  worker_app_secret_keys    = ["JWT_ACCESS_SECRET"]
  migrate_app_secret_keys   = []
  kms_key_arn               = "arn:aws:kms:me-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
  uploads_bucket_arn        = "arn:aws:s3:::zt-test-uploads-123456789012"
  ses_identity_arn          = "arn:aws:ses:me-central-1:123456789012:identity/ziyaratech.com"
  ses_configuration_set_arn = "arn:aws:ses:me-central-1:123456789012:configuration-set/zt-test"
  ses_feedback_queue_arn    = "arn:aws:sqs:me-central-1:123456789012:zt-test-ses-feedback"
  rds_endpoint              = "zt-test-pg.abc.me-central-1.rds.amazonaws.com"
  rds_database_name         = "ziyarati"
  rds_master_username       = "ziyarati_admin"
  rds_master_secret_arn     = "arn:aws:secretsmanager:me-central-1:123456789012:secret:rds!db-mock-AbCdEf"
}

run "secrets_are_injected_never_in_plain_env" {
  command = plan

  assert {
    condition = alltrue([
      for c in ["api", "worker"] : !anytrue([
        for e in jsondecode(c == "api" ? aws_ecs_task_definition.api.container_definitions : aws_ecs_task_definition.worker.container_definitions)[0].environment :
        contains(["DATABASE_URL", "REDIS_URL", "JWT_ACCESS_SECRET"], e.name)
      ])
    ])
    error_message = "Secrets must come from Secrets Manager, never plain environment"
  }

  assert {
    condition = (
      contains([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : s.valueFrom], var.database_url_secret_arn) &&
      contains([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : s.valueFrom], "${var.app_secret_arn}:JWT_ACCESS_SECRET::")
    )
    error_message = "API must receive DATABASE_URL and JSON-key app secrets via valueFrom"
  }

  assert {
    condition     = !contains([for s in jsondecode(aws_ecs_task_definition.migrate.container_definitions)[0].secrets : s.name], "REDIS_URL")
    error_message = "The migrate task needs no Redis credentials"
  }
}

run "tasks_are_private_and_hardened" {
  command = plan

  assert {
    condition = (
      aws_ecs_service.api.network_configuration[0].assign_public_ip == false &&
      aws_ecs_service.worker.network_configuration[0].assign_public_ip == false
    )
    error_message = "Tasks must not get public IPs"
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.api.container_definitions)[0].readonlyRootFilesystem == true
    error_message = "Read-only root filesystem is on when ECS Exec is off"
  }

  assert {
    condition = (
      aws_ecs_service.api.deployment_circuit_breaker[0].enable &&
      aws_ecs_service.api.deployment_circuit_breaker[0].rollback
    )
    error_message = "Circuit breaker with rollback is the automatic bad-deploy recovery"
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].command == ["node", "dist/src/worker.js"]
    error_message = "Worker must run the worker root"
  }
}

run "runtime_iam_has_no_wildcard_actions" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for doc in [data.aws_iam_policy_document.storage_and_email, data.aws_iam_policy_document.worker_feedback, data.aws_iam_policy_document.execution_secrets] : [
        for s in doc.statement : [for a in s.actions : a != "*" && !endswith(a, ":*")]
      ]
    ]))
    error_message = "Task/execution role policies must not grant wildcard actions"
  }
}

run "exec_forces_writable_root" {
  command = plan

  variables {
    enable_execute_command = true
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.api.container_definitions)[0].readonlyRootFilesystem == false
    error_message = "ECS Exec's agent needs a writable root filesystem"
  }
}
