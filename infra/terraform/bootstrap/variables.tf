variable "environment" {
  description = "staging | production (one account per environment)"
  type        = string
}

variable "account_id" {
  description = "Target account; the provider refuses any other"
  type        = string
}

variable "aws_region" {
  type    = string
  default = "me-central-1"
}

variable "github_repository" {
  type    = string
  default = "muhamedhalim/Ziyarati-back"
}
