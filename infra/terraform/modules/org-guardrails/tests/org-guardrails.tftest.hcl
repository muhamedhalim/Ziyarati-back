# Organisation guardrails with a mocked AWS provider (no account, no Organization).
#   terraform -chdir=infra/terraform/modules/org-guardrails init -backend=false
#   terraform -chdir=infra/terraform/modules/org-guardrails test

mock_provider "aws" {
  mock_data "aws_organizations_organization" {
    defaults = {
      enabled_policy_types = ["SERVICE_CONTROL_POLICY", "TAG_POLICY"]
    }
  }
}

variables {
  # TEST FIXTURE ONLY — this is not an approval of any hosting location.
  approved_regions            = ["me-central-1"]
  audit_exempt_principal_arns = ["arn:aws:iam::123456789012:role/zt-production-tf-apply"]
  target_ids                  = ["ou-ab12-cdef3456"]
}

run "three_service_control_policies_are_created_and_attached" {
  command = plan

  assert {
    condition     = length(aws_organizations_policy.this) == 3
    error_message = "Three SCPs expected (region boundary, data-copy guard, audit guard)"
  }

  assert {
    condition     = alltrue([for p in aws_organizations_policy.this : p.type == "SERVICE_CONTROL_POLICY"])
    error_message = "Every policy must be a service control policy"
  }

  assert {
    condition     = length(aws_organizations_policy_attachment.this) == 3
    error_message = "Each policy attaches once to the single target"
  }

  assert {
    condition     = alltrue([for a in aws_organizations_policy_attachment.this : a.target_id == "ou-ab12-cdef3456"])
    error_message = "Attachments must point at the configured target"
  }
}

run "attachments_multiply_over_targets" {
  command = plan

  variables {
    target_ids = ["ou-ab12-cdef3456", "123456789012"]
  }

  assert {
    condition     = length(aws_organizations_policy_attachment.this) == 6
    error_message = "3 policies x 2 targets"
  }
}

run "policy_content_comes_from_the_policy_module" {
  command = plan

  assert {
    condition     = jsondecode(aws_organizations_policy.this["region-boundary"].content).Statement[0].Sid == "DenyOutsideApprovedRegions"
    error_message = "The region boundary document must be attached as rendered"
  }

  assert {
    condition = alltrue([
      for name, p in aws_organizations_policy.this : length(p.content) <= 5120
    ])
    error_message = "Every SCP must fit the 5,120-character quota"
  }
}

run "fails_when_scp_is_not_enabled_for_the_organisation" {
  command = plan

  override_data {
    target = data.aws_organizations_organization.current
    values = {
      enabled_policy_types = ["TAG_POLICY"]
    }
  }

  expect_failures = [aws_organizations_policy.this]
}

run "rejects_empty_targets" {
  command = plan

  variables {
    target_ids = []
  }

  expect_failures = [var.target_ids]
}

run "rejects_malformed_targets" {
  command = plan

  variables {
    target_ids = ["production"]
  }

  expect_failures = [var.target_ids]
}

run "rejects_no_approved_region" {
  command = plan

  variables {
    approved_regions = []
  }

  expect_failures = [var.approved_regions]
}
