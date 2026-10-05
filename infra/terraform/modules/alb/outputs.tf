output "alb_arn" {
  value = aws_lb.this.arn
}

output "alb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "target_group_arn" {
  value = aws_lb_target_group.api.arn
}

output "target_group_arn_suffix" {
  value = aws_lb_target_group.api.arn_suffix
}

output "https_listener_arn" {
  value = aws_lb_listener.https.arn
}

output "acm_validation_records" {
  description = "CNAME records to create in Vercel DNS for ACM validation"
  value = [for o in aws_acm_certificate.api.domain_validation_options : {
    name  = o.resource_record_name
    type  = o.resource_record_type
    value = o.resource_record_value
  }]
}

output "certificate_arn" {
  description = "ACM certificate on the HTTPS listener (expiry alarm)"
  value       = aws_acm_certificate.api.arn
}

output "xff_mode" {
  description = "ALB X-Forwarded-For processing mode (the app's TRUST_PROXY_HOPS=1 is only safe in \"append\")"
  value       = aws_lb.this.xff_header_processing_mode
}
