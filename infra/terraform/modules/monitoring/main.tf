# Alarms map 1:1 to SCALING-ROADMAP.md §1 (S-xx). Every alarm names its
# severity in the alarm name and description; both severities go to the same
# SNS topic in Phase 1 (one small team), routed to PagerDuty/Slack in Phase 2.

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 6.0"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

locals {
  tags = merge(var.tags, { Component = "monitoring" })
  gib  = 1073741824

  redis_nodes = [for i in range(var.redis_num_cache_clusters) : format("%s-%03d", var.redis_replication_group_id, i + 1)]

  alb_dims = { LoadBalancer = var.alb_arn_suffix }
  tg_dims  = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  rds_dims = { DBInstanceIdentifier = var.rds_identifier }
}

# ── Alert topic ──────────────────────────────────────────────────────────────
resource "aws_sns_topic" "alerts" {
  name              = "${var.name}-alerts"
  kms_master_key_id = var.kms_key_arn
  tags              = local.tags
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email" # each address must click the confirmation link once
  endpoint  = each.value
}

# ── Log-derived metrics (app metrics reach CloudWatch in Phase 2) ───────────
# Application logs are JSON (one object per line, schema in LOGGING.md), so
# these are JSON filter patterns. The image and these filters ship TOGETHER:
# an older image writes text lines that the JSON patterns do not match.
# More log-derived metrics, alarms and saved queries live in logs.tf.
resource "aws_cloudwatch_log_metric_filter" "failed_jobs" {
  name           = "${var.name}-failed-jobs"
  log_group_name = var.worker_log_group_name
  # Final failures only — a retry is `job.processing.retry_scheduled`.
  pattern = "{ $.event = \"job.processing.failed\" }"
  metric_transformation {
    name          = "FailedJobs"
    namespace     = "ZiyaraTech/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "app_errors" {
  for_each       = { api = var.api_log_group_name, worker = var.worker_log_group_name }
  name           = "${var.name}-${each.key}-errors"
  log_group_name = each.value
  pattern        = "{ ($.level = \"error\") || ($.level = \"fatal\") }"
  metric_transformation {
    name          = "ErrorLines-${each.key}"
    namespace     = "ZiyaraTech/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

# ── Payments (Tap) log-derived metrics ───────────────────────────────────────
# Every pattern is a literal fragment of a line the payments code already logs
# (so no application change is needed); a code change to one of those messages
# must update this table — the strings are pinned by tap-alert-log-lines.spec.ts.
# The API logs webhook handling and charge creation; the worker logs the
# reconciliation sweeps, so every filter is attached to both log groups.
locals {
  log_groups = { api = var.api_log_group_name, worker = var.worker_log_group_name }

  payment_log_metrics = {
    alert        = { pattern = "\"ALERT:\"", metric = "PaymentsAlerts" }
    misrouted    = { pattern = "\"was NOT routed to the clinic merchant\"", metric = "TapMisroutedCharges" }
    hook_reject  = { pattern = "\"Rejected Tap webhook\"", metric = "TapWebhooksRejected" }
    refetch_fail = { pattern = "\"could not be re-fetched\"", metric = "TapWebhookRefetchFailed" }
    unreachable  = { pattern = "\"Tap\" \"unreachable\"", metric = "TapApiUnavailable" }
    timeout      = { pattern = "\"Tap\" \"timed out\"", metric = "TapApiUnavailable" }
    no_key       = { pattern = "\"no secret key for TAP_ENV\"", metric = "TapNotConfigured" }
  }

  payment_log_filters = merge([
    for gk, gv in local.log_groups : {
      for fk, f in local.payment_log_metrics : "${gk}-${fk}" => merge(f, { group = gv })
    }
  ]...)
}

resource "aws_cloudwatch_log_metric_filter" "payments" {
  for_each       = local.payment_log_filters
  name           = "${var.name}-pay-${each.key}"
  log_group_name = each.value.group
  pattern        = each.value.pattern
  metric_transformation {
    name          = each.value.metric
    namespace     = "ZiyaraTech/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

# ── Alarm catalogue ──────────────────────────────────────────────────────────
locals {
  simple_alarms = merge(
    {
      "critical-alb-no-healthy-targets" = {
        ns   = "AWS/ApplicationELB", metric = "HealthyHostCount", stat = "Minimum", dims = local.tg_dims
        op   = "LessThanThreshold", threshold = 1, period = 60, evals = 2, missing = "breaching"
        desc = "S-04: no healthy API target behind the ALB"
      }
      "warning-alb-unhealthy-targets" = {
        ns   = "AWS/ApplicationELB", metric = "UnHealthyHostCount", stat = "Maximum", dims = local.tg_dims
        op   = "GreaterThanThreshold", threshold = 0, period = 60, evals = 5, missing = "notBreaching"
        desc = "S-04: an API target has failed health checks for 5 min"
      }
      "warning-api-p95-latency" = {
        ns   = "AWS/ApplicationELB", metric = "TargetResponseTime", stat = "p95", dims = local.tg_dims
        op   = "GreaterThanThreshold", threshold = 1, period = 300, evals = 2, missing = "notBreaching"
        desc = "S-05: p95 > 1 s for 10 min"
      }
      "critical-api-p95-latency" = {
        ns   = "AWS/ApplicationELB", metric = "TargetResponseTime", stat = "p95", dims = local.tg_dims
        op   = "GreaterThanThreshold", threshold = 3, period = 300, evals = 2, missing = "notBreaching"
        desc = "S-05: p95 > 3 s for 10 min"
      }
      "critical-api-tasks-below-min" = {
        ns   = "ECS/ContainerInsights", metric = "RunningTaskCount", stat = "Minimum"
        dims = { ClusterName = var.cluster_name, ServiceName = var.api_service_name }
        op   = "LessThanThreshold", threshold = var.api_min_count, period = 60, evals = 5, missing = "breaching"
        desc = "S-04: API running tasks below minimum for 5 min"
      }
      "critical-worker-not-running" = {
        ns   = "ECS/ContainerInsights", metric = "RunningTaskCount", stat = "Minimum"
        dims = { ClusterName = var.cluster_name, ServiceName = var.worker_service_name }
        op   = "LessThanThreshold", threshold = 1, period = 60, evals = 5, missing = "breaching"
        desc = "S-04: no worker running — reminders/emails/WhatsApp not processed"
      }
      "warning-api-memory" = {
        ns   = "AWS/ECS", metric = "MemoryUtilization", stat = "Average"
        dims = { ClusterName = var.cluster_name, ServiceName = var.api_service_name }
        op   = "GreaterThanThreshold", threshold = 75, period = 300, evals = 3, missing = "notBreaching"
        desc = "S-03: API memory > 75%"
      }
      "critical-api-memory" = {
        ns   = "AWS/ECS", metric = "MemoryUtilization", stat = "Maximum"
        dims = { ClusterName = var.cluster_name, ServiceName = var.api_service_name }
        op   = "GreaterThanThreshold", threshold = 90, period = 60, evals = 5, missing = "notBreaching"
        desc = "S-03: API memory > 90% (OOM kill risk)"
      }
      "warning-api-cpu-at-max" = {
        ns   = "AWS/ECS", metric = "CPUUtilization", stat = "Average"
        dims = { ClusterName = var.cluster_name, ServiceName = var.api_service_name }
        op   = "GreaterThanThreshold", threshold = 85, period = 300, evals = 2, missing = "notBreaching"
        desc = "S-02: API CPU > 85% — autoscaling at max or not keeping up"
      }
      "warning-rds-cpu" = {
        ns   = "AWS/RDS", metric = "CPUUtilization", stat = "Average", dims = local.rds_dims
        op   = "GreaterThanThreshold", threshold = 60, period = 300, evals = 6, missing = "notBreaching"
        desc = "S-08: DB CPU > 60% for 30 min (t4g baseline is 20%)"
      }
      "critical-rds-cpu" = {
        ns   = "AWS/RDS", metric = "CPUUtilization", stat = "Average", dims = local.rds_dims
        op   = "GreaterThanThreshold", threshold = 80, period = 300, evals = 3, missing = "notBreaching"
        desc = "S-08: DB CPU > 80% for 15 min"
      }
      "warning-rds-connections" = {
        ns   = "AWS/RDS", metric = "DatabaseConnections", stat = "Maximum", dims = local.rds_dims
        op   = "GreaterThanThreshold", threshold = floor(var.rds_max_connections * 0.6), period = 300, evals = 2, missing = "notBreaching"
        desc = "S-07: DB connections > 60% of max_connections"
      }
      "critical-rds-connections" = {
        ns   = "AWS/RDS", metric = "DatabaseConnections", stat = "Maximum", dims = local.rds_dims
        op   = "GreaterThanThreshold", threshold = floor(var.rds_max_connections * 0.8), period = 60, evals = 3, missing = "notBreaching"
        desc = "S-07: DB connections > 80% of max_connections"
      }
      "warning-rds-free-storage" = {
        ns   = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum", dims = local.rds_dims
        op   = "LessThanThreshold", threshold = floor(var.rds_allocated_storage_gb * 0.2 * local.gib), period = 300, evals = 1, missing = "breaching"
        desc = "S-09: DB free storage < 20% of initial allocation"
      }
      "critical-rds-free-storage" = {
        ns   = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum", dims = local.rds_dims
        op   = "LessThanThreshold", threshold = floor(var.rds_allocated_storage_gb * 0.1 * local.gib), period = 300, evals = 1, missing = "breaching"
        desc = "S-09: DB free storage < 10% of initial allocation"
      }
      "critical-rds-freeable-memory" = {
        ns   = "AWS/RDS", metric = "FreeableMemory", stat = "Minimum", dims = local.rds_dims
        op   = "LessThanThreshold", threshold = 268435456, period = 300, evals = 3, missing = "notBreaching"
        desc = "S-11: DB freeable memory < 256 MB"
      }
      "warning-ses-bounce-rate" = {
        ns   = "AWS/SES", metric = "Reputation.BounceRate", stat = "Maximum", dims = {}
        op   = "GreaterThanThreshold", threshold = 0.025, period = 3600, evals = 1, missing = "notBreaching"
        desc = "S-20: SES bounce rate > 2.5% (AWS reviews at 5%)"
      }
      "critical-ses-bounce-rate" = {
        ns   = "AWS/SES", metric = "Reputation.BounceRate", stat = "Maximum", dims = {}
        op   = "GreaterThanThreshold", threshold = 0.05, period = 3600, evals = 1, missing = "notBreaching"
        desc = "S-20: SES bounce rate > 5% — account under review risk, stop campaigns"
      }
      "warning-ses-complaint-rate" = {
        ns   = "AWS/SES", metric = "Reputation.ComplaintRate", stat = "Maximum", dims = {}
        op   = "GreaterThanThreshold", threshold = 0.0005, period = 3600, evals = 1, missing = "notBreaching"
        desc = "S-20: SES complaint rate > 0.05%"
      }
      "critical-ses-complaint-rate" = {
        ns   = "AWS/SES", metric = "Reputation.ComplaintRate", stat = "Maximum", dims = {}
        op   = "GreaterThanThreshold", threshold = 0.001, period = 3600, evals = 1, missing = "notBreaching"
        desc = "S-20: SES complaint rate > 0.1% — account under review risk"
      }
      "warning-ses-feedback-dlq" = {
        ns   = "AWS/SQS", metric = "ApproximateNumberOfMessagesVisible", stat = "Maximum"
        dims = { QueueName = var.ses_feedback_dlq_name }
        op   = "GreaterThanThreshold", threshold = 0, period = 300, evals = 1, missing = "notBreaching"
        desc = "SES bounce/complaint events the worker could not apply (suppression not recorded)"
      }
      "warning-failed-jobs" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "FailedJobs", stat = "Sum", dims = {}
        op   = "GreaterThanThreshold", threshold = 10, period = 300, evals = 1, missing = "notBreaching"
        desc = "S-16: > 10 BullMQ final failures in 5 min"
      }
      "critical-failed-jobs" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "FailedJobs", stat = "Sum", dims = {}
        op   = "GreaterThanThreshold", threshold = 50, period = 300, evals = 1, missing = "notBreaching"
        desc = "S-16: > 50 BullMQ final failures in 5 min (external outage or bad deploy)"
      }
      "warning-api-error-lines" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "ErrorLines-api", stat = "Sum", dims = {}
        op   = "GreaterThanThreshold", threshold = 50, period = 300, evals = 2, missing = "notBreaching"
        desc = "API ERROR log lines > 50 / 5 min for 10 min"
      }
      "warning-worker-cpu" = {
        ns   = "AWS/ECS", metric = "CPUUtilization", stat = "Average"
        dims = { ClusterName = var.cluster_name, ServiceName = var.worker_service_name }
        op   = "GreaterThanThreshold", threshold = 85, period = 300, evals = 3, missing = "notBreaching"
        desc = "S-17: worker CPU > 85% for 15 min — jobs are queueing; autoscaling at max or not keeping up"
      }
      "warning-worker-memory" = {
        ns   = "AWS/ECS", metric = "MemoryUtilization", stat = "Maximum"
        dims = { ClusterName = var.cluster_name, ServiceName = var.worker_service_name }
        op   = "GreaterThanThreshold", threshold = 85, period = 300, evals = 3, missing = "notBreaching"
        desc = "Worker memory > 85% (OOM-kill risk; a killed worker re-runs its in-flight jobs)"
      }
      "warning-worker-error-lines" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "ErrorLines-worker", stat = "Sum", dims = {}
        op   = "GreaterThanThreshold", threshold = 50, period = 300, evals = 2, missing = "notBreaching"
        desc = "Worker ERROR log lines > 50 / 5 min for 10 min"
      }
      "warning-rds-cpu-credits" = {
        ns   = "AWS/RDS", metric = "CPUCreditBalance", stat = "Minimum", dims = local.rds_dims
        op   = "LessThanThreshold", threshold = 50, period = 300, evals = 3, missing = "notBreaching"
        desc = "S-08: burstable DB CPU credit balance < 50 — the t4g throttle cliff is close (move to db.m7g.large)"
      }
      "critical-rds-disk-queue" = {
        ns   = "AWS/RDS", metric = "DiskQueueDepth", stat = "Average", dims = local.rds_dims
        op   = "GreaterThanThreshold", threshold = 5, period = 300, evals = 3, missing = "notBreaching"
        desc = "S-10: DB disk queue depth > 5 for 15 min — storage IOPS throttled"
      }
      # ── Payments (Tap) — runbook: infra/runbooks/tap-payments-rollout.md §7 ──
      "critical-payments-alert" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "PaymentsAlerts", stat = "Sum", dims = {}
        op   = "GreaterThanOrEqualToThreshold", threshold = 1, period = 900, evals = 1, missing = "notBreaching"
        desc = "P-01: a money-state ALERT line (duplicate capture, reconciliation exception, exhausted payments.outcome, stuck refund, charge captured on a void invoice) — a person must look today"
      }
      "critical-tap-misrouted-charge" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "TapMisroutedCharges", stat = "Sum", dims = {}
        op   = "GreaterThanOrEqualToThreshold", threshold = 1, period = 300, evals = 1, missing = "notBreaching"
        desc = "P-02: Tap put a clinic charge on ZiyaraTech's own account (or named no merchant) — refused, but the clinic's merchant id or the platform routing is wrong"
      }
      "critical-tap-not-configured" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "TapNotConfigured", stat = "Sum", dims = {}
        op   = "GreaterThanOrEqualToThreshold", threshold = 1, period = 300, evals = 1, missing = "notBreaching"
        desc = "P-03: a Tap call was skipped because no secret key is set for TAP_ENV — every payment attempt fails"
      }
      "warning-tap-webhooks-rejected" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "TapWebhooksRejected", stat = "Sum", dims = {}
        op   = "GreaterThanOrEqualToThreshold", threshold = 3, period = 900, evals = 1, missing = "notBreaching"
        desc = "P-04: >= 3 Tap webhooks refused for a bad signature in 15 min — a secret mismatch after rotation, or probing (payments still settle via return-page verify and the 10-minute sweep)"
      }
      "warning-tap-webhook-refetch-failed" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "TapWebhookRefetchFailed", stat = "Sum", dims = {}
        op   = "GreaterThanOrEqualToThreshold", threshold = 3, period = 900, evals = 1, missing = "notBreaching"
        desc = "P-05: >= 3 correctly-signed webhooks for charges Tap will not show us in 15 min — wrong environment/account, or a clinic charge our platform key cannot read"
      }
      "warning-tap-api-unavailable" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "TapApiUnavailable", stat = "Sum", dims = {}
        op   = "GreaterThanThreshold", threshold = 5, period = 300, evals = 2, missing = "notBreaching"
        desc = "P-06: > 5 Tap calls unreachable or timed out per 5 min for 10 min (outcomes stay 'unknown', never failed)"
      }
      "critical-tap-api-unavailable" = {
        ns   = "ZiyaraTech/${var.environment}", metric = "TapApiUnavailable", stat = "Sum", dims = {}
        op   = "GreaterThanThreshold", threshold = 30, period = 300, evals = 2, missing = "notBreaching"
        desc = "P-06: > 30 Tap calls unreachable or timed out per 5 min for 10 min — payments cannot start; check NAT egress and Tap status"
      }
    },
    merge([for node in local.redis_nodes : {
      "warning-redis-memory-${node}" = {
        ns   = "AWS/ElastiCache", metric = "DatabaseMemoryUsagePercentage", stat = "Maximum", dims = { CacheClusterId = node }
        op   = "GreaterThanThreshold", threshold = 60, period = 300, evals = 2, missing = "notBreaching"
        desc = "S-12: Valkey memory > 60% (noeviction: 100% = enqueue failures)"
      }
      "critical-redis-memory-${node}" = {
        ns   = "AWS/ElastiCache", metric = "DatabaseMemoryUsagePercentage", stat = "Maximum", dims = { CacheClusterId = node }
        op   = "GreaterThanThreshold", threshold = 75, period = 60, evals = 3, missing = "notBreaching"
        desc = "S-12: Valkey memory > 75% — resize before writes start failing"
      }
      "warning-redis-cpu-${node}" = {
        ns   = "AWS/ElastiCache", metric = "EngineCPUUtilization", stat = "Average", dims = { CacheClusterId = node }
        op   = "GreaterThanThreshold", threshold = 60, period = 300, evals = 3, missing = "notBreaching"
        desc = "S-13: Valkey engine CPU > 60%"
      }
    }]...),
    # Keys come from the plan-time count, never from (apply-time) NAT ids.
    { for i in range(var.nat_gateway_count) : "critical-nat-port-allocation-${i}" => {
      ns   = "AWS/NATGateway", metric = "ErrorPortAllocation", stat = "Sum", dims = { NatGatewayId = var.nat_gateway_ids[i] }
      op   = "GreaterThanThreshold", threshold = 0, period = 300, evals = 2, missing = "notBreaching"
      desc = "S-21: NAT gateway ${i} ran out of ports — outbound connections (OpenAI, Meta, Tap, AWS APIs) are being dropped"
    } },
    !var.enable_acm_alarm ? {} : {
      "critical-acm-certificate-expiry" = {
        ns   = "AWS/CertificateManager", metric = "DaysToExpiry", stat = "Minimum", dims = { CertificateArn = var.certificate_arn }
        op   = "LessThanThreshold", threshold = 21, period = 86400, evals = 1, missing = "notBreaching"
        desc = "API TLS certificate expires in < 21 days — ACM could not renew; is the DNS validation CNAME (Vercel DNS) still present?"
      }
    },
    !var.enable_ses_queue_alarm ? {} : {
      "warning-ses-feedback-queue-age" = {
        ns   = "AWS/SQS", metric = "ApproximateAgeOfOldestMessage", stat = "Maximum"
        dims = { QueueName = var.ses_feedback_queue_name }
        op   = "GreaterThanThreshold", threshold = 900, period = 300, evals = 2, missing = "notBreaching"
        desc = "SES bounce/complaint events waiting > 15 min — the worker consumer is stalled (suppressions not being recorded)"
      }
    },
  )
}

