variable "name" {
  type = string
}

variable "oidc_provider_arn" {
  description = "token.actions.githubusercontent.com provider (created by bootstrap/)"
  type        = string
}

variable "github_repository" {
  description = "owner/repo"
  type        = string
}

variable "github_environment" {
  description = "GitHub Environment whose jobs may assume the role"
  type        = string
}

variable "ecr_repository_arn" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "passable_role_arns" {
  description = "Execution + task roles of the app task definitions"
  type        = list(string)
}

variable "migrate_log_group_arn" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
