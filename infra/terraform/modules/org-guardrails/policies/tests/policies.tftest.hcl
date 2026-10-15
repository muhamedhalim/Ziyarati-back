# SCP documents for the data boundary. No provider, no AWS account.
#   terraform -chdir=infra/terraform/modules/org-guardrails/policies init -backend=false
#   terraform -chdir=infra/terraform/modules/org-guardrails/policies test
#
# Structure and limits are asserted here; what the documents DO to a request is
# evaluated by infra/scripts/tests/scp-semantics.test.cjs.

variables {
  # TEST FIXTURE ONLY — this is not an approval of any hosting location.
  approved_regions            = ["me-central-1"]
  audit_exempt_principal_arns = ["arn:aws:iam::123456789012:role/zt-production-tf-apply"]
}

run "documents_fit_the_scp_limits" {
  command = plan

  assert {
    condition     = alltrue([for name, n in output.document_sizes : n <= 5120])
    error_message = "An SCP is limited to 5,120 characters (AWS Organizations quota)."
  }

  assert {
    condition     = alltrue([for name, n in output.document_sizes : n <= 4400])
    error_message = "An SCP is within ~15% of the 5,120-character limit; split it before adding more."
  }

  assert {
    condition     = length(output.documents) == 3
    error_message = "Three policies: with FullAWSAccess that is 4 of the 5 attachments a target may carry."
  }
}

run "every_statement_is_a_deny" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for name, doc in output.documents : [for s in jsondecode(doc).Statement : s.Effect == "Deny"]
    ]))
    error_message = "Guardrails only deny. An Allow in an SCP is a different (and unreviewed) kind of control."
  }

  assert {
    condition = alltrue(flatten([
      for name, doc in output.documents : [for s in jsondecode(doc).Statement : contains(keys(s), "Sid")]
    ]))
    error_message = "Every statement needs a Sid so a denied request can be traced to a rule."
  }
}

run "region_boundary_denies_unapproved_regions" {
  command = plan

  assert {
    condition = (
      jsondecode(output.documents["region-boundary"]).Statement[0].Sid == "DenyOutsideApprovedRegions" &&
      toset(jsondecode(output.documents["region-boundary"]).Statement[0].Condition.StringNotEquals["aws:RequestedRegion"]) == toset(["me-central-1"])
    )
    error_message = "Only the approved region may pass the region deny (us-east-1 included: no exception exists)"
  }

  assert {
    condition     = toset(output.allowed_regions) == toset(["me-central-1"])
    error_message = "allowed_regions must be exactly the approved regions"
  }

  assert {
    condition = (
      contains(jsondecode(output.documents["region-boundary"]).Statement[0].NotAction, "iam:*") &&
      contains(jsondecode(output.documents["region-boundary"]).Statement[0].NotAction, "sts:*") &&
      contains(jsondecode(output.documents["region-boundary"]).Statement[0].NotAction, "organizations:*")
    )
    error_message = "IAM, STS and Organizations are global and must be exempt or the account locks itself out"
  }

  assert {
    condition = !anytrue([
      for a in jsondecode(output.documents["region-boundary"]).Statement[0].NotAction :
      contains(["kms:*", "acm:*", "s3:*", "rds:*", "ec2:*", "cloudfront:*", "*"], a)
    ])
    error_message = "A regional or unused service must never be exempted from the region deny"
  }
}

run "no_us_east_1_exception_statement_exists" {
  command = plan

  assert {
    condition     = length(jsondecode(output.documents["region-boundary"]).Statement) == 2
    error_message = "region-boundary holds exactly the region deny and the opt-in-region deny: no exception statement"
  }

  assert {
    condition     = !strcontains(output.documents["region-boundary"], "HealthCheck")
    error_message = "The us-east-1 health-check exception was removed (alerts live only in the approved region)"
  }
}

run "exception_not_duplicated_when_us_east_1_is_approved" {
  command = plan

  variables {
    approved_regions = ["us-east-1"]
  }

  assert {
    condition     = toset(output.allowed_regions) == toset(["us-east-1"])
    error_message = "An approved us-east-1 behaves like any approved region"
  }

  assert {
    condition     = length(jsondecode(output.documents["region-boundary"]).Statement) == 2
    error_message = "No exception statement when us-east-1 is itself approved"
  }
}

run "data_copy_guard_covers_the_plan_list" {
  command = plan

  assert {
    condition = alltrue([
      for a in [
        "s3:PutReplicationConfiguration",
        "rds:CreateDBInstanceReadReplica",
        "rds:StartDBInstanceAutomatedBackupsReplication",
        "kms:ReplicateKey",
        "secretsmanager:ReplicateSecretToRegions",
        "ecr:PutReplicationConfiguration",
        "elasticache:CreateGlobalReplicationGroup",
        "logs:PutDestination",
        "bedrock:*",
        "cloudfront:Create*",
      ] : contains(jsondecode(output.documents["data-copy-guard"]).Statement[0].Action, a)
    ])
    error_message = "The data-copy guard must deny every feature named in residency plan T14(b)"
  }

  assert {
    condition = (
      contains([for s in jsondecode(output.documents["data-copy-guard"]).Statement : s.Sid], "DenyMultiRegionKeys") &&
      one([for s in jsondecode(output.documents["data-copy-guard"]).Statement : s if s.Sid == "DenyMultiRegionKeys"]).Condition.Bool["kms:MultiRegion"] == "true"
    )
    error_message = "kms:CreateKey with MultiRegion=true must be denied"
  }

  assert {
    condition = !contains(
      jsondecode(output.documents["data-copy-guard"]).Statement[0].Action, "rds:CopyDBSnapshot"
    )
    error_message = "rds:CopyDBSnapshot is started from the destination region and is covered by the region deny; denying it by action would break in-region backups"
  }
}

