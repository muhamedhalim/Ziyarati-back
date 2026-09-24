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

run "rejects_non_slash16" {
  command = plan

  variables {
    vpc_cidr = "10.20.0.0/20"
  }

  expect_failures = [var.vpc_cidr]
}
