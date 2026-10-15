variable "name_prefix" {
  description = "Prefix of the SCP names"
  type        = string
  default     = "zt-boundary"
}

variable "target_ids" {
  description = "Where the policies attach: member-account IDs or OU IDs. Attaching to the organisation root (r-xxxx) is allowed but must come last, after the same policies ran on a test OU. SCPs never affect the management account."
  type        = list(string)

  validation {
    condition     = length(var.target_ids) > 0
    error_message = "target_ids is empty: nothing would be attached. List the test OU or account first."
  }

  validation {
    condition     = alltrue([for t in var.target_ids : can(regex("^(r-[0-9a-z]{4,32}|ou-[0-9a-z]{4,32}-[0-9a-z]{8,32}|[0-9]{12})$", t))])
    error_message = "target_ids must be a root (r-...), an OU (ou-...) or a 12-digit account ID."
  }
}

variable "approved_regions" {
  description = "See policies/variables.tf. There is no default: the hosting location is a written legal decision."
  type        = list(string)

  validation {
    condition     = length(var.approved_regions) > 0
    error_message = "approved_regions is empty: list the regions approved in writing (no region is approved by default)."
  }
}

variable "approved_backup_vault_arns" {
  description = "See policies/variables.tf."
  type        = list(string)
  default     = []
}

variable "audit_exempt_principal_arns" {
  description = "See policies/variables.tf."
  type        = list(string)
}

variable "lifted_data_copy_actions" {
  description = "See policies/variables.tf."
  type        = list(string)
  default     = []
}

variable "extra_global_service_actions" {
  description = "See policies/variables.tf."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
