variable "name" {
  description = "Resource name prefix, e.g. zt-production"
  type        = string
}

variable "region" {
  description = "AWS region (used for the S3 gateway endpoint service name)"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR; must be a /16 for the subnet math"
  type        = string

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && endswith(var.vpc_cidr, "/16")
    error_message = "vpc_cidr must be a valid /16."
  }
}

variable "availability_zone_ids" {
  description = "AZ IDs (not names), e.g. [\"mec1-az1\",\"mec1-az2\",\"mec1-az3\"]"
  type        = list(string)

  validation {
    condition     = length(var.availability_zone_ids) >= 2 && length(var.availability_zone_ids) <= 3
    error_message = "Use 2 or 3 AZs."
  }
}

variable "nat_gateway_count" {
  description = "Number of NAT gateways (1 = staging, 2 = production)"
  type        = number

  validation {
    condition     = var.nat_gateway_count >= 1 && var.nat_gateway_count <= 3
    error_message = "nat_gateway_count must be 1-3."
  }
}

variable "api_container_port" {
  description = "Port the API container listens on"
  type        = number
  default     = 3000
}

variable "allow_worker_egress_any_port" {
  description = "Allow worker egress to any TCP port (tenant integrations on non-443 ports)"
  type        = bool
  default     = false
}

variable "enable_flow_logs" {
  description = "REJECT-only VPC Flow Logs to a private S3 bucket (forensics for denied connections)"
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  description = "Flow log retention in S3 (IPs and ports only, no payload)"
  type        = number
  default     = 90
}

variable "enable_interface_endpoints" {
  description = "Residency plan T15: PrivateLink interface endpoints so the tasks' AWS API calls (image pull, secrets, logs, mail, queues) stay on the AWS network instead of leaving through NAT. Off by default: each endpoint is billed per AZ-hour (infra/docs/COST-MODEL.md)."
  type        = bool
  default     = false
}

variable "interface_endpoint_services" {
  description = "Endpoint service suffixes (com.amazonaws.<region>.<suffix>). Defaults to the plan's T15 list; the evidence for each is in infra/docs/COST-MODEL.md. 'email' (SES API) is unverified for a target region until the Launch Readiness Gate lists it."
  type        = list(string)
  default     = ["secretsmanager", "kms", "ecr.api", "ecr.dkr", "logs", "sqs", "email", "sts"]

  validation {
    condition     = alltrue([for s in var.interface_endpoint_services : contains(["secretsmanager", "kms", "ecr.api", "ecr.dkr", "logs", "sqs", "email", "sts"], s)])
    error_message = "interface_endpoint_services may only contain: secretsmanager, kms, ecr.api, ecr.dkr, logs, sqs, email, sts. Add a service here deliberately, with its evidence."
  }

  validation {
    condition     = length(distinct(var.interface_endpoint_services)) == length(var.interface_endpoint_services)
    error_message = "interface_endpoint_services must not contain duplicates."
  }
}

variable "restrict_interface_endpoints_to_account" {
  description = "Attach an endpoint policy that only lets principals of THIS account use the endpoints (a data-perimeter control: the VPC cannot be used to reach another account's secrets, queues or repositories). Not proven against a live task start until the staging apply; set false only to unblock a failing deploy, then fix the cause."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
