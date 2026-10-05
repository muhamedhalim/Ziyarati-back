output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "app_subnet_ids" {
  value = aws_subnet.app[*].id
}

output "data_subnet_ids" {
  value = aws_subnet.data[*].id
}

output "data_route_table_id" {
  value = aws_route_table.data.id
}

output "nat_public_ips" {
  description = "Stable egress IPs (give these to partners that IP-allow-list callers)"
  value       = aws_eip.nat[*].public_ip
}

output "security_group_ids" {
  value = {
    alb    = aws_security_group.alb.id
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
    rds    = aws_security_group.rds.id
    redis  = aws_security_group.redis.id
  }
}

output "nat_gateway_ids" {
  description = "NAT gateway ids (ErrorPortAllocation alarms)"
  value       = aws_nat_gateway.this[*].id
}
