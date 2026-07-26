import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsISO8601, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

import { BILLING_UPGRADE_BILLING_PERIOD } from '../billing-upgrade.constants';

/**
 * Super-admin quote. This is the ONLY place the final price / approved
 * quantity are ever set — the owner's accept endpoint takes no financial
 * input at all, so there is nothing for the frontend to tamper with.
 */
export class QuoteBillingUpgradeRequestDto {
  @ApiPropertyOptional({
    description: 'Approved new absolute limit (usage_limit requests). Required for usage_limit, ignored for feature requests.',
    example: 5000,
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  approvedQuantity?: number;

  @ApiProperty({ description: 'Final price the owner will be charged, in MINOR currency units.', example: 15000 })
  @IsInt()
  @IsPositive()
  finalPriceMinor!: number;

  @ApiProperty({ enum: Object.values(BILLING_UPGRADE_BILLING_PERIOD) })
  @IsIn(Object.values(BILLING_UPGRADE_BILLING_PERIOD))
  billingPeriod!: string;

  @ApiProperty({ description: 'Quote expiry — ISO-8601, must be in the future.' })
  @IsISO8601()
  quoteExpiresAt!: string;

  @ApiPropertyOptional({ description: 'Internal or owner-visible notes about the quote.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
