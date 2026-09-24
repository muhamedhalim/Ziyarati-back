variable "repository_name" {
  description = "ECR repository name"
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for image encryption"
  type        = string
}

variable "keep_images" {
  description = "Number of images retained (rollback window)"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
