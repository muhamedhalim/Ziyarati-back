output "configuration_set_name" {
  value = aws_sesv2_configuration_set.this.configuration_set_name
}

output "identity_arn" {
  value = aws_sesv2_email_identity.domain.arn
}

output "configuration_set_arn" {
  value = aws_sesv2_configuration_set.this.arn
}

output "feedback_queue_url" {
  value = aws_sqs_queue.feedback.id
}

output "feedback_queue_arn" {
  value = aws_sqs_queue.feedback.arn
}

output "feedback_dlq_name" {
  value = aws_sqs_queue.feedback_dlq.name
}

output "dns_records" {
  description = "Records to create in Vercel DNS"
  value = concat(
    [for t in aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens : {
      name  = "${t}._domainkey.${var.domain}"
      type  = "CNAME"
      value = "${t}.dkim.amazonses.com"
    }],
    [
      {
        name  = local.mail_from_domain
        type  = "MX"
        value = "10 feedback-smtp.${var.region}.amazonses.com"
      },
      {
        name  = local.mail_from_domain
        type  = "TXT"
        value = "v=spf1 include:amazonses.com ~all"
      },
      {
        name  = "_dmarc.${var.domain}"
        type  = "TXT"
        value = "v=DMARC1; p=none; rua=mailto:${var.dmarc_rua}; fo=1"
      },
    ],
  )
}

output "feedback_queue_name" {
  value = aws_sqs_queue.feedback.name
}
