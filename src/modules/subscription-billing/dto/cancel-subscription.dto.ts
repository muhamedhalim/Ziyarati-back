import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Cancels the caller's subscription.
 *
 * Schema note: the `subscriptions` table has no cancellation-reason column, so
 * `reason` is accepted for logging/audit only and is not persisted.
 */
export class CancelSubscriptionDto {
  @ApiPropertyOptional({
    description:
      'If true, cancel at period end (keeps access until `ends_at`, just stops auto-renew). If false/omitted, cancel immediately.',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  cancelAtPeriodEnd?: boolean;

  @ApiPropertyOptional({
    description: 'Optional cancellation reason (logged for audit; not stored on the record).',
    example: 'Switching to annual billing later.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
