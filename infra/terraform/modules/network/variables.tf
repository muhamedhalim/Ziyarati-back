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

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