resource "aws_cloudwatch_metric_alarm" "simple" {
  for_each = local.simple_alarms

  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = each.value.desc
  namespace           = each.value.ns
  metric_name         = each.value.metric
  statistic           = contains(["Minimum", "Maximum", "Average", "Sum", "SampleCount"], each.value.stat) ? each.value.stat : null
  extended_statistic  = contains(["Minimum", "Maximum", "Average", "Sum", "SampleCount"], each.value.stat) ? null : each.value.stat
  dimensions          = each.value.dims
  comparison_operator = each.value.op
  threshold           = each.value.threshold
  period              = each.value.period
  evaluation_periods  = each.value.evals
  treat_missing_data  = each.value.missing
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

# 5xx RATE, not count: ignore periods with < 50 requests so 1 error at 3 am
# does not page anyone.
resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  for_each = { warning = 1, critical = 5 }

  alarm_name          = "${var.name}-${each.key}-api-5xx-rate"
  alarm_description   = "S-06: API 5xx > ${each.value}% of requests (min 50 req/min)"
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "rate"
    expression  = "IF(req >= 50, 100 * (FILL(t5, 0) + FILL(e5, 0)) / req, 0)"
    label       = "5xx %"
    return_data = true
  }
  metric_query {
    id = "req"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = local.alb_dims
      period      = 60
      stat        = "Sum"
    }
  }
  metric_query {
    id = "t5"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = local.alb_dims
      period      = 60
      stat        = "Sum"
    }
  }
  metric_query {
    id = "e5"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      dimensions  = local.alb_dims
      period      = 60
      stat        = "Sum"
    }
  }

  tags = local.tags
}

