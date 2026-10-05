output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "alarm_names" {
  value = concat(
    [for a in aws_cloudwatch_metric_alarm.simple : a.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.alb_5xx_rate : a.alarm_name],
  )
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.this.dashboard_name
}

output "infra_events_topic_arn" {
  value = aws_sns_topic.infra_events.arn
}
