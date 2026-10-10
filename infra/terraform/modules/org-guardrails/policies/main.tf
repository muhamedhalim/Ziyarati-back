# Service control policy DOCUMENTS for the Saudi data boundary (residency plan
# T14, sections 13/15). Provider-free on purpose: the JSON is a pure function of
# the inputs, so it can be tested and evaluated without an AWS account
# (infra/scripts/tests/scp-semantics.test.cjs evaluates it against requests).
#
# Three policies, because an SCP is limited to 5,120 characters and to five
# attachments per target:
#
#   region-boundary   deny every region that is not approved (global control-plane
#                     services exempt), the narrow us-east-1 health-check exception,
#                     and enabling an unapproved opt-in region
#   data-copy-guard   deny the features that copy data out on their own
#   audit-guard       deny switching off CloudTrail / GuardDuty / Access Analyzer
#                     and leaving the organisation
#
# What an SCP can NOT do (so it is not claimed): it does not apply to the
# management account or to service-linked roles; it cannot see the region of a
# service-initiated copy (that is why replication APIs are denied by action); it
# cannot constrain SNS subscriptions, EventBridge targets or in-account sharing by
# resource region. infra/runbooks/org-guardrails-rollout.md lists each residual.

locals {
  # ── global control-plane services: exempt from the region deny ────────────
  # Their endpoints are global (us-east-1 or aws-global); denying them by region
  # would lock the account out of IAM/billing/support. They hold identities,
  # policies, names and billing, not patient data (residency plan section 7).
  # Deliberately narrower than AWS's published sample: kms:*, acm:*, config:*,
  # waf*:* and cloudfront:* are NOT exempted wholesale (they are regional, or
  # unused here).
  base_global_service_actions = [
    "iam:*",
    "organizations:*",
    "sts:*",
    "account:*",
    "support:*",
    "trustedadvisor:*",
    "health:*",
    "route53:*",
    "route53domains:*",
    "budgets:*",
    "ce:*",
    "cur:*",
    "aws-portal:*",
    "billing:*",
    "payments:*",
    "tax:*",
    "pricing:*",
    "freetier:*",
    "consolidatedbilling:*",
    "invoicing:*",
    "cloudfront:Get*",
    "cloudfront:List*",
    "cloudfront:Describe*",
    "ec2:DescribeRegions",
    "s3:ListAllMyBuckets",
  ]
  global_service_actions = distinct(concat(local.base_global_service_actions, var.extra_global_service_actions))

  # What modules/monitoring does in us-east-1 for the Route 53 health-check
  # alarm: one metric alarm + one SNS topic with e-mail subscriptions. No Publish,
  # no PutMetricData: the exception cannot carry a payload.
  health_check_exception_actions = [
    "cloudwatch:PutMetricAlarm",
    "cloudwatch:DeleteAlarms",
    "cloudwatch:DescribeAlarms",
    "cloudwatch:GetMetricData",
    "cloudwatch:GetMetricStatistics",
    "cloudwatch:ListMetrics",
    "cloudwatch:ListTagsForResource",
    "cloudwatch:TagResource",
    "cloudwatch:UntagResource",
    "sns:CreateTopic",
    "sns:DeleteTopic",
    "sns:GetTopicAttributes",
    "sns:SetTopicAttributes",
    "sns:ListTagsForResource",
    "sns:TagResource",
    "sns:UntagResource",
    "sns:Subscribe",
    "sns:Unsubscribe",
    "sns:GetSubscriptionAttributes",
    "sns:SetSubscriptionAttributes",
    "sns:ListSubscriptionsByTopic",
  ]

  exception_regions = (
    var.us_east_1_health_check_exception && !contains(var.approved_regions, "us-east-1")
    ? ["us-east-1"]
    : []
  )
  allowed_regions = concat(var.approved_regions, local.exception_regions)

  # ── features that copy data on their own (residency plan section 15) ──────
  # Grouped so a reviewer can read what each line is for. Cross-region RDS
  # snapshot copies and cross-region read replicas are started FROM the
  # destination region, so the region deny already stops them reaching an
  # unapproved region; they are listed here only where a copy between two
  # APPROVED regions should also be a deliberate decision.
  data_copy_catalogue = {
    s3_replication = [
      "s3:PutReplicationConfiguration",
      "s3:ReplicateObject",
      "s3:ReplicateDelete",
      "s3:ReplicateTags",
    ]
    s3_batch_copy = [
      "s3:CreateJob",
    ]
    rds_replicas_exports_sharing = [
      "rds:CreateDBInstanceReadReplica",
      "rds:StartDBInstanceAutomatedBackupsReplication",
      "rds:ModifyDBSnapshotAttribute",
      "rds:ModifyDBClusterSnapshotAttribute",
      "rds:StartExportTask",
    ]
    kms_replica_keys = [
      "kms:ReplicateKey",
      "kms:UpdatePrimaryRegion",
    ]
    secrets_replication = [
      "secretsmanager:ReplicateSecretToRegions",
    ]
    ecr_replication = [
      "ecr:PutReplicationConfiguration",
      "ecr:ReplicateImage",
    ]
    elasticache_global_and_export = [
      "elasticache:CreateGlobalReplicationGroup",
      "elasticache:CopySnapshot",
      "elasticache:CopyServerlessCacheSnapshot",
      "elasticache:ExportServerlessCacheSnapshot",
    ]
    log_shipping = [
      "logs:PutDestination",
      "logs:PutDestinationPolicy",
      "logs:PutSubscriptionFilter",
      "oam:CreateLink",
      "oam:CreateSink",
      "oam:PutSinkPolicy",
    ]
    data_migration_services = [
      "dms:*",
      "datasync:*",
    ]
    generative_ai_services = [
      "bedrock:*",
    ]
    cloudfront_distributions = [
      "cloudfront:Create*",
      "cloudfront:Update*",
      "cloudfront:Copy*",
    ]
  }
  data_copy_actions   = distinct(flatten(values(local.data_copy_catalogue)))
  data_copy_effective = [for a in local.data_copy_actions : a if !contains(var.lifted_data_copy_actions, a)]

  # ── 1. region boundary ───────────────────────────────────────────────────
  region_boundary_statements = concat(
    [
      {
        Sid       = "DenyOutsideApprovedRegions"
        Effect    = "Deny"
        NotAction = local.global_service_actions
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:RequestedRegion" = local.allowed_regions } }
      },
    ],
    length(local.exception_regions) == 0 ? [] : [
      {
        Sid       = "DenyAllButHealthCheckInExceptionRegion"
        Effect    = "Deny"
        NotAction = concat(local.global_service_actions, local.health_check_exception_actions)
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.exception_regions } }
      },
    ],
    [
      {
        Sid       = "DenyEnablingUnapprovedRegions"
        Effect    = "Deny"
        Action    = ["account:EnableRegion"]
        Resource  = "*"
        Condition = { StringNotEquals = { "account:TargetRegion" = var.approved_regions } }
      },
    ],
  )

  # ── 2. data-copy guard ───────────────────────────────────────────────────
  # The destination vault is the resource CopyIntoBackupVault is authorised
  # against, so "copy only into these vaults" is a Deny on every other vault.
  # (Resource and NotResource are filtered for null so only one is emitted.)
  no_approved_vault = length(var.approved_backup_vault_arns) == 0
  backup_copy_statement = {
    for k, v in {
      Sid         = local.no_approved_vault ? "DenyBackupCopyAnywhere" : "DenyBackupCopyToUnapprovedVaults"
      Effect      = "Deny"
      Action      = ["backup:CopyIntoBackupVault"]
      Resource    = local.no_approved_vault ? "*" : null
      NotResource = local.no_approved_vault ? null : var.approved_backup_vault_arns
    } : k => v if v != null
  }

  data_copy_guard_statements = concat(
    length(local.data_copy_effective) == 0 ? [] : [
      {
        Sid      = "DenyDataCopyAndReplicationFeatures"
        Effect   = "Deny"
        Action   = local.data_copy_effective
        Resource = "*"
      },
    ],
    [
      {
        Sid       = "DenyMultiRegionKeys"
        Effect    = "Deny"
        Action    = ["kms:CreateKey"]
        Resource  = "*"
        Condition = { Bool = { "kms:MultiRegion" = "true" } }
      },
      local.backup_copy_statement,
    ],
  )

  # ── 3. audit guard ───────────────────────────────────────────────────────
  audit_guard_statements = [
    {
      Sid    = "DenyDisablingAuditAndDetection"
      Effect = "Deny"
      Action = [
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail",
        "cloudtrail:PutEventSelectors",
        "guardduty:DeleteDetector",
        "guardduty:UpdateDetector",
        "guardduty:DisassociateFromAdministratorAccount",
        "guardduty:DisassociateFromMasterAccount",
        "guardduty:StopMonitoringMembers",
        "access-analyzer:DeleteAnalyzer",
      ]
      Resource  = "*"
      Condition = { ArnNotLike = { "aws:PrincipalARN" = var.audit_exempt_principal_arns } }
    },
    {
      Sid      = "DenyLeavingTheOrganization"
      Effect   = "Deny"
      Action   = ["organizations:LeaveOrganization"]
      Resource = "*"
    },
  ]

  documents = {
    "region-boundary" = jsonencode({ Version = "2012-10-17", Statement = local.region_boundary_statements })
    "data-copy-guard" = jsonencode({ Version = "2012-10-17", Statement = local.data_copy_guard_statements })
    "audit-guard"     = jsonencode({ Version = "2012-10-17", Statement = local.audit_guard_statements })
  }
}