# ── External health check (global checkers; sees a regional outage the
#    in-region alarms cannot report). Its metric lives only in us-east-1. ────
resource "aws_route53_health_check" "api" {
  count             = var.enable_external_health_check ? 1 : 0
  fqdn              = var.api_domain
  port              = 443
  type              = "HTTPS"
  resource_path     = "/api/v1/health"
  request_interval  = 30
  failure_threshold = 3
  tags              = merge(local.tags, { Name = "${var.name}-api-health" })
}

# Alarm names/metric only — no data — so this us-east-1 topic is not
# CMK-encrypted (a CMK would have to be created in us-east-1 just for it).
resource "aws_sns_topic" "alerts_us_east_1" {
  count    = var.enable_external_health_check ? 1 : 0
  provider = aws.us_east_1
  name     = "${var.name}-alerts-external"
  tags     = local.tags
}

resource "aws_sns_topic_subscription" "email_us_east_1" {
  for_each  = var.enable_external_health_check ? toset(var.alert_emails) : toset([])
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.alerts_us_east_1[0].arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_metric_alarm" "external_health" {
  count               = var.enable_external_health_check ? 1 : 0
  provider            = aws.us_east_1
  alarm_name          = "${var.name}-critical-api-unreachable-from-internet"
  alarm_description   = "Route 53 global checkers cannot reach https://${var.api_domain}/api/v1/health"
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.api[0].id }
  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 3
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts_us_east_1[0].arn]
  ok_actions          = [aws_sns_topic.alerts_us_east_1[0].arn]
  tags                = local.tags
}

