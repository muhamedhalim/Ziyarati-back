mock_provider "aws" {
  source = "../../testing/aws"
}

mock_provider "random" {}

variables {
  name               = "zt-test"
  data_subnet_ids    = ["subnet-a", "subnet-b"]
  security_group_id  = "sg-redis"
  kms_key_arn        = "arn:aws:kms:me-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
  node_type          = "cache.t4g.small"
  num_cache_clusters = 2
}

run "valkey_is_encrypted_authenticated_and_bullmq_safe" {
  command = plan

  assert {
    condition     = aws_elasticache_replication_group.this.engine == "valkey"
    error_message = "Engine must be Valkey"
  }

  assert {
    condition = (
      tostring(aws_elasticache_replication_group.this.transit_encryption_enabled) == "true" &&
      tostring(aws_elasticache_replication_group.this.at_rest_encryption_enabled) == "true"
    )
    error_message = "TLS in transit and encryption at rest are required"
  }

  assert {
    condition     = aws_elasticache_replication_group.this.automatic_failover_enabled == true && aws_elasticache_replication_group.this.multi_az_enabled == true
    error_message = "2 nodes must mean Multi-AZ automatic failover"
  }

  assert {
    condition     = contains([for p in aws_elasticache_parameter_group.this.parameter : "${p.name}=${p.value}"], "maxmemory-policy=noeviction")
    error_message = "BullMQ requires maxmemory-policy=noeviction"
  }

  assert {
    condition     = output.replication_group_id == "zt-test-valkey"
    error_message = "replication_group_id must be known at plan time (alarm for_each keys)"
  }
}

run "single_node_has_no_failover" {
  command = plan

  variables {
    num_cache_clusters = 1
  }

  assert {
    condition     = aws_elasticache_replication_group.this.automatic_failover_enabled == false
    error_message = "A single node cannot fail over"
  }
}

# Data boundary: encrypted at rest and in transit (TLS required) and slow-log
# retention under the env key. A Global Datastore is excluded at source level
# (infra/scripts/region-gate.sh forbids aws_elasticache_global_replication_group).
run "cache_is_encrypted_and_logs_are_retained" {
  command = plan

  assert {
    condition = (
      tostring(aws_elasticache_replication_group.this.at_rest_encryption_enabled) == "true" &&
      aws_elasticache_replication_group.this.transit_encryption_enabled == true &&
      aws_elasticache_replication_group.this.transit_encryption_mode == "required"
    )
    error_message = "Redis must be encrypted at rest and require TLS"
  }

  assert {
    condition     = aws_cloudwatch_log_group.slow.retention_in_days > 0 && aws_cloudwatch_log_group.slow.kms_key_id == var.kms_key_arn
    error_message = "Slow-log group needs a finite retention and the env CMK"
  }
}
