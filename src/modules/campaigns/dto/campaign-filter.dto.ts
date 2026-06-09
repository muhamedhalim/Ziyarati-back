import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignStatus, CampaignType } from '../../../entities/enums';

/** Filter + pagination for listing campaigns (always tenant-scoped). */
export class CampaignFilterDto {
  @ApiPropertyOptional({ description: 'Filter by status.', enum: CampaignStatus, example: CampaignStatus.RUNNING })
  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;

  @ApiPropertyOptional({ description: 'Filter by campaign type.', enum: CampaignType, example: CampaignType.PROMOTION })
  @IsOptional()
  @IsEnum(CampaignType)
  type?: CampaignType;

  @ApiPropertyOptional({ description: 'Case-insensitive partial match on name.', example: 'promo', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    description: 'Include archived (soft-deleted) campaigns. `true` or `false`. Defaults to false.',
    example: 'false',
  })
  @IsOptional()
  @IsBooleanString()
  includeArchived?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
