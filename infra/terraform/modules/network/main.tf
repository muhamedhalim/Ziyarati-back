# ZiyaraTech network: one VPC, three subnet tiers across AZs selected by
# AZ *ID* (the mapping from AZ name to physical AZ differs per account, and the
# March 2026 me-central-1 incident was reported by AZ ID).
#
#   public : ALB + NAT gateways only (route 0.0.0.0/0 → IGW)
#   app    : ECS tasks, no public IPs (route 0.0.0.0/0 → NAT)
#   data   : RDS + ElastiCache, NO default route at all — the data tier cannot
#            reach the internet even if a security group is misconfigured.

locals {
  az_count = length(var.availability_zone_ids)
  tags     = merge(var.tags, { Component = "network" })

  # /16 → public /24s at .0-.2, data /24s at .10-.12, app /20s from .16.0
  public_cidrs = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 8, i)]
  data_cidrs   = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 8, 10 + i)]
  app_cidrs    = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 4, 1 + i)]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${var.name}-vpc" })
}

# CIS: the default SG must allow nothing. Nothing in this stack uses it.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-default-deny" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.this.id
  availability_zone_id    = var.availability_zone_ids[count.index]
  cidr_block              = local.public_cidrs[count.index]
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${var.name}-public-${var.availability_zone_ids[count.index]}", Tier = "public" })
}

resource "aws_subnet" "app" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.this.id
  availability_zone_id    = var.availability_zone_ids[count.index]
  map_public_ip_on_launch = false
  cidr_block              = local.app_cidrs[count.index]
  tags                    = merge(local.tags, { Name = "${var.name}-app-${var.availability_zone_ids[count.index]}", Tier = "app" })
}

resource "aws_subnet" "data" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.this.id
  availability_zone_id    = var.availability_zone_ids[count.index]
  map_public_ip_on_launch = false
  cidr_block              = local.data_cidrs[count.index]
  tags                    = merge(local.tags, { Name = "${var.name}-data-${var.availability_zone_ids[count.index]}", Tier = "data" })
}

# ── Public routing ───────────────────────────────────────────────────────────
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ── NAT (egress for OpenAI / Meta / Moyasar / AWS APIs) ─────────────────────
# nat_gateway_count NATs in the first N AZs; app subnet i routes to NAT
# (i mod N). Production uses 2 so one AZ loss cannot stop new tasks pulling
# images or reading secrets; staging uses 1.
resource "aws_eip" "nat" {
  count  = var.nat_gateway_count
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count         = var.nat_gateway_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(local.tags, { Name = "${var.name}-nat-${var.availability_zone_ids[count.index]}" })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "app" {
  count  = local.az_count
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-app-${var.availability_zone_ids[count.index]}" })
}

resource "aws_route" "app_default" {
  count                  = local.az_count
  route_table_id         = aws_route_table.app[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[count.index % var.nat_gateway_count].id
}

resource "aws_route_table_association" "app" {
  count          = local.az_count
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

# Data tier: local routes only (+ the S3 gateway endpoint prefix list below).
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-data-isolated" })
}

resource "aws_route_table_association" "data" {
  count          = local.az_count
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# ── S3 gateway endpoint (free) ───────────────────────────────────────────────
# S3 traffic and ECR image layers (which ECR serves from S3) bypass NAT data
# processing charges.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.app[*].id, [aws_route_table.data.id])
  tags              = merge(local.tags, { Name = "${var.name}-s3-gateway" })
}
