variable "name" {
  description = "Resource name prefix (also the configuration set name)"
  type        = string
}

variable "region" {
  description = "AWS region (for the MAIL FROM MX record value)"
  type        = string
}

variable "domain" {
  description = "Sending domain, e.g. ziyaratech.com"
  type        = string
}

variable "mail_from_subdomain" {
  description = "Custom MAIL FROM subdomain (SPF alignment)"
  type        = string
  default     = "mail"
}

variable "dmarc_rua" {
  description = "DMARC aggregate report mailbox"
  type        = string
}

variable "tls_policy" {
  description = "REQUIRE (no plaintext delivery) or OPTIONAL"
  type        = string
  default     = "REQUIRE"

  validation {
    condition     = contains(["REQUIRE", "OPTIONAL"], var.tls_policy)
    error_message = "tls_policy must be REQUIRE or OPTIONAL."
  }
}

variable "kms_key_arn" {
  description = "KMS key for SNS/SQS encryption"
  type        = string
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
