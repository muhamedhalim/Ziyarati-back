import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RECIPIENT_TYPES } from '../notification.constants';

/**
 * Queues a notification to be delivered at `scheduledAt`. Tenant comes from the
 * authenticated principal; referenced template/appointment are validated to
 * belong to that tenant.
 */
export class CreateScheduledNotificationDto {
  @ApiPropertyOptional({
    description: 'Template to render for this notification. Must belong to the caller\'s tenant.',
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000300',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({
    description: 'Appointment this notification relates to (enables appointment-scoped tracking). Must belong to the tenant.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000050',
  })
  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @ApiPropertyOptional({
    description: 'Recipient kind.',
    enum: RECIPIENT_TYPES,
    example: 'CUSTOMER',
  })
  @IsOptional()
  @IsIn(RECIPIENT_TYPES)
  recipientType?: string;

  @ApiPropertyOptional({
    description: 'Recipient identifier (e.g. customer UUID) — interpreted per `recipientType`.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000020',
  })
  @IsOptional()
  @IsUUID()
  recipientId?: string;

  @ApiProperty({
    description: 'When to deliver (ISO-8601 with offset). Stored as `timestamptz`.',
    example: '2026-06-15T08:00:00+03:00',
  })
  @IsISO8601()
  scheduledAt!: string;
}
