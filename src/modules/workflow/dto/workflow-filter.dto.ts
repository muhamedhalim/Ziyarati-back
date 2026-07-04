import { IsBooleanString, IsIn, IsInt, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { WORKFLOW_TRIGGERS } from '../workflow.constants';

/** List/paginate workflows, optionally filtered by trigger / active flag / name search. */
export class WorkflowFilterDto {
  @ApiPropertyOptional({ description: 'Search by name (partial, case-insensitive).', example: 'reminder' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  q?: string;

  @ApiPropertyOptional({ description: 'Filter by trigger event.', enum: WORKFLOW_TRIGGERS })
  @IsOptional()
  @IsIn(WORKFLOW_TRIGGERS)
  triggerEvent?: string;

  @ApiPropertyOptional({ description: 'Filter by active flag.', example: 'true' })
  @IsOptional()
  @IsBooleanString()
  isActive?: string;

  @ApiPropertyOptional({ description: 'Page (1-based).', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ description: 'Page size.', default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
