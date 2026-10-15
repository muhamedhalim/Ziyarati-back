# AWS Organizations guardrails for the Saudi data boundary (residency plan T14).
#
# Applied ONCE, from the organisation's management account, in its own root
# (environments/org-guardrails) — never from a workload environment root. It
# creates three service control policies (documents: ./policies) and attaches
# them to the OUs / accounts in target_ids.
#
# WRITTEN AND TESTED, NOT APPLIED. Applying needs an AWS Organization with
# SERVICE_CONTROL_POLICY enabled, an approved region list, and the rollout in
# infra/runbooks/org-guardrails-rollout.md (test OU first: a wrong SCP locks a
# whole account out of its own APIs).

module "policies" {
  source = "./policies"

  approved_regions             = var.approved_regions
  approved_backup_vault_arns   = var.approved_backup_vault_arns
  audit_exempt_principal_arns  = var.audit_exempt_principal_arns
  lifted_data_copy_actions     = var.lifted_data_copy_actions
  extra_global_service_actions = var.extra_global_service_actions
}

data "aws_organizations_organization" "current" {}

locals {
  tags = merge(var.tags, { Component = "org-guardrails", DataClassification = "infrastructure" })

  descriptions = {
    "region-boundary" = "Deny API calls outside the approved regions (global control-plane services exempt)."
    "data-copy-guard" = "Deny replication, replicas, exports, multi-region keys, log shipping, CloudFront, Bedrock and unapproved backup copies."
    "audit-guard"     = "Deny disabling CloudTrail/GuardDuty/Access Analyzer except for named principals, and leaving the organisation."
  }

  attachments = {
    for pair in setproduct(keys(module.policies.documents), var.target_ids) :
    "${pair[0]}/${pair[1]}" => { policy = pair[0], target = pair[1] }
  }
}

resource "aws_organizations_policy" "this" {
  for_each = module.policies.documents

  name        = "${var.name_prefix}-${each.key}"
  description = local.descriptions[each.key]
  type        = "SERVICE_CONTROL_POLICY"
  content     = each.value
  tags        = local.tags

  lifecycle {
    precondition {
      condition     = contains(data.aws_organizations_organization.current.enabled_policy_types, "SERVICE_CONTROL_POLICY")
      error_message = "SERVICE_CONTROL_POLICY is not enabled for this organisation (enable the policy type at the root first), or this is not the management / delegated-administrator account."
    }

    precondition {
      condition     = length(each.value) <= 5120
      error_message = "SCP ${each.key} is ${length(each.value)} characters; the Organizations limit is 5,120."
    }
  }
}

resource "aws_organizations_policy_attachment" "this" {
  for_each = local.attachments

  policy_id = aws_organizations_policy.this[each.value.policy].id
  target_id = each.value.target
}
