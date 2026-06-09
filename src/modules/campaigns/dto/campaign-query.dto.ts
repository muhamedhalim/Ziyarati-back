import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignFilterDto } from './campaign-filter.dto';

/**
 * Query DTO for the campaign list endpoint: the filter set plus sorting.
 * Extends CampaignFilterDto so all filter/pagination fields are inherited.
 */
export class CampaignQueryDto extends CampaignFilterDto {
  @ApiPropertyOptional({
    description: 'Field to sort by.',
    enum: ['created_at', 'scheduled_at', 'name', 'status'],
    example: 'created_at',
    default: 'created_at',
  })
  @IsOptional()
  @IsIn(['created_at', 'scheduled_at', 'name', 'status'])
  sortBy?: 'created_at' | 'scheduled_at' | 'name' | 'status';

  @ApiPropertyOptional({
    description: 'Sort direction.',
    enum: ['ASC', 'DESC'],
    example: 'DESC',
    default: 'DESC',
  })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}
