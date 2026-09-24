output "cloudtrail_bucket" {
  value = aws_s3_bucket.trail.id
}

output "guardduty_detector_id" {
  value = aws_guardduty_detector.this.id
}
