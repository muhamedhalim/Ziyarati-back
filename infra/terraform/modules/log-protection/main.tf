# CloudWatch Logs data-protection policy (residency plan T16).
#
# A BACKSTOP behind the application's own scrubbing (src/common/logging,
# src/common/utils/log-scrubber.util.ts): if an identifier reaches a log group
# anyway, it is masked when the log is read and counted in the sensitive-data
# metrics. It does not replace scrubbing at write time and it is not a statement
# that logs are clean (plan section 5: D8 is treated as D2/D4 until sampled).
#
# Limits that are real, so they are not claimed away:
#   * masking applies to events ingested AFTER the policy exists;
#   * a principal with logs:Unmask sees the original;
#   * the Saudi identifiers are custom regexes (no managed identifier is relied
#     on for Saudi numbers); the national-ID pattern also matches 10-digit Unix
#     epoch seconds, which is masked noise in logs, not a leak;
#   * the data-identifier ARN and the policy schema are written from the AWS
#     documentation without an AWS lookup (OV until the first apply).

locals {
  default_custom_identifiers = {
    # +966 5xxxxxxxx, 00966 5xxxxxxxx, 05xxxxxxxx, 5xxxxxxxx (spaces / dashes allowed between digits)
    SaudiMobileNumber = "(?:\\+966|00966|0)?[ -]?5([ -]?[0-9]){8}"
    # National ID / Iqama: ten digits starting with 1 or 2
    SaudiNationalIdOrIqama = "\\b[12][0-9]{9}\\b"
    # JWT-shaped bearer values
    JwtToken = "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"
    # Pre-signed URL signature
    PresignedUrlSignature = "X-Amz-Signature=[0-9a-fA-F]{64}"
  }
  custom_identifiers = merge(local.default_custom_identifiers, var.extra_custom_identifiers)

  managed_identifiers = [
    "arn:aws:dataprotection::aws:data-identifier/EmailAddress",
  ]
  identifier_refs = concat(local.managed_identifiers, sort(keys(local.custom_identifiers)))

  policy_document = jsonencode({
    Name        = "ziyarati-data-protection"
    Description = "Backstop: mask identifiers and credentials that reach a log group"
    Version     = "2021-06-01"
    Configuration = {
      CustomDataIdentifier = [for n in sort(keys(local.custom_identifiers)) : { Name = n, Regex = local.custom_identifiers[n] }]
    }
    Statement = [
      {
        Sid            = "audit"
        DataIdentifier = local.identifier_refs
        Operation      = { Audit = { FindingsDestination = {} } }
      },
      {
        Sid            = "redact"
        DataIdentifier = local.identifier_refs
        Operation      = { Deidentify = { MaskConfig = {} } }
      },
    ]
  })
}

resource "aws_cloudwatch_log_data_protection_policy" "this" {
  for_each        = var.log_groups
  log_group_name  = each.value
  policy_document = local.policy_document
}
