variable "name" {
  description = "Resource name prefix"
  type        = string
}

variable "api_domain" {
  description = "Public API hostname, e.g. api.ziyaratech.com"
  type        = string
}

variable "vpc_id" {
  description = "VPC id"
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets for the ALB"
  type        = list(string)
}

variable "alb_security_group_id" {
  description = "ALB security group"
  type        = string
}

variable "container_port" {
  description = "API container port"
  type        = number
  default     = 3000
}

variable "idle_timeout" {
  description = "ALB idle timeout (s). Socket.IO pings every 25 s; synchronous exports can be slow."
  type        = number
  default     = 120
}

variable "deregistration_delay" {
  description = "Seconds to drain a task on deploy (AI turns take ~7 s)"
  type        = number
  default     = 30
}

variable "deletion_protection" {
  description = "ALB deletion protection"
  type        = bool
  default     = true
}

variable "access_log_retention_days" {
  description = "ALB access log retention"
  type        = number
  default     = 30
}

variable "certificate_validation_timeout" {
  description = "How long apply waits for the operator to add the ACM CNAME in Vercel DNS"
  type        = string
  default     = "2h"
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
