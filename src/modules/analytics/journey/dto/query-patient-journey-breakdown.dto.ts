import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { QueryPatientJourneyDto } from './query-patient-journey.dto';
import {
  JOURNEY_BREAKDOWN_SORTS,
  JOURNEY_DIMENSIONS,
} from '../journey.constants';

/** Plan §13. Pagination mirrors `QueryAdvancedAnalyticsPageDto` (limit ≤ 100). */
export class QueryPatientJourneyBreakdownDto extends QueryPatientJourneyDto {
  @ApiPropertyOptional({
    description: 'Which dimension to break down by.',
    enum: JOURNEY_DIMENSIONS,
  })
  @IsIn(JOURNEY_DIMENSIONS)
  dimension!: (typeof JOURNEY_DIMENSIONS)[number];

  @ApiPropertyOptional({
    description: 'Sort key for the returned rows.',
    enum: JOURNEY_BREAKDOWN_SORTS,
    default: 'appointments',
  })
  @IsOptional()
  @IsIn(JOURNEY_BREAKDOWN_SORTS)
  sort: (typeof JOURNEY_BREAKDOWN_SORTS)[number] = 'appointments';

  @ApiPropertyOptional({
    description: 'Page number (1-based).',
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: 'Results per page. Max 100.',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
