import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const AUDIT_SEVERITIES = ['info', 'warning', 'high', 'critical'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/** Stable finding codes — the audit rule identifiers. */
export const AUDIT_FINDING_CODES = [
  'PERMISSION_UNASSIGNED',
  'PERMISSION_NO_DESCRIPTION',
  'DEPRECATED_PERMISSION_ASSIGNED',
  'HIGH_RISK_BROAD_ASSIGNMENT',
  'CRITICAL_ON_TENANT_ROLE',
  'ROLE_SCOPE_MISMATCH',
  'DANGEROUS_ROLE_COMBINATION',
  'PERMISSION_MISSING_FROM_REGISTRY',
  'PERMISSION_MISSING_FROM_DATABASE',
  'INCONSISTENT_PERMISSION_METADATA',
] as const;
export type AuditFindingCode = (typeof AUDIT_FINDING_CODES)[number];

/** Filters for the RBAC audit findings feed. */
export class QueryAuditDto {
  @ApiPropertyOptional({ enum: AUDIT_SEVERITIES, description: 'Filter by severity.' })
  @IsOptional() @IsIn(AUDIT_SEVERITIES as unknown as string[]) severity?: AuditSeverity;

  @ApiPropertyOptional({ enum: AUDIT_FINDING_CODES, description: 'Filter by finding code (rule type).' })
  @IsOptional() @IsIn(AUDIT_FINDING_CODES as unknown as string[]) code?: AuditFindingCode;

  @ApiPropertyOptional({ description: 'Filter by related permission module.' })
  @IsOptional() @IsString() @MaxLength(64) module?: string;
}
