# Security groups are chained by SG reference, never by CIDR. The only
# 0.0.0.0/0 ingress in the whole stack is the ALB's 80/443.

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public ALB: HTTPS in from the internet, HTTP only to redirect"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from internet (Vercel rewrite, browsers WS, Meta/Tap webhooks)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from internet, answered only with a 301 to HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "ALB to API tasks"
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = var.api_container_port
  to_port                      = var.api_container_port
}

# ── API tasks ────────────────────────────────────────────────────────────────
resource "aws_security_group" "api" {
  name        = "${var.name}-api"
  description = "API tasks: inbound only from the ALB"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-api" })
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "HTTP from ALB"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = var.api_container_port
  to_port                      = var.api_container_port
}

# ── Worker / migrate / ops tasks (no inbound at all) ────────────────────────
resource "aws_security_group" "worker" {
  name        = "${var.name}-worker"
  description = "Worker, migrate and ops tasks: no inbound"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-worker" })
}

# Task egress: HTTPS anywhere (OpenAI, Meta, Tap, AWS APIs, tenant
# integration endpoints — already SSRF-guarded in-app) + the data tier.
resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  for_each          = { api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  security_group_id = each.value
  description       = "HTTPS egress via NAT / S3 gateway endpoint"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "tasks_postgres" {
  for_each                     = { api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  security_group_id            = each.value
  description                  = "Postgres"
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "tasks_redis" {
  for_each                     = { api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  security_group_id            = each.value
  description                  = "Valkey/Redis TLS"
  referenced_security_group_id = aws_security_group.redis.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

# Tenant-configured outbound webhooks/integrations may legitimately target
# plain-HTTP or non-443 ports. Off by default; the in-app SSRF guard blocks
# private/link-local targets either way.
resource "aws_vpc_security_group_egress_rule" "worker_any_tcp" {
  count             = var.allow_worker_egress_any_port ? 1 : 0
  security_group_id = aws_security_group.worker.id
  description       = "Outbound integrations on non-443 ports (opt-in)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 1
  to_port           = 65535
}

# ── Data tier ────────────────────────────────────────────────────────────────
resource "aws_security_group" "rds" {
  name        = "${var.name}-rds"
  description = "Postgres: only from API and worker tasks"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-rds" })
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_tasks" {
  for_each                     = { api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  security_group_id            = aws_security_group.rds.id
  description                  = "Postgres from ${each.key}"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "Valkey: only from API and worker tasks"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-redis" })
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_tasks" {
  for_each                     = { api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  security_group_id            = aws_security_group.redis.id
  description                  = "Valkey from ${each.key}"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
