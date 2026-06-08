import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Upgrade or downgrade the caller's current subscription to a different plan.
 * The direction (upgrade vs downgrade) is inferred from the price difference;
 * any proration is handled by the billing layer (abstracted).
 */
export class ChangePlanDto {
  @ApiProperty({
    description: 'The target plan to switch to. Must be active and different from the current plan.',
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000200',
  })
  @IsUUID()
  planId!: string;
}
