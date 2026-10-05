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
