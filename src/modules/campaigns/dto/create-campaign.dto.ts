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
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignType } from '../../../entities/enums';
import { CAMPAIGN_CHANNEL } from '../campaign.constants';
import type { CampaignChannel } from '../campaign.constants';

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
    description:
      "WhatsApp template to use for delivery. Must belong to the caller's tenant.",
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000400',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({
    description:
      "WhatsApp account (number) this campaign sends FROM. Must belong to the caller's tenant, " +
      'and the chosen template must live on the same WhatsApp Business Account. ' +
      "Omit to use the clinic's default number at launch.",
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000500',
  })
  @IsOptional()
  @IsUUID()
  whatsappAccountId?: string;

  @ApiPropertyOptional({
    description:
      'Audience segmentation filter (JSON), e.g. `{ "tags": ["vip"], "lastVisitBeforeDays": 90 }`. Free-form, stored as JSONB.',
    type: 'object',
    additionalProperties: true,
    example: { tags: ['vip'], inactiveDays: 90 },
  })
  @IsOptional()
  @IsObject()
  segment?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Reusable rule-based audience (Phase 10, R8) — supersedes the free-form `segment` field above. ' +
      "Must belong to the caller's tenant. Resolved live at fan-out, never frozen at attach time.",
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000600',
  })
  @IsOptional()
  @IsUUID()
  segmentId?: string;

  @ApiPropertyOptional({
    description:
      'Delivery channel (Phase 11, US7). Defaults to WHATSAPP when omitted, matching every campaign created before this field existed.',
    enum: CAMPAIGN_CHANNEL,
    example: CAMPAIGN_CHANNEL.WHATSAPP,
  })
  @IsOptional()
  @IsEnum(CAMPAIGN_CHANNEL)
  channel?: CampaignChannel;

  @ApiPropertyOptional({
    description: 'Marketing email subject. Required when channel is EMAIL.',
    maxLength: 200,
  })
  @ValidateIf((o) => o.channel === CAMPAIGN_CHANNEL.EMAIL)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  email_subject?: string;

  @ApiPropertyOptional({
    description:
      'Marketing email body (plain text — HTML-escaped by the renderer, never raw HTML). Required when channel is EMAIL.',
  })
  @ValidateIf((o) => o.channel === CAMPAIGN_CHANNEL.EMAIL)
  @IsString()
  @MinLength(1)
  email_body?: string;

  @ApiPropertyOptional({
    description:
      'Optional scheduled send time (ISO-8601). Prefer the dedicated schedule endpoint; provided here it pre-fills the value while the campaign stays in DRAFT.',
    example: '2026-07-01T09:00:00+03:00',
  })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @ApiPropertyOptional({
    description:
      'Max messages dispatched per minute (rate limit). Defaults to 30.',
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
