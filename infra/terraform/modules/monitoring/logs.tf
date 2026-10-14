# ── Structured-log metrics, alarms and saved queries (LOGGING.md) ────────────
#
# The application writes one JSON object per line (schema: LOGGING.md §2), so
# every filter below is a JSON pattern on a stable `event` name — not a text
# fragment that breaks when a message is reworded. Metric dimensions are only
# ever closed sets (provider); never a request, user, tenant or job id.
#
# Ship with the image that writes JSON logs: an older image's text lines match
# none of these patterns (the "silent service" alarms would then fire).

locals {
  logs_ns = "ZiyaraTech/${var.environment}"

  json_log_metrics = merge(
    {
      "api-http-requests" = {
        group   = var.api_log_group_name, metric = "HttpRequests"
        pattern = "{ $.event = \"http.request.completed\" }"
      }
      "api-http-5xx" = {
        group   = var.api_log_group_name, metric = "Http5xx"
        pattern = "{ ($.event = \"http.request.completed\") && ($.status >= 500) }"
      }
      "api-failed-logins" = {
        group   = var.api_log_group_name, metric = "FailedLogins"
        pattern = "{ $.event = \"auth.login.failed\" }"
      }
      "api-refresh-reuse" = {
        group   = var.api_log_group_name, metric = "AuthRefreshReuse"
        pattern = "{ $.event = \"auth.refresh.reuse_detected\" }"
      }
      # Server-side booking failures only; a 409 slot conflict is normal traffic.
      "api-booking-failures" = {
        group   = var.api_log_group_name, metric = "BookingServerFailures"
        pattern = "{ ($.event = \"appointment.booking.failed\") && ($.status >= 500) }"
      }
      "worker-job-retries" = {
        group   = var.worker_log_group_name, metric = "JobRetries"
        pattern = "{ $.event = \"job.processing.retry_scheduled\" }"
      }
    },
    merge([for role, group in { api = var.api_log_group_name, worker = var.worker_log_group_name } : {
      "${role}-fatal" = {
        group   = group, metric = "FatalEvents"
        pattern = "{ $.level = \"fatal\" }"
      }
      "${role}-heartbeat" = {
        group   = group, metric = "Heartbeats-${role}"
        pattern = "{ $.event = \"app.heartbeat\" }"
      }
      "${role}-payment-failures" = {
        group   = group, metric = "PaymentFailures"
        pattern = "{ ($.event = \"payment.processing.failed\") || ($.event = \"payment.webhook.failed\") || (($.event = \"payment.state.changed\") && ($.state = \"failed\")) }"
      }
    }]...),
  )
}

resource "aws_cloudwatch_log_metric_filter" "json" {
  for_each       = local.json_log_metrics
  name           = "${var.name}-log-${each.key}"
  log_group_name = each.value.group
  pattern        = each.value.pattern
  metric_transformation {
    name          = each.value.metric
    namespace     = local.logs_ns
    value         = "1"
    default_value = "0"
  }
}

# Provider failures (5xx / 429 / timeout / network — 4xx are the caller's
# business and logged at debug). Dimensioned by the closed `provider` set, so
# no default value is allowed (CloudWatch rule for dimensioned filters).
resource "aws_cloudwatch_log_metric_filter" "provider_failures" {
  for_each       = { api = var.api_log_group_name, worker = var.worker_log_group_name }
  name           = "${var.name}-log-${each.key}-provider-failures"
  log_group_name = each.value
  pattern        = "{ ($.event = \"provider.request.failed\") && ($.level = \"warn\") }"
  metric_transformation {
    name       = "ProviderFailures"
    namespace  = local.logs_ns
    value      = "1"
    dimensions = { Provider = "$.provider" }
  }
}

