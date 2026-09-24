# ECS on Fargate: one image, three roots (ARCHITECTURE.md §2.2)
#   api     : image default CMD (node dist/src/main.js), behind the ALB
#   worker  : node dist/src/worker.js, no inbound
#   migrate : node dist/src/migrate.js run, one-shot (CI runs it before rollout)
# plus a break-glass `psql` ops task (there is no bastion; RDS is private).
#
# Terraform owns every task-definition field EXCEPT the image in use: services
# ignore task_definition changes and CI deploys by cloning the latest revision
# with a new image (DEPLOYMENT.md §2).

data "aws_caller_identity" "current" {}

locals {
  tags  = merge(var.tags, { Component = "ecs" })
  image = "${var.repository_url}:${var.image_tag}"

  # The data tier is private and there is no writable path the app needs other
  # than /tmp. ECS Exec's agent needs a writable root, so the two are exclusive.
  readonly_root = var.readonly_root_filesystem && !var.enable_execute_command

  to_env = {
    api     = [for k in sort(keys(merge(var.common_environment, var.api_environment))) : { name = k, value = merge(var.common_environment, var.api_environment)[k] }]
    worker  = [for k in sort(keys(merge(var.common_environment, var.worker_environment))) : { name = k, value = merge(var.common_environment, var.worker_environment)[k] }]
    migrate = [for k in sort(keys(var.common_environment)) : { name = k, value = var.common_environment[k] }]
  }

  base_secrets = [
    { name = "DATABASE_URL", valueFrom = var.database_url_secret_arn },
    { name = "REDIS_URL", valueFrom = var.redis_url_secret_arn },
  ]

  api_secrets    = concat(local.base_secrets, [for k in var.api_app_secret_keys : { name = k, valueFrom = "${var.app_secret_arn}:${k}::" }])
  worker_secrets = concat(local.base_secrets, [for k in var.worker_app_secret_keys : { name = k, valueFrom = "${var.app_secret_arn}:${k}::" }])
  # migrate.ts reads only DATABASE_URL (+ NODE_ENV / DB_SSL_CA); no Redis.
  migrate_secrets = concat(
    [{ name = "DATABASE_URL", valueFrom = var.database_url_secret_arn }],
    [for k in var.migrate_app_secret_keys : { name = k, valueFrom = "${var.app_secret_arn}:${k}::" }],
  )

  log_options = {
    for role in ["api", "worker", "migrate", "ops"] : role => {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this[role].name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = role
        # Logging back-pressure must never stall the event loop.
        "mode"            = "non-blocking"
        "max-buffer-size" = "25m"
      }
    }
  }

  tmp_mount = local.readonly_root ? [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }] : []
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  configuration {
    execute_command_configuration {
      kms_key_id = var.kms_key_arn
      logging    = "OVERRIDE"
      log_configuration {
        cloud_watch_encryption_enabled = true
        cloud_watch_log_group_name     = aws_cloudwatch_log_group.this["ops"].name
      }
    }
  }

  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "this" {
  for_each          = toset(["api", "worker", "migrate", "ops"])
  name              = "/ziyaratech/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = local.tags
}

# Container Insights creates this itself with "never expire" — own it.
resource "aws_cloudwatch_log_group" "container_insights" {
  name              = "/aws/ecs/containerinsights/${var.name}/performance"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn
  tags              = local.tags
}

