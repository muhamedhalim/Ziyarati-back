# Least-privilege roles (SECURITY.md §2). No role gets "*" actions.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# ── Execution role: image pull, logs, secret injection (app services) ──────
resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadAppSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.database_url_secret_arn, var.redis_url_secret_arn, var.app_secret_arn]
  }
  statement {
    sid       = "DecryptWithEnvKey"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# ── Ops execution role: ONLY for the break-glass psql task. Separate so the
#    app deploy role (which may PassRole the app roles) can never craft a task
#    definition that injects the RDS master password.
resource "aws_iam_role" "ops_execution" {
  name               = "${var.name}-ecs-ops-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "ops_execution_managed" {
  role       = aws_iam_role.ops_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ops_execution_secrets" {
  statement {
    sid       = "ReadRdsMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.rds_master_secret_arn]
  }
  statement {
    sid       = "DecryptWithEnvKey"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "ops_execution_secrets" {
  name   = "rds-master-secret"
  role   = aws_iam_role.ops_execution.id
  policy = data.aws_iam_policy_document.ops_execution_secrets.json
}

# ── Shared runtime permissions ───────────────────────────────────────────────
data "aws_iam_policy_document" "storage_and_email" {
  statement {
    sid = "UploadsObjects"
    # DeleteObjectVersion: StorageService.purgeObject/purgeTenantPrefix permanently remove EVERY
    # version of a patient document (versioned bucket; residency plan P11). Without it the purge
    # fails, the API logs a warning and still answers 200, and the document stays in S3.
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${var.uploads_bucket_arn}/*"]
  }
  statement {
    # Lets HeadObject return 404 (not 403) for a missing key.
    sid       = "UploadsList"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"] # ListBucketVersions: enumerate versions to purge
    resources = [var.uploads_bucket_arn]
  }
  statement {
    sid       = "UploadsKmsViaS3Only"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
  }
  statement {
    sid       = "SendEmailViaConfigurationSet"
    actions   = ["ses:SendEmail"]
    resources = [var.ses_identity_arn, var.ses_configuration_set_arn]
  }
}

data "aws_iam_policy_document" "ecs_exec" {
  statement {
    sid = "EcsExecSessionManager"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"] # these actions do not support resource-level scoping
  }
  # Session transcripts go to the KMS-encrypted ops log group (cluster
  # execute_command_configuration) — every interactive session is audited.
  statement {
    sid       = "EcsExecSessionLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.this["ops"].arn}:*"]
  }
  statement {
    sid       = "EcsExecLogGroupDescribe"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
  statement {
    sid       = "EcsExecSessionKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }
}

# ── API task role ────────────────────────────────────────────────────────────
resource "aws_iam_role" "api" {
  name               = "${var.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "api_runtime" {
  name   = "storage-email"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.storage_and_email.json
}

resource "aws_iam_role_policy" "api_exec" {
  count  = var.enable_execute_command ? 1 : 0
  name   = "ecs-exec"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.ecs_exec.json
}

# ── Worker task role (+ SES feedback queue) ──────────────────────────────────
resource "aws_iam_role" "worker" {
  name               = "${var.name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "worker_runtime" {
  name   = "storage-email"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.storage_and_email.json
}

data "aws_iam_policy_document" "worker_feedback" {
  statement {
    sid = "SesFeedbackQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [var.ses_feedback_queue_arn]
  }
  statement {
    sid       = "DecryptFeedbackMessages"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["sqs.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "worker_feedback" {
  name   = "ses-feedback"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_feedback.json
}

resource "aws_iam_role_policy" "worker_exec" {
  count  = var.enable_execute_command ? 1 : 0
  name   = "ecs-exec"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.ecs_exec.json
}

# ── Migrate task role: needs nothing from AWS (DB via DATABASE_URL) ─────────
resource "aws_iam_role" "migrate" {
  name               = "${var.name}-migrate-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}