locals {
  log_alarms = merge(
    {
      "critical-fatal-process-error" = {
        metric = "FatalEvents", dims = {}, stat = "Sum"
        op     = "GreaterThanOrEqualToThreshold", threshold = 1, period = 300, evals = 1, missing = "notBreaching"
        desc   = "L-01: a process logged a fatal error (uncaught exception / unhandled rejection) and restarted. Query 'errors-last-hour', then the request_id / job_id on the fatal line."
      }
      "warning-failed-login-burst" = {
        metric = "FailedLogins", dims = {}, stat = "Sum"
        op     = "GreaterThanOrEqualToThreshold", threshold = var.failed_login_burst_threshold, period = 300, evals = 1, missing = "notBreaching"
        desc   = "L-03: >= ${var.failed_login_burst_threshold} failed logins in 5 min across all sources (credential stuffing or a broken client). Query 'failed-logins-by-ip'."
      }
      "warning-refresh-token-reuse" = {
        metric = "AuthRefreshReuse", dims = {}, stat = "Sum"
        op     = "GreaterThanOrEqualToThreshold", threshold = 1, period = 300, evals = 1, missing = "notBreaching"
        desc   = "L-04: a rotated refresh token was replayed (possible token theft); the family was revoked. Check the user_id / client_ip on the auth.refresh.reuse_detected line."
      }
      "warning-booking-server-failures" = {
        metric = "BookingServerFailures", dims = {}, stat = "Sum"
        op     = "GreaterThanOrEqualToThreshold", threshold = 3, period = 900, evals = 1, missing = "notBreaching"
        desc   = "L-05: >= 3 bookings failed with a 5xx in 15 min. Query 'errors-last-hour' filtered on event appointment.booking.failed."
      }
      "warning-payment-failures" = {
        metric = "PaymentFailures", dims = {}, stat = "Sum"
        op     = "GreaterThanOrEqualToThreshold", threshold = 5, period = 900, evals = 1, missing = "notBreaching"
        desc   = "L-06: >= 5 payment request/webhook failures or failed payments in 15 min. Query 'integration-failures'."
      }
      "warning-job-retry-storm" = {
        metric = "JobRetries", dims = {}, stat = "Sum"
        op     = "GreaterThanThreshold", threshold = 100, period = 300, evals = 2, missing = "notBreaching"
        desc   = "L-07: > 100 job retries per 5 min for 10 min — a dependency is failing and jobs are backing off. Query 'failed-jobs'."
      }
    },
    { for p in var.alarm_providers : "warning-provider-failures-${p}" => {
      metric = "ProviderFailures", dims = { Provider = p }, stat = "Sum"
      op     = "GreaterThanThreshold", threshold = var.provider_failure_threshold, period = 300, evals = 2, missing = "notBreaching"
      desc   = "L-08: > ${var.provider_failure_threshold} ${p} 5xx/429/timeout/network failures per 5 min for 10 min. Query 'provider-failures'; check the provider status page and NAT egress."
    } },
    # A process that stops writing logs (hung, crash-looping before logging, or
    # a broken log pipeline) is detected by the 60 s heartbeat going missing.
    # Disable alarm ACTIONS during planned maintenance / scale-to-zero:
    #   aws cloudwatch disable-alarm-actions --alarm-names <name>
    !var.enable_log_silence_alarms ? {} : { for role in ["api", "worker"] : "critical-${role}-logs-silent" => {
      metric = "Heartbeats-${role}", dims = {}, stat = "Sum"
      op     = "LessThanThreshold", threshold = 1, period = 300, evals = 2, missing = "breaching"
      desc   = "L-09: no app.heartbeat from the ${role} for 10 min — the service is down, hung, or its logs are not reaching CloudWatch. Check ECS task state, then the log group."
    } },
  )
}

resource "aws_cloudwatch_metric_alarm" "logs" {
  for_each = local.log_alarms

  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = each.value.desc
  namespace           = local.logs_ns
  metric_name         = each.value.metric
  statistic           = each.value.stat
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

# Application-level 5xx ratio from the access log. Complements the ALB alarm
# (main.tf, alb_5xx_rate): this one also sees requests the ALB counts as 2xx
# but the app marked failed, and is computed from the same lines operators
# search. Quiet periods (< min requests) evaluate to 0, so 1 error at 3 am
# does not page anyone.
resource "aws_cloudwatch_metric_alarm" "app_5xx_ratio" {
  alarm_name          = "${var.name}-warning-app-5xx-ratio"
  alarm_description   = "L-02: application 5xx > ${var.http_5xx_ratio_percent}% of requests (min ${var.http_5xx_min_requests} requests per ${var.http_5xx_period_seconds}s). Query 'errors-last-hour' and 'route-latency'."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.http_5xx_ratio_percent
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "ratio"
    expression  = "IF(req >= ${var.http_5xx_min_requests}, 100 * FILL(err, 0) / req, 0)"
    label       = "app 5xx %"
    return_data = true
  }
  metric_query {
    id = "req"
    metric {
      namespace   = local.logs_ns
      metric_name = "HttpRequests"
      period      = var.http_5xx_period_seconds
      stat        = "Sum"
    }
  }
  metric_query {
    id = "err"
    metric {
      namespace   = local.logs_ns
      metric_name = "Http5xx"
      period      = var.http_5xx_period_seconds
      stat        = "Sum"
    }
  }

  tags = local.tags
}

