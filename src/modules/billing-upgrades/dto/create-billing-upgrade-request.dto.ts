import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsPositive, IsString, MaxLength, ValidateIf } from 'class-validator';

import { BILLING_UPGRADE_TYPE, BILLING_UPGRADE_USAGE_METRICS } from '../billing-upgrade.constants';
import type { BillingUpgradeType } from '../billing-upgrade.constants';

/**
 * Owner-submitted upgrade request. Tenant + requester are NEVER taken from
 * here — resolved from the authenticated principal (TenantContextService).
 */
export class CreateBillingUpgradeRequestDto {
  @ApiProperty({
    description: 'What kind of upgrade is being requested.',
    enum: Object.values(BILLING_UPGRADE_TYPE),
    example: BILLING_UPGRADE_TYPE.FEATURE,
  })
  @IsIn(Object.values(BILLING_UPGRADE_TYPE))
  type!: BillingUpgradeType;

  @ApiPropertyOptional({
    description: 'Required when type=feature. Must be a known feature key not already enabled for the tenant.',
  })
  @ValidateIf((o) => o.type === BILLING_UPGRADE_TYPE.FEATURE)
  @IsString()
  @MaxLength(100)
  featureKey?: string;

  @ApiPropertyOptional({
    description: 'Required when type=usage_limit. One of the metered usage metrics.',
    enum: BILLING_UPGRADE_USAGE_METRICS,
  })
  @ValidateIf((o) => o.type === BILLING_UPGRADE_TYPE.USAGE_LIMIT)
  @IsIn(BILLING_UPGRADE_USAGE_METRICS)
  usageMetric?: string;

  @ApiPropertyOptional({
    description: 'The new absolute limit requested (usage_limit requests only) — must exceed the current plan limit.',
    example: 5000,
  })
  @ValidateIf((o) => o.type === BILLING_UPGRADE_TYPE.USAGE_LIMIT)
  @IsInt()
  @IsPositive()
  requestedQuantity?: number;

  @ApiPropertyOptional({ description: 'Optional note explaining why the upgrade is needed.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
