variable "environment" {
  description = "staging | production (one account per environment)"
  type        = string
}

variable "account_id" {
  description = "Target account; the provider refuses any other"
  type        = string
}

variable "approved_regions" {
  description = "Regions the state bucket and its key may live in. Empty until the hosting location is approved in writing."
  type        = list(string)
}

variable "aws_region" {
  description = "Region of the state bucket, CMK and OIDC roles' resources. No default: it must be chosen from approved_regions."
  type        = string

  validation {
    condition     = contains(var.approved_regions, var.aws_region)
    error_message = "aws_region is not in approved_regions. Do not add a region without the written hosting-location decision."
  }
}

variable "github_repository" {
  type    = string
  default = "muhamedhalim/Ziyarati-back"
}
