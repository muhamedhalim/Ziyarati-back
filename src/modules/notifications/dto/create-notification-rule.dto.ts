import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Creates an automation rule for the caller's tenant: when `trigger_event`
 * fires, a notification (using `template`) is scheduled `delay_minutes` after
 * (or before, via the trigger's own semantics) the event.
 */
export class CreateNotificationRuleDto {
  @ApiProperty({
    description:
      'Event that triggers the rule, e.g. `appointment.created`, `appointment.completed`, `appointment.missed`, `payment.due`, `subscription.expiring`.',
    example: 'appointment.completed',
    maxLength: 100,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  triggerEvent!: string;

  @ApiPropertyOptional({
    description: 'Template to use when the rule fires. Must belong to the caller\'s tenant.',
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000300',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({
    description:
      'Offset in minutes relative to the trigger event (e.g. 1440 = 24h reminder, 120 = review request 2h after completion). Defaults to 0 (immediate).',
    example: 120,
    minimum: 0,
    maximum: 525600,
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(525600) // up to 1 year in minutes
  delayMinutes?: number;

  @ApiPropertyOptional({
    description: 'Whether the rule is active. Defaults to true.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
