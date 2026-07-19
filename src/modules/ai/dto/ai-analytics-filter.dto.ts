import { IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Date scope for AI analytics (always tenant-scoped).
 *
 * Note: usage/cost logs are keyed by `period_month` (no created_at), so the
 * date range is applied at month granularity for those; conversation/message
 * metrics use the exact `created_at` range.
 */
export class AiAnalyticsFilterDto {
  @ApiPropertyOptional({ description: 'Lower bound (inclusive). ISO-8601.', example: '2026-01-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive). ISO-8601.', example: '2026-12-31T23:59:59Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Limit cost attribution to one tenant-owned AI conversation.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
