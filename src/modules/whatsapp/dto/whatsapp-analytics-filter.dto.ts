import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Filter for WhatsApp analytics (always tenant-scoped, over notification_logs). */
export class WhatsappAnalyticsFilterDto {
  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on `created_at`. ISO-8601.', example: '2026-06-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on `created_at`. ISO-8601.', example: '2026-07-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Restrict to a single template id (notification_logs.template_id).', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  templateId?: string;
}
