variable "log_groups" {
  description = "Log groups to protect: static key => log group name. The KEYS must be known at plan time (they drive for_each); the names may be computed."
  type        = map(string)
}

variable "extra_custom_identifiers" {
  description = "Additional custom data identifiers (name => regex), merged over the defaults. Keep regexes in the RE2 subset (no look-around)."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for n in keys(var.extra_custom_identifiers) : can(regex("^[A-Za-z][A-Za-z0-9]{0,63}$", n))])
    error_message = "Identifier names must be alphanumeric, start with a letter, and be at most 64 characters."
  }
}
