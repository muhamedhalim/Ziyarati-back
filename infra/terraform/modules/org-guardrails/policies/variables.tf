variable "approved_regions" {
  description = "Regions the organisation's member accounts may use. This is THE data boundary: it must contain every region of every environment (the region gate checks this) and nothing that has not been approved in writing (residency plan section 24, L1/L2). There is no default on purpose."
  type        = list(string)

  validation {
    condition     = length(var.approved_regions) > 0
    error_message = "approved_regions is empty: an SCP with no approved region would deny everything. List the regions approved in writing."
  }

  validation {
    condition     = alltrue([for r in var.approved_regions : can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", r))])
    error_message = "approved_regions must hold AWS region codes (two letters, a direction, a number: e.g. xx-north-1)."
  }
}

variable "approved_backup_vault_arns" {
  description = "Backup vault ARNs AWS Backup may copy INTO. Empty = no backup copy is allowed anywhere. A backup is patient data: add the DR vault only after the DR scenario is approved in writing (L13)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for a in var.approved_backup_vault_arns : can(regex("^arn:aws[a-z-]*:backup:[a-z0-9-]+:[0-9]{12}:backup-vault:.+$", a))])
    error_message = "approved_backup_vault_arns must be AWS Backup vault ARNs (arn:aws:backup:<region>:<account>:backup-vault:<name>)."
  }
}

variable "audit_exempt_principal_arns" {
  description = "Role ARNs (wildcards allowed) that may change CloudTrail / GuardDuty / Access Analyzer settings, e.g. the Terraform apply role of the account baseline and the break-glass role. Required: without one the account-baseline module could not be maintained. These principals are NOT exempt from the region or data-copy guards."
  type        = list(string)

  validation {
    condition     = length(var.audit_exempt_principal_arns) > 0
    error_message = "At least one exempt principal is required, otherwise the audit guard locks the trail and detectors against everyone, including the team that maintains them."
  }

  validation {
    condition     = alltrue([for a in var.audit_exempt_principal_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9*]{1,12}:(role|user)/.+$", a))])
    error_message = "audit_exempt_principal_arns must be IAM role/user ARNs (wildcards allowed), never a bare *."
  }
}

variable "lifted_data_copy_actions" {
  description = "Exact action names removed from the data-copy deny list as a deliberate, reviewed decision (for example rds:CreateDBInstanceReadReplica once an in-Kingdom second site is approved under L13). Each entry must be a member of the module's catalogue (output data_copy_catalogue)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for a in var.lifted_data_copy_actions : contains(local.data_copy_actions, a)])
    error_message = "lifted_data_copy_actions contains an action that is not in the data-copy catalogue; nothing outside the catalogue is denied here, so there is nothing to lift."
  }
}

variable "extra_global_service_actions" {
  description = "Additional actions exempt from the region deny (global control-plane services only). Every entry widens the boundary; review each one."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for a in var.extra_global_service_actions : can(regex("^[a-z0-9-]+:[A-Za-z0-9*]+$", a)) && a != "*:*"])
    error_message = "extra_global_service_actions must be service:Action patterns, never *:*."
  }
}
