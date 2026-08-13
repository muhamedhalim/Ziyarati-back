import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import { BillingCycle } from '../../../entities/enums';

/**
 * Create a subscription plan (super-admin only).
 *
 * Limit fields are optional — an omitted/null limit means UNLIMITED for that
 * resource, which is how Free and Custom/enterprise plans are expressed. A FREE
 * plan is simply `price: 0`; a TRIAL is started per-subscription, not per-plan.
 */
export class CreatePlanDto {
  @ApiProperty({ example: 'Professional' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description: 'Price in major units. 0 = free plan.',
    example: 299,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @ApiProperty({ enum: BillingCycle, example: BillingCycle.MONTHLY })
  @IsEnum(BillingCycle)
  billingCycle!: BillingCycle;

  @ApiPropertyOptional({ description: 'Max branches (null = unlimited).' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxBranches?: number;

  @ApiPropertyOptional({ description: 'Max users (null = unlimited).' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxUsers?: number;

  @ApiPropertyOptional({
    description: 'Max AI tokens / month (null = unlimited).',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxAiTokens?: number;

  @ApiPropertyOptional({
    description: 'Max WhatsApp messages / month (null = unlimited).',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxWhatsappMessages?: number;

  @ApiPropertyOptional({
    description: 'Max appointments / month (null = unlimited).',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxAppointments?: number;

  @ApiPropertyOptional({
    description: 'Max campaigns / month (null = unlimited).',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxCampaigns?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Custom/bespoke plan flag.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isCustom?: boolean;
}

/**
 * Update a plan. On a plan that already has active subscribers, only `name` and
 * `isActive` are honoured — economic terms are immutable (422) to protect
 * existing subscriptions; create a new plan instead.
 */
export class UpdatePlanDto extends PartialType(CreatePlanDto) {}
