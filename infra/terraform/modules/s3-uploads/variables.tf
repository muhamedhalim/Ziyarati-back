variable "name" {
  description = "Resource name prefix"
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for SSE-KMS"
  type        = string
}

variable "noncurrent_version_retention_days" {
  description = "Days a deleted/overwritten object version stays recoverable"
  type        = number
  default     = 30
}

variable "cors_allowed_origins" {
  description = "Origins allowed to GET presigned URLs cross-origin (empty = no CORS config)"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
