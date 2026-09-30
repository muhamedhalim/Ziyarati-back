import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { SALES_BONUS_TYPE } from '../../../entities/Sales/SalesTarget';
import type { SalesBonusType } from '../../../entities/Sales/SalesTarget';
import {
  SALES_AMOUNT_MAX,
  SALES_REASON_MAX,
} from '../platform-sales.constants';

/**
 * Body of `PUT /platform/sales/employees/:id/targets/:period/:metric`.
 *
 * The employee, month and metric come from the route. `bonusAmount` here is
 * the fixed amount of the RULE the admin configures; what an employee is
 * actually owed is always computed on the server, never sent by the client.
 *
 * Cross-field rules (currency only for revenue, bonus shape, whole-number
 * counts) are enforced in `normalizeSalesTargetRule`, where they are
 * unit-tested.
 */
export class SetSalesTargetDto {
  @ApiProperty({
    example: 25,
    description: 'Clinics / conversions (whole number) or a revenue amount.',
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(SALES_AMOUNT_MAX)
  targetValue!: number;

  @ApiPropertyOptional({
    example: 'SAR',
    description:
      'Revenue targets only. Defaults to the platform billing currency.',
  })
  @IsOptional()
  @Matches(/^[A-Za-z]{3}$/)
  currency?: string;

  @ApiPropertyOptional({ enum: SALES_BONUS_TYPE, default: 'none' })
  @IsOptional()
  @IsIn(SALES_BONUS_TYPE)
  bonusType?: SalesBonusType;

  @ApiPropertyOptional({
    example: 100,
    description: 'Percent of the target that must be reached.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  bonusThresholdPct?: number;

  @ApiPropertyOptional({ description: 'Fixed bonus amount (`fixed_on_threshold`).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  bonusAmount?: number;

  @ApiPropertyOptional({
    description: 'Percent of achieved revenue (`percent_of_achieved`).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  bonusPercent?: number;

  @ApiPropertyOptional({ example: 'SAR' })
  @IsOptional()
  @Matches(/^[A-Za-z]{3}$/)
  bonusCurrency?: string;

  @ApiPropertyOptional({
    description:
      'The `version` the caller last saw. A mismatch is a 409 instead of a silent overwrite.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;

  @ApiPropertyOptional({
    maxLength: SALES_REASON_MAX,
    description: 'Required when the month has already closed.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(SALES_REASON_MAX)
  reason?: string;
}
