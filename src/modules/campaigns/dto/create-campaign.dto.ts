import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignType } from '../../../entities/enums';

/**
 * Creates a campaign for the caller's tenant (starts in DRAFT). The tenant comes
 * from the authenticated principal — there is no tenantId field; referenced
 * template is validated against the tenant.
 */
export class CreateCampaignDto {
  @ApiProperty({
    description: 'Campaign type / purpose.',
    enum: CampaignType,
    example: CampaignType.PROMOTION,
  })
  @IsEnum(CampaignType)
  type!: CampaignType;

  @ApiProperty({
    description: 'Campaign display name.',
    example: 'Summer Whitening Promo',
    maxLength: 200,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({
    description: 'WhatsApp template to use for delivery. Must belong to the caller\'s tenant.',
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000400',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({
    description: 'Audience segmentation filter (JSON), e.g. `{ "tags": ["vip"], "lastVisitBeforeDays": 90 }`. Free-form, stored as JSONB.',
    type: 'object',
    additionalProperties: true,
    example: { tags: ['vip'], inactiveDays: 90 },
  })
  @IsOptional()
  @IsObject()
  segment?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Optional scheduled send time (ISO-8601). Prefer the dedicated schedule endpoint; provided here it pre-fills the value while the campaign stays in DRAFT.',
    example: '2026-07-01T09:00:00+03:00',
  })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @ApiPropertyOptional({
    description: 'Max messages dispatched per minute (rate limit). Defaults to 30.',
    example: 30,
    minimum: 1,
    maximum: 10000,
    default: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  throttlePerMinute?: number;

  @ApiPropertyOptional({
    description: 'Optional max messages per day.',
    example: 1000,
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  dailyCap?: number;

  @ApiPropertyOptional({
    description: 'Optional max messages per month.',
    example: 20000,
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  monthlyCap?: number;
}