# ── Dashboard ────────────────────────────────────────────────────────────────
resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title = "API — requests & 5xx", region = var.region, stat = "Sum", period = 60
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix],
            [".", "HTTPCode_Target_5XX_Count", ".", "."],
            [".", "HTTPCode_Target_4XX_Count", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title = "API — latency p50/p95", region = var.region, period = 60
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix, "TargetGroup", var.target_group_arn_suffix, { stat = "p50" }],
            ["...", { stat = "p95" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title = "ECS — CPU / memory", region = var.region, stat = "Average", period = 60
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.cluster_name, "ServiceName", var.api_service_name],
            [".", "MemoryUtilization", ".", ".", ".", "."],
            [".", "CPUUtilization", ".", ".", ".", var.worker_service_name],
            [".", "MemoryUtilization", ".", ".", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title = "ECS — running tasks", region = var.region, stat = "Minimum", period = 60
          metrics = [
            ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", var.cluster_name, "ServiceName", var.api_service_name],
            ["...", var.worker_service_name],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 12, width = 12, height = 6
        properties = {
          title = "RDS — CPU / connections", region = var.region, period = 60
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.rds_identifier, { stat = "Average" }],
            [".", "DatabaseConnections", ".", ".", { stat = "Maximum", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 12, width = 12, height = 6
        properties = {
          title = "RDS — storage / memory / IOPS", region = var.region, period = 300
          metrics = [
            ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", var.rds_identifier, { stat = "Minimum" }],
            [".", "FreeableMemory", ".", ".", { stat = "Minimum" }],
            [".", "ReadIOPS", ".", ".", { stat = "Average", yAxis = "right" }],
            [".", "WriteIOPS", ".", ".", { stat = "Average", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 18, width = 12, height = 6
        properties = {
          title = "Valkey — memory % / CPU", region = var.region, stat = "Maximum", period = 60
          metrics = concat(
            [for n in local.redis_nodes : ["AWS/ElastiCache", "DatabaseMemoryUsagePercentage", "CacheClusterId", n]],
            [for n in local.redis_nodes : ["AWS/ElastiCache", "EngineCPUUtilization", "CacheClusterId", n, { yAxis = "right" }]],
          )
        }
      },
      {
        type = "metric", x = 12, y = 18, width = 12, height = 6
        properties = {
          title = "Jobs & email", region = var.region, stat = "Sum", period = 300
          metrics = [
            ["ZiyaraTech/${var.environment}", "FailedJobs"],
            ["AWS/SES", "Send"],
            [".", "Bounce"],
            [".", "Complaint"],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 24, width = 12, height = 6
        properties = {
          title = "Payments — Tap", region = var.region, stat = "Sum", period = 300
          metrics = [
            ["ZiyaraTech/${var.environment}", "PaymentsAlerts"],
            [".", "TapWebhooksRejected"],
            [".", "TapWebhookRefetchFailed"],
            [".", "TapApiUnavailable"],
            [".", "TapMisroutedCharges"],
          ]
        }
      },
    ]
  })
}

# ── Infrastructure event routing (failovers, failed deploys, stopped tasks) ──
# Alarms detect symptoms; these are the events that explain them (and the ones
# with no metric at all: an RDS Multi-AZ failover, a circuit-breaker rollback).
# Everything goes through EventBridge (RDS and ECS both emit there natively),
# so no RDS event subscription and no extra KMS grants are needed: the data
# key's policy already lets events.amazonaws.com publish to encrypted topics
# (GuardDuty uses the same path). Payloads are resource names/status only.
data "aws_caller_identity" "current" {}

resource "aws_sns_topic" "infra_events" {
  name              = "${var.name}-infra-events"
  kms_master_key_id = var.kms_key_arn
  tags              = local.tags
}

resource "aws_sns_topic_subscription" "infra_events_email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.infra_events.arn
  protocol  = "email"
  endpoint  = each.value
}

data "aws_iam_policy_document" "infra_events" {
  statement {
    sid       = "AllowEventBridgeRules"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.infra_events.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "infra_events" {
  arn    = aws_sns_topic.infra_events.arn
  policy = data.aws_iam_policy_document.infra_events.json
}

locals {
  infra_event_rules = {
    rds-instance = {
      description = "RDS instance failover / failure / availability / low storage / recovery / deletion"
      pattern = {
        source        = ["aws.rds"]
        "detail-type" = ["RDS DB Instance Event"]
        detail = {
          SourceIdentifier = [var.rds_identifier]
          EventCategories  = ["failover", "failure", "availability", "low storage", "recovery", "deletion"]
        }
      }
    }
    ecs-deployment-failed = {
      description = "ECS service deployment failed (circuit breaker rolled back or gave up)"
      pattern = {
        source        = ["aws.ecs"]
        "detail-type" = ["ECS Deployment State Change"]
        detail        = { eventName = ["SERVICE_DEPLOYMENT_FAILED"] }
        resources     = [{ wildcard = "*:service/${var.cluster_name}/*" }]
      }
    }
    ecs-task-failed = {
      description = "A SERVICE task stopped abnormally (failed to start, OOM, essential container exit). One-off migrate tasks are excluded: their group is not service:*"
      pattern = {
        source        = ["aws.ecs"]
        "detail-type" = ["ECS Task State Change"]
        detail = {
          clusterArn = [{ wildcard = "*:cluster/${var.cluster_name}" }]
          lastStatus = ["STOPPED"]
          group      = [{ prefix = "service:" }]
          stopCode   = ["TaskFailedToStart", "EssentialContainerExited"]
        }
      }
    }
  }
}

resource "aws_cloudwatch_event_rule" "infra" {
  for_each      = local.infra_event_rules
  name          = "${var.name}-${each.key}"
  description   = each.value.description
  event_pattern = jsonencode(each.value.pattern)
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "infra" {
  for_each = local.infra_event_rules
  rule     = aws_cloudwatch_event_rule.infra[each.key].name
  arn      = aws_sns_topic.infra_events.arn

  depends_on = [aws_sns_topic_policy.infra_events]
}
