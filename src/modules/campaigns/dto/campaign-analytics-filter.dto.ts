import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignLifecycle, CampaignType } from '../../../entities/enums';

/** Filter for campaign analytics / history queries (always tenant-scoped). */
export class CampaignAnalyticsFilterDto {
  @ApiPropertyOptional({ description: 'Filter by campaign lifecycle.', enum: CampaignLifecycle, example: CampaignLifecycle.ACTIVE })
  @IsOptional()
  @IsEnum(CampaignLifecycle)
  lifecycle?: CampaignLifecycle;

  @ApiPropertyOptional({ description: 'Filter by campaign type.', enum: CampaignType, example: CampaignType.PROMOTION })
  @IsOptional()
  @IsEnum(CampaignType)
  type?: CampaignType;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on `created_at`. ISO-8601.', example: '2026-01-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on `created_at`. ISO-8601.', example: '2026-12-31T23:59:59Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based) for history listing.', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page for history listing. Max 100.', example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