# ── Task definitions ─────────────────────────────────────────────────────────
resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api.cpu
  memory                   = var.api.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  dynamic "volume" {
    for_each = local.readonly_root ? [1] : []
    content {
      name = "tmp"
    }
  }

  container_definitions = jsonencode([{
    name                   = "api"
    image                  = local.image
    essential              = true
    portMappings           = [{ containerPort = var.container_port, protocol = "tcp", name = "http" }]
    environment            = local.to_env.api
    secrets                = local.api_secrets
    logConfiguration       = local.log_options.api
    stopTimeout            = 60
    readonlyRootFilesystem = local.readonly_root
    mountPoints            = local.tmp_mount
    linuxParameters        = { initProcessEnabled = var.enable_execute_command }
  }])

  tags = local.tags
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker.cpu
  memory                   = var.worker.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  dynamic "volume" {
    for_each = local.readonly_root ? [1] : []
    content {
      name = "tmp"
    }
  }

  container_definitions = jsonencode([{
    name                   = "worker"
    image                  = local.image
    essential              = true
    command                = ["node", "dist/src/worker.js"]
    environment            = local.to_env.worker
    secrets                = local.worker_secrets
    logConfiguration       = local.log_options.worker
    stopTimeout            = 90 # BullMQ drain of in-flight jobs
    readonlyRootFilesystem = local.readonly_root
    mountPoints            = local.tmp_mount
    linuxParameters        = { initProcessEnabled = var.enable_execute_command }
  }])

  tags = local.tags
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.migrate.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name             = "migrate"
    image            = local.image
    essential        = true
    command          = ["node", "dist/src/migrate.js", "run"]
    environment      = local.to_env.migrate
    secrets          = local.migrate_secrets
    logConfiguration = local.log_options.migrate
  }])

  tags = local.tags
}

# Break-glass SQL (DB bootstrap, restores). Official Postgres image via the
# ECR Public mirror; TLS required (no CA file in that image — traffic stays in
# the VPC between private subnets). Run with `aws ecs run-task --overrides`.
resource "aws_ecs_task_definition" "psql" {
  family                   = "${var.name}-psql"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ops_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "psql"
    image     = var.psql_image
    essential = true
    command   = ["psql", "-c", "select version()"]
    environment = [
      { name = "PGHOST", value = var.rds_endpoint },
      { name = "PGDATABASE", value = var.rds_database_name },
      { name = "PGUSER", value = var.rds_master_username },
      { name = "PGSSLMODE", value = "require" },
    ]
    secrets          = [{ name = "PGPASSWORD", valueFrom = "${var.rds_master_secret_arn}:password::" }]
    logConfiguration = local.log_options.ops
  }])

  tags = local.tags
}

# ── Services ─────────────────────────────────────────────────────────────────
resource "aws_ecs_service" "api" {
  name                               = "${var.name}-api"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api.desired_count
  platform_version                   = "LATEST"
  enable_execute_command             = var.enable_execute_command
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  health_check_grace_period_seconds  = 120
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  availability_zone_rebalancing      = "ENABLED"

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.api_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "api"
    container_port   = var.container_port
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags       = local.tags
  depends_on = [aws_ecs_cluster_capacity_providers.this]
}

resource "aws_ecs_service" "worker" {
  name                               = "${var.name}-worker"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.worker.desired_count
  platform_version                   = "LATEST"
  enable_execute_command             = var.enable_execute_command
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  availability_zone_rebalancing      = "ENABLED"

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.worker_security_group_id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags       = local.tags
  depends_on = [aws_ecs_cluster_capacity_providers.this]
}

# ── Autoscaling ──────────────────────────────────────────────────────────────
# CPU is the measured bottleneck for the API (k6: one core saturates at
# ~100 it/s). 60% leaves headroom for event-loop latency. Worker queue-depth
# scaling needs the Phase 2 metrics sidecar (SCALING-ROADMAP U4).
resource "aws_appautoscaling_target" "this" {
  for_each = {
    api    = { service = aws_ecs_service.api.name, min = var.api.min_count, max = var.api.max_count }
    worker = { service = aws_ecs_service.worker.name, min = var.worker.min_count, max = var.worker.max_count }
  }
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${each.value.service}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.min
  max_capacity       = each.value.max
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = {
    api    = var.api.cpu_target
    worker = var.worker.cpu_target
  }
  name               = "${var.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.this[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.this[each.key].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = each.value
    scale_out_cooldown = 60
    scale_in_cooldown  = 300

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
