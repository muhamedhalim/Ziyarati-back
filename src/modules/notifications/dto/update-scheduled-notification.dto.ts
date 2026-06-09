import { PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateScheduledNotificationDto } from './create-scheduled-notification.dto';
import { NOTIFICATION_STATUSES } from '../notification.constants';

/**
 * Generic update of a scheduled notification (recipient, schedule time, etc.).
 * Lifecycle changes should prefer the dedicated cancel/reschedule/retry
 * endpoints; `status` is accepted here for administrative correction only and
 * is validated against the allowed status set.
 */
export class UpdateScheduledNotificationDto extends PartialType(
  CreateScheduledNotificationDto,
) {
  @ApiPropertyOptional({
    description: 'Override the status (administrative). Must be a valid lifecycle status.',
    enum: NOTIFICATION_STATUSES,
    example: 'SCHEDULED',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_STATUSES)
  status?: string;
}
