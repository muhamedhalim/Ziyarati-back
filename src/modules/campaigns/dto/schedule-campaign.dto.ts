import { IsISO8601 } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Schedules a campaign for future execution (status → SCHEDULED). */
export class ScheduleCampaignDto {
  @ApiProperty({
    description: 'When the campaign should start sending (ISO-8601 with offset). Must be in the future.',
    example: '2026-07-01T09:00:00+03:00',
  })
  @IsISO8601()
  scheduledAt!: string;
}
