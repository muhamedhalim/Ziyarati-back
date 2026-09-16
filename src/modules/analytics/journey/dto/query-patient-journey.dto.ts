import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { QueryAdvancedAnalyticsDto } from '../../dto/query-advanced-analytics.dto';

/**
 * Patient Journey — shared query for both journey routes. Extends the
 * existing F11 `(from, to, branchId?)` filter with two additional,
 * aggregate-only narrowing filters. `serviceId` matches only appointments
 * whose SINGLE service is that one (a multi-service appointment cannot be
 * attributed to one service's duration — see `excluded` on the breakdown
 * response).
 */
export class QueryPatientJourneyDto extends QueryAdvancedAnalyticsDto {
  @ApiPropertyOptional({
    description: "Filter to one practitioner's appointments.",
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({
    description:
      'Filter to appointments whose only booked service is this one.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  serviceId?: string;
}
