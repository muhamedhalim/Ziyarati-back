# Residency plan T16. Mocked provider: no account needed.
#   terraform -chdir=infra/terraform/modules/log-protection init -backend=false
#   terraform -chdir=infra/terraform/modules/log-protection test

mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  log_groups = {
    api    = "/ziyaratech/test/api"
    worker = "/ziyaratech/test/worker"
  }
}

run "every_group_carries_the_policy_with_audit_and_mask" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_log_data_protection_policy.this) == 2
    error_message = "One data-protection policy per log group"
  }

  assert {
    condition     = length(jsondecode(output.policy_document).Statement) == 2
    error_message = "The policy must have exactly one audit and one mask statement"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(output.policy_document).Statement :
      contains(s.DataIdentifier, "arn:aws:dataprotection::aws:data-identifier/EmailAddress") &&
      contains(s.DataIdentifier, "SaudiMobileNumber") &&
      contains(s.DataIdentifier, "SaudiNationalIdOrIqama") &&
      contains(s.DataIdentifier, "JwtToken") &&
      contains(s.DataIdentifier, "PresignedUrlSignature")
    ])
    error_message = "Both statements must cover e-mail, Saudi mobile, national ID, JWT and pre-signed signatures"
  }

  assert {
    condition     = length(output.policy_document) < 30720
    error_message = "Data-protection policy documents are limited to 30,720 characters"
  }
}

# The regexes are the part that can silently fail to match. RE2 is the subset
# kept, so Terraform's own regex() exercises them.
run "regexes_match_what_they_claim_and_nothing_ordinary" {
  command = plan

  assert {
    condition = alltrue([
      for s in ["+966501234567", "00966501234567", "0501234567", "501234567", "+966 50 123 4567"] :
      can(regex(output.custom_identifiers.SaudiMobileNumber, s))
    ])
    error_message = "Saudi mobile pattern must match the common written forms"
  }

  assert {
    condition = alltrue([
      for s in ["ZT-2026-0001", "appointment at 10:30", "order_id=7788"] :
      !can(regex(output.custom_identifiers.SaudiMobileNumber, s))
    ])
    error_message = "Saudi mobile pattern must not match ordinary identifiers"
  }

  assert {
    condition = alltrue([
      can(regex(output.custom_identifiers.SaudiNationalIdOrIqama, "id 1087654321 end")),
      can(regex(output.custom_identifiers.SaudiNationalIdOrIqama, "2087654321")),
      !can(regex(output.custom_identifiers.SaudiNationalIdOrIqama, "3087654321")),
      !can(regex(output.custom_identifiers.SaudiNationalIdOrIqama, "108765432")),
      !can(regex(output.custom_identifiers.SaudiNationalIdOrIqama, "10876543210")),
    ])
    error_message = "National ID pattern: ten digits starting 1 or 2, on word boundaries"
  }

  assert {
    condition = alltrue([
      can(regex(output.custom_identifiers.JwtToken, "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop")),
      !can(regex(output.custom_identifiers.JwtToken, "eyJshort.eyJshort.short")),
      can(regex(output.custom_identifiers.PresignedUrlSignature, "X-Amz-Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")),
    ])
    error_message = "JWT and pre-signed signature patterns"
  }

  # LSA-02/LSA-05 additions (synthetic values only).
  assert {
    condition = alltrue([
      can(regex(output.custom_identifiers.OpenAiApiKey, "key sk-proj-CANARYopenaiKEY1234567890 rejected")),
      can(regex(output.custom_identifiers.TapSecretKey, "sk_live_CANARYtapKEY12345")),
      can(regex(output.custom_identifiers.AwsAccessKeyId, "AKIACANARYAWSKEY1234")),
      can(regex(output.custom_identifiers.EgyptianNationalId, "id 29901011099118 end")),
      !can(regex(output.custom_identifiers.EgyptianNationalId, "49901011099118")),
      !can(regex(output.custom_identifiers.OpenAiApiKey, "task-runner")),
      !can(regex(output.custom_identifiers.TapSecretKey, "sk_live_short")),
    ])
    error_message = "Provider key and Egyptian ID patterns"
  }
}

run "extra_identifier_names_are_validated" {
  command = plan

  variables {
    extra_custom_identifiers = { "bad name" = "x" }
  }

  expect_failures = [var.extra_custom_identifiers]
}
