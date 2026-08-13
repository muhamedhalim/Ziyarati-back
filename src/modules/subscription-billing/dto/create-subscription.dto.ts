import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Subscribes the CALLER'S tenant to a plan. The tenant is taken from the
 * authenticated principal — there is intentionally no tenantId field.
 */
export class CreateSubscriptionDto {
  @ApiProperty({
    description: 'The subscription plan to activate. Must be an active plan.',
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000100',
  })
  @IsUUID()
  planId!: string;

  @ApiPropertyOptional({
    description:
      'Start as a trial (status = TRIAL) instead of ACTIVE. Defaults to false.',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  startTrial?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether the subscription auto-renews at period end. Defaults to true.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;
}
