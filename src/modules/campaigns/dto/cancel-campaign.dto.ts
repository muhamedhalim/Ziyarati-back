import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Cancels a campaign (status → CANCELLED).
 *
 * Schema note: the `campaigns` table has no cancellation-reason column, so
 * `reason` is accepted for audit logging only and is not persisted.
 */
export class CancelCampaignDto {
  @ApiPropertyOptional({
    description: 'Optional cancellation reason (logged for audit; not stored on the record).',
    example: 'Budget paused for the quarter.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