run "backup_copy_is_denied_everywhere_until_a_vault_is_approved" {
  command = plan

  assert {
    condition = (
      one([for s in jsondecode(output.documents["data-copy-guard"]).Statement : s if s.Sid == "DenyBackupCopyAnywhere"]).Resource == "*"
    )
    error_message = "With no approved vault every backup copy is denied"
  }
}

run "backup_copy_into_approved_vault_only" {
  command = plan

  variables {
    approved_backup_vault_arns = ["arn:aws:backup:me-central-1:123456789012:backup-vault:zt-prod-dr"]
  }

  assert {
    condition = (
      one([for s in jsondecode(output.documents["data-copy-guard"]).Statement : s if s.Sid == "DenyBackupCopyToUnapprovedVaults"]).NotResource ==
      ["arn:aws:backup:me-central-1:123456789012:backup-vault:zt-prod-dr"]
    )
    error_message = "Copy must be denied into every vault except the approved ones"
  }

  assert {
    condition = !contains(
      [for s in jsondecode(output.documents["data-copy-guard"]).Statement : s.Sid], "DenyBackupCopyAnywhere"
    )
    error_message = "The blanket deny must not remain once a vault is approved"
  }
}

run "a_data_copy_action_can_be_lifted_deliberately" {
  command = plan

  variables {
    lifted_data_copy_actions = ["rds:CreateDBInstanceReadReplica"]
  }

  assert {
    condition = (
      !contains(jsondecode(output.documents["data-copy-guard"]).Statement[0].Action, "rds:CreateDBInstanceReadReplica") &&
      contains(jsondecode(output.documents["data-copy-guard"]).Statement[0].Action, "s3:PutReplicationConfiguration")
    )
    error_message = "Only the lifted action leaves the deny list"
  }
}

run "lifting_an_unknown_action_is_rejected" {
  command = plan

  variables {
    lifted_data_copy_actions = ["s3:GetObject"]
  }

  expect_failures = [var.lifted_data_copy_actions]
}

run "audit_guard_exempts_only_the_named_principals" {
  command = plan

  assert {
    condition = (
      one([for s in jsondecode(output.documents["audit-guard"]).Statement : s if s.Sid == "DenyDisablingAuditAndDetection"]).Condition.ArnNotLike["aws:PrincipalARN"] ==
      ["arn:aws:iam::123456789012:role/zt-production-tf-apply"]
    )
    error_message = "The audit guard must exempt exactly the listed principals"
  }

  assert {
    condition = alltrue([
      for a in ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "guardduty:DeleteDetector", "access-analyzer:DeleteAnalyzer"] :
      contains(one([for s in jsondecode(output.documents["audit-guard"]).Statement : s if s.Sid == "DenyDisablingAuditAndDetection"]).Action, a)
    ])
    error_message = "Disabling the trail or detectors must be denied"
  }

  assert {
    condition = (
      one([for s in jsondecode(output.documents["audit-guard"]).Statement : s if s.Sid == "DenyLeavingTheOrganization"]).Action == ["organizations:LeaveOrganization"] &&
      !contains(keys(one([for s in jsondecode(output.documents["audit-guard"]).Statement : s if s.Sid == "DenyLeavingTheOrganization"])), "Condition")
    )
    error_message = "Leaving the organisation is denied for everyone"
  }
}

run "empty_approved_regions_is_rejected" {
  command = plan

  variables {
    approved_regions = []
  }

  expect_failures = [var.approved_regions]
}

run "region_codes_are_validated" {
  command = plan

  variables {
    approved_regions = ["saudi"]
  }

  expect_failures = [var.approved_regions]
}

run "audit_exemption_is_required" {
  command = plan

  variables {
    audit_exempt_principal_arns = []
  }

  expect_failures = [var.audit_exempt_principal_arns]
}

run "a_bare_wildcard_principal_is_rejected" {
  command = plan

  variables {
    audit_exempt_principal_arns = ["*"]
  }

  expect_failures = [var.audit_exempt_principal_arns]
}

run "a_non_vault_arn_is_rejected" {
  command = plan

  variables {
    approved_backup_vault_arns = ["arn:aws:s3:::some-bucket"]
  }

  expect_failures = [var.approved_backup_vault_arns]
}

run "extra_global_actions_cannot_be_a_wildcard" {
  command = plan

  variables {
    extra_global_service_actions = ["*:*"]
  }

  expect_failures = [var.extra_global_service_actions]
}
