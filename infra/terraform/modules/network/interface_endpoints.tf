# Residency plan T15 — interface (PrivateLink) endpoints.
#
# Without them the tasks reach AWS APIs through the NAT gateways, i.e. over the
# public endpoints. With them, calls to the services below resolve (private DNS)
# to ENIs in the app subnets and never leave the AWS network. The data tier needs
# none: RDS and Valkey call no AWS API.
#
# Not a residency control by itself: the traffic was already addressed to the
# same region. It removes an internet path from the control plane and lets the
# endpoint policy pin the calls to this account. OpenAI, Meta, Tap and tenant
# integrations still use NAT.

locals {
  interface_endpoints = var.enable_interface_endpoints ? toset(var.interface_endpoint_services) : toset([])
}

# data.aws_caller_identity.current is declared in flow_logs.tf.

resource "aws_security_group" "endpoints" {
  count       = var.enable_interface_endpoints ? 1 : 0
  name        = "${var.name}-vpc-endpoints"
  description = "Interface endpoints: HTTPS from API and worker tasks only"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-vpc-endpoints" })
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_tasks" {
  for_each                     = var.enable_interface_endpoints ? { api = aws_security_group.api.id, worker = aws_security_group.worker.id } : {}
  security_group_id            = aws_security_group.endpoints[0].id
  description                  = "HTTPS from ${each.key} tasks"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

data "aws_iam_policy_document" "endpoint" {
  count = var.enable_interface_endpoints && var.restrict_interface_endpoints_to_account ? 1 : 0

  statement {
    sid       = "OnlyThisAccount"
    effect    = "Allow"
    actions   = ["*"]
    resources = ["*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoints

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.app[*].id
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true
  policy              = var.restrict_interface_endpoints_to_account ? data.aws_iam_policy_document.endpoint[0].json : null

  tags = merge(local.tags, { Name = "${var.name}-${replace(each.value, ".", "-")}" })
}
