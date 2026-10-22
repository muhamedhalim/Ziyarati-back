# RL-09 — attack-signal alarms. Before this file, nothing alerted on WAF rate
# rules, app 429s, a rate limiter running in degraded (Redis-down) mode, or
# the outbox relay holding back on Redis memory (RL-08), so an abuse campaign
# was visible only through user complaints.
#
# Baselines (14 days to 2026-10-22, read from production): app 429s = 0, WAF
# rate-rule matches = 0, "entering degraded mode" lines = 0. Thresholds are
# deliberately low — any sustained hit is news. None of these duplicate the
# existing 5xx / CPU / memory / Redis-memory alarms in main.tf.

locals {
  rate_limit_log_metrics = {
    # Access-log line written by common/logging/http-access-log.ts.
    "api-http-429" = {
      group   = var.api_log_group_name
      metric  = "Http429"
      pattern = "{ ($.event = \"http.request.completed\") && ($.status = 429) }"
    }
    # DegradedModeLogLimiter: "<label> — entering degraded mode: <error>",
    # logged once per episode by every limiter that has a local fallback.
    "api-rate-limit-degraded" = {
      group   = var.api_log_group_name
      metric  = "RateLimitDegraded"
      pattern = "{ $.message = \"*entering degraded mode*\" }"
    }
    # RL-08: worker/outbox-relay.service.ts, once per pause then once a minute.
    "worker-outbox-paused" = {
      group   = var.worker_log_group_name
      metric  = "OutboxPausedRedisMemory"
      pattern = "{ $.message = \"Outbox relay paused*\" }"
    }
  }

  # Rule names -> the CloudWatch metric names modules/waf sets in each
  # rule's visibility_config ("${name}-<suffix>"); the flood rule's metric is
  # "-rate-source-ip", not its rule name.
  waf_rate_rule_metrics = {
    "rate-auth"             = "rate-auth"
    "rate-auth-source-ip"   = "rate-auth-source-ip"
    "rate-public"           = "rate-public"
    "rate-public-source-ip" = "rate-public-source-ip"
    "rate-socketio"         = "rate-socketio"
    "rate-global-forwarded" = "rate-global"
    "rate-source-ip-flood"  = "rate-source-ip"
  }
  # In count mode a rate rule never "blocks", so alert on what it counted.
  waf_rule_metric = var.waf_mode == "block" ? "BlockedRequests" : "CountedRequests"
}

resource "aws_cloudwatch_log_metric_filter" "rate_limit" {
  for_each       = local.rate_limit_log_metrics
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

resource "aws_cloudwatch_metric_alarm" "api_429_burst" {
  alarm_name          = "${var.name}-warning-api-429-burst"
  alarm_description   = "RL-09: > ${var.http_429_burst_threshold} HTTP 429s in 5 min (14-day baseline: 0). Someone is hitting a rate limit hard — check which route in the access log (status=429) and the WAF sampled requests."
  namespace           = local.logs_ns
  metric_name         = "Http429"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.http_429_burst_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.rate_limit]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "rate_limit_degraded" {
  alarm_name          = "${var.name}-warning-rate-limit-degraded"
  alarm_description   = "RL-09: a rate limiter fell back to per-task counters (Redis unreachable or full). Limits are now limit x task count until Redis recovers."
  namespace           = local.logs_ns
  metric_name         = "RateLimitDegraded"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.rate_limit]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "outbox_paused" {
  alarm_name          = "${var.name}-warning-outbox-paused-redis-memory"
  alarm_description   = "RL-08: the outbox relay is holding jobs in Postgres because Redis memory is above QUEUE_ENQUEUE_MAX_REDIS_MEMORY_PERCENT. No job is lost, but delivery is delayed until memory drops — find what is filling Redis."
  namespace           = local.logs_ns
  metric_name         = "OutboxPausedRedisMemory"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.rate_limit]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "waf_rate_rule" {
  for_each            = local.waf_rate_rule_metrics
  alarm_name          = "${var.name}-warning-waf-${each.key}"
  alarm_description   = "RL-09: WAF rule ${each.key} ${var.waf_mode == "block" ? "blocked" : "counted"} > ${var.waf_rate_rule_threshold} requests in 5 min (14-day baseline: 0 matches). Check the WAF log group for the source."
  namespace           = "AWS/WAFV2"
  metric_name         = local.waf_rule_metric
  dimensions          = { WebACL = "${var.name}-api", Region = var.region, Rule = "${var.name}-${each.value}" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.waf_rate_rule_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}
