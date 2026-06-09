import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  NOTIFICATION_STATUSES,
  RECIPIENT_TYPES,
} from '../notification.constants';

/** Filter + pagination for scheduled notifications (always tenant-scoped). */
export class ScheduledNotificationFilterDto {
  @ApiPropertyOptional({
    description: 'Filter by lifecycle status (e.g. SCHEDULED for pending, SENT/DELIVERED for completed).',
    enum: NOTIFICATION_STATUSES,
    example: 'SCHEDULED',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by template.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({ description: 'Filter by related appointment.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @ApiPropertyOptional({ description: 'Filter by recipient kind.', enum: RECIPIENT_TYPES, example: 'CUSTOMER' })
  @IsOptional()
  @IsIn(RECIPIENT_TYPES)
  recipientType?: string;

  @ApiPropertyOptional({ description: 'Filter by recipient id.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  recipientId?: string;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on `scheduled_at`. ISO-8601.', example: '2026-06-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on `scheduled_at`. ISO-8601.', example: '2026-07-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