# Repeated failed logins from ONE source address. Contributor Insights ranks
# `client_ip` (the trusted-proxy-resolved address the API logs on security
# events) without turning it into a metric dimension. Cost: one rule
# (~USD 0.50/month) + matched events; switch off with enable_failed_login_ip_rule.
resource "aws_cloudwatch_contributor_insight_rule" "failed_logins_by_ip" {
  count      = var.enable_failed_login_ip_rule ? 1 : 0
  rule_name  = "${var.name}-failed-logins-by-ip"
  rule_state = "ENABLED"
  rule_definition = jsonencode({
    Schema        = { Name = "CloudWatchLogRule", Version = 1 }
    LogGroupNames = [var.api_log_group_name]
    LogFormat     = "JSON"
    Contribution = {
      Keys    = ["$.client_ip"]
      Filters = [{ Match = "$.event", In = ["auth.login.failed"] }]
    }
    AggregateOn = "Count"
  })
}

resource "aws_cloudwatch_metric_alarm" "failed_logins_single_ip" {
  count               = var.enable_failed_login_ip_rule ? 1 : 0
  alarm_name          = "${var.name}-warning-failed-logins-single-ip"
  alarm_description   = "L-03b: one source address made >= ${var.failed_login_ip_threshold} failed logins in 5 min. Query 'failed-logins-by-ip'; client_ip is a /24 or /48 network, and for browser traffic the Vercel egress network: confirm the source before any WAF block."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.failed_login_ip_threshold
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "top"
    expression  = "INSIGHT_RULE_METRIC('${aws_cloudwatch_contributor_insight_rule.failed_logins_by_ip[0].rule_name}', 'MaxContributorValue')"
    period      = 300
    label       = "failed logins from the top source"
    return_data = true
  }

  tags = local.tags
}

# ── Saved CloudWatch Logs Insights queries (LOGGING.md §Searching) ───────────
# Pick the time range in the console; replace REPLACE_ME where present.
locals {
  app_log_groups = [var.api_log_group_name, var.worker_log_group_name]

  saved_queries = {
    "request-id"           = <<-EOT
      fields @timestamp, service, level, event, message, route, status, duration_ms, user_id, tenant_id, job_id, error.type, error.message
      | filter request_id = "REPLACE_ME"
      | sort @timestamp asc
      | limit 500
    EOT
    "errors-last-hour"     = <<-EOT
      fields @timestamp, service, event, message, request_id, route, status, error.type, error.message
      | filter level in ["error", "fatal"]
      | sort @timestamp desc
      | limit 200
    EOT
    "top-error-types"      = <<-EOT
      filter level in ["error", "fatal"]
      | stats count(*) as errors by service, event, error.type
      | sort errors desc
      | limit 50
    EOT
    "failed-logins-by-ip"  = <<-EOT
      filter event = "auth.login.failed"
      | stats count(*) as failures by client_ip, reason, bin(5m) as window
      | sort failures desc
      | limit 50
    EOT
    "failed-jobs"          = <<-EOT
      filter event in ["job.processing.failed", "job.processing.retry_scheduled", "job.stalled"]
      | stats count(*) as attempts, max(attempt) as max_attempt by queue, job_name, event
      | sort attempts desc
    EOT
    "provider-failures"    = <<-EOT
      filter event = "provider.request.failed"
      | stats count(*) as failures, avg(duration_ms) as avg_ms, max(duration_ms) as max_ms by provider, outcome, status
      | sort failures desc
    EOT
    "integration-failures" = <<-EOT
      fields @timestamp, service, event, provider, outcome, status, message, request_id, tenant_id
      | filter event in ["whatsapp.message.failed", "ai.request.failed", "email.send.failed", "payment.processing.failed", "payment.webhook.failed", "webhook.processing.failed", "provider.request.failed"] or (event = "payment.state.changed" and state = "failed")
      | sort @timestamp desc
      | limit 200
    EOT
    "route-latency"        = <<-EOT
      filter event = "http.request.completed"
      | stats count(*) as requests, pct(duration_ms, 50) as p50_ms, pct(duration_ms, 95) as p95_ms, pct(duration_ms, 99) as p99_ms by route, method
      | sort p95_ms desc
      | limit 50
    EOT
    "tenant-activity"      = <<-EOT
      fields @timestamp, service, level, event, message, route, status, request_id, user_id
      | filter tenant_id = "REPLACE_ME"
      | sort @timestamp desc
      | limit 200
    EOT
  }
}

resource "aws_cloudwatch_query_definition" "saved" {
  for_each        = local.saved_queries
  name            = "ZiyaraTech/${var.environment}/${each.key}"
  log_group_names = local.app_log_groups
  query_string    = each.value
}
