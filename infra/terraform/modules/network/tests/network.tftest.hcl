mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  name                  = "zt-test"
  region                = "me-central-1"
  vpc_cidr              = "10.20.0.0/16"
  availability_zone_ids = ["mec1-az1", "mec1-az2", "mec1-az3"]
  nat_gateway_count     = 2
}

run "only_the_alb_is_open_to_the_internet" {
  command = plan

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.alb_https.cidr_ipv4 == "0.0.0.0/0" &&
      aws_vpc_security_group_ingress_rule.alb_http.cidr_ipv4 == "0.0.0.0/0"
    )
    error_message = "ALB must accept 80/443 from the internet"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.api_from_alb.cidr_ipv4 == null
    error_message = "API tasks must only accept traffic from the ALB security group"
  }

  assert {
    condition = alltrue(concat(
      [for r in aws_vpc_security_group_ingress_rule.rds_from_tasks : r.cidr_ipv4 == null && r.cidr_ipv6 == null && r.from_port == 5432],
      [for r in aws_vpc_security_group_ingress_rule.redis_from_tasks : r.cidr_ipv4 == null && r.cidr_ipv6 == null && r.from_port == 6379],
    ))
    error_message = "No CIDR (and never 0.0.0.0/0) may reach Postgres or Redis"
  }

  assert {
    condition     = length(aws_vpc_security_group_egress_rule.worker_any_tcp) == 0
    error_message = "Worker any-port egress must be opt-in"
  }
}

run "subnets_and_nat" {
  command = plan

  assert {
    condition = alltrue(concat(
      [for s in aws_subnet.public : s.map_public_ip_on_launch == false],
      [for s in aws_subnet.app : s.map_public_ip_on_launch == false],
      [for s in aws_subnet.data : s.map_public_ip_on_launch == false],
    ))
    error_message = "No subnet may auto-assign public IPs"
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 2 && length(aws_route.app_default) == 3
    error_message = "2 NATs serving 3 app subnets expected"
  }

  assert {
    condition = (
      aws_subnet.app[0].cidr_block == "10.20.16.0/20" &&
      aws_subnet.data[0].cidr_block == "10.20.10.0/24" &&
      aws_subnet.public[0].cidr_block == "10.20.0.0/24"
    )
    error_message = "Subnet layout changed"
  }
}

run "flow_logs_are_reject_only_and_private" {
  command = plan

  assert {
    condition     = length(aws_flow_log.reject) == 1 && aws_flow_log.reject[0].traffic_type == "REJECT"
    error_message = "A REJECT-only flow log is expected"
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.flow_logs[0].block_public_acls &&
      aws_s3_bucket_public_access_block.flow_logs[0].block_public_policy &&
      aws_s3_bucket_public_access_block.flow_logs[0].ignore_public_acls &&
      aws_s3_bucket_public_access_block.flow_logs[0].restrict_public_buckets
    )
    error_message = "Flow log bucket must block all public access"
  }

  assert {
    condition     = one([for r in aws_s3_bucket_lifecycle_configuration.flow_logs[0].rule : r.expiration[0].days]) == 90
    error_message = "Flow logs must expire (default 90 days)"
  }
}

run "flow_logs_can_be_disabled" {
  command = plan

  variables {
    enable_flow_logs = false
  }

  assert {
    condition     = length(aws_flow_log.reject) == 0 && length(aws_s3_bucket.flow_logs) == 0
    error_message = "enable_flow_logs=false must create nothing"
  }
}

run "rejects_non_slash16" {
  command = plan

  variables {
    vpc_cidr = "10.20.0.0/20"
  }

  expect_failures = [var.vpc_cidr]
}

# ── T15: interface endpoints ─────────────────────────────────────────────────
run "interface_endpoints_are_off_by_default" {
  command = plan

  assert {
    condition     = length(aws_vpc_endpoint.interface) == 0 && length(aws_security_group.endpoints) == 0
    error_message = "Interface endpoints are billed per AZ-hour: they must be an explicit opt-in"
  }

  assert {
    condition     = aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway"
    error_message = "The S3 gateway endpoint (free) stays regardless"
  }
}

run "interface_endpoints_cover_the_plan_list" {
  command = plan

  variables {
    enable_interface_endpoints = true
  }

  assert {
    condition     = toset(keys(aws_vpc_endpoint.interface)) == toset(["secretsmanager", "kms", "ecr.api", "ecr.dkr", "logs", "sqs", "email", "sts"])
    error_message = "Plan T15 lists Secrets Manager, KMS, ECR (api + dkr), CloudWatch Logs, SQS, SES and STS"
  }

  assert {
    condition = alltrue([
      for k, e in aws_vpc_endpoint.interface :
      e.vpc_endpoint_type == "Interface" && e.private_dns_enabled == true && e.service_name == "com.amazonaws.${var.region}.${k}"
    ])
    error_message = "Every endpoint must be an Interface endpoint with private DNS, named for this region"
  }

  # subnet_ids and security_group_ids are references to resources created in the
  # same plan, so they are unknown here; the source wires them to the app tier
  # (interface_endpoints.tf) and the SG rules are asserted in the next run.
}

run "interface_endpoints_accept_only_the_tasks" {
  command = plan

  variables {
    enable_interface_endpoints = true
  }

  assert {
    condition = alltrue([
      for r in aws_vpc_security_group_ingress_rule.endpoints_from_tasks :
      r.cidr_ipv4 == null && r.cidr_ipv6 == null && r.from_port == 443 && r.to_port == 443 && r.ip_protocol == "tcp"
    ])
    error_message = "Endpoints must accept 443 from task security groups by reference, never from a CIDR"
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.endpoints_from_tasks) == 2
    error_message = "API and worker tasks are the only callers"
  }
}

run "interface_endpoint_policy_pins_the_account" {
  command = plan

  variables {
    enable_interface_endpoints = true
  }

  assert {
    condition = (
      one([for c in one(data.aws_iam_policy_document.endpoint[0].statement).condition : c.variable]) == "aws:PrincipalAccount" &&
      one([for c in one(data.aws_iam_policy_document.endpoint[0].statement).condition : c.test]) == "StringEquals" &&
      one([for c in one(data.aws_iam_policy_document.endpoint[0].statement).condition : toset(c.values)]) == toset(["123456789012"])
    )
    error_message = "The endpoint policy must restrict callers to the stack's own account"
  }
}

run "interface_endpoint_policy_can_be_dropped_deliberately" {
  command = plan

  variables {
    enable_interface_endpoints              = true
    restrict_interface_endpoints_to_account = false
  }

  assert {
    condition     = length(data.aws_iam_policy_document.endpoint) == 0
    error_message = "Dropping the restriction must produce no policy document (the AWS default full-access policy applies)"
  }
}

run "interface_endpoint_services_are_an_allow_list" {
  command = plan

  variables {
    enable_interface_endpoints  = true
    interface_endpoint_services = ["secretsmanager", "s3"]
  }

  expect_failures = [var.interface_endpoint_services]
}

run "interface_endpoint_services_can_be_trimmed" {
  command = plan

  variables {
    enable_interface_endpoints  = true
    interface_endpoint_services = ["ecr.api", "ecr.dkr", "logs"]
  }

  assert {
    condition     = toset(output.interface_endpoint_services) == toset(["ecr.api", "ecr.dkr", "logs"])
    error_message = "A trimmed list must produce exactly those endpoints"
  }
}
