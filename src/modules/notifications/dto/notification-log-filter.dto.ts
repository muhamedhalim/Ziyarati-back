import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  NOTIFICATION_CHANNELS_LIST,
  RECIPIENT_TYPES,
} from '../notification.constants';

/**
 * Filter + pagination for notification logs (always tenant-scoped).
 *
 * Schema note: `notification_logs` has no appointment FK — appointment-scoped
 * tracking is on the scheduler. "Customer" filtering is expressed via
 * `recipientType=CUSTOMER` + `recipientId`. "Notification type" maps to the
 * `templateId` and/or `channel` columns.
 */
export class NotificationLogFilterDto {
  @ApiPropertyOptional({ description: 'Filter by delivery status (e.g. SENT, FAILED, DELIVERED).', example: 'FAILED', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by channel.', enum: NOTIFICATION_CHANNELS_LIST, example: 'WHATSAPP' })
  @IsOptional()
  @IsIn(NOTIFICATION_CHANNELS_LIST)
  channel?: string;

  @ApiPropertyOptional({ description: 'Filter by template id (notification type).', maxLength: 100, example: 'a1b2c3d4-0000-0000-0000-000000000300' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  templateId?: string;

  @ApiPropertyOptional({ description: 'Recipient kind. Use CUSTOMER (+ recipientId) to filter by customer.', enum: RECIPIENT_TYPES, example: 'CUSTOMER' })
  @IsOptional()
  @IsIn(RECIPIENT_TYPES)
  recipientType?: string;

  @ApiPropertyOptional({ description: 'Recipient id (e.g. customer UUID).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  recipientId?: string;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on `created_at`. ISO-8601.', example: '2026-06-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on `created_at`. ISO-8601.', example: '2026-07-01T00:00:00Z' })
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
