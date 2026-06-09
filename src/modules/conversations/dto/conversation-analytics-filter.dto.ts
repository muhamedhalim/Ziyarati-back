import { IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Date/agent scope for conversation analytics (always tenant-scoped). */
export class ConversationAnalyticsFilterDto {
  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on `created_at`. ISO-8601.', example: '2026-06-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on `created_at`. ISO-8601.', example: '2026-07-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Restrict to a single assigned agent (for agent performance).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;
}
