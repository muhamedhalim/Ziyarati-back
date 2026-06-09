import { IsISO8601 } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** New delivery time for a (re)scheduled notification. */
export class RescheduleNotificationDto {
  @ApiProperty({
    description: 'New delivery time (ISO-8601 with offset). Resets the status to SCHEDULED.',
    example: '2026-06-16T09:30:00+03:00',
  })
  @IsISO8601()
  scheduledAt!: string;
}
