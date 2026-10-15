variable "management_account_id" {
  description = "The organisation's management account (CI/operator: TF_VAR_management_account_id). The provider refuses any other account, so this cannot be applied from a workload account by mistake."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.management_account_id))
    error_message = "management_account_id must be a 12-digit AWS account id."
  }
}

variable "organizations_api_region" {
  description = "Region the provider uses to reach the (global) Organizations API. AWS documents us-east-1 for it; confirm in the current Organizations endpoint list. This is not a hosting location."
  type        = string
}

variable "target_ids" {
  description = "Test OU / account first, organisation root last. EMPTY until the rollout runbook is started."
  type        = list(string)
}

variable "approved_regions" {
  description = "Regions the organisation may use. Must be a superset of every environment's approved_regions (infra/scripts/region-gate.sh checks this). EMPTY until the hosting location is approved in writing."
  type        = list(string)
}

variable "approved_backup_vault_arns" {
  description = "Vaults AWS Backup may copy into. Empty until the DR scenario is approved in writing (L13)."
  type        = list(string)
  default     = []
}

variable "audit_exempt_principal_arns" {
  description = "Roles that may change CloudTrail / GuardDuty / Access Analyzer: the account-baseline apply role and the break-glass role. Written against the ROLE arn (arn:aws:iam::<acct>:role/<name>), not an assumed-role session arn."
  type        = list(string)
}

variable "lifted_data_copy_actions" {
  description = "Deliberate, reviewed exceptions to the data-copy deny list. Empty by default."
  type        = list(string)
  default     = []
}
