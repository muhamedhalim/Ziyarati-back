import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  SALES_ACTIVITY_OUTCOME,
  SALES_ACTIVITY_TYPE,
} from '../../../entities/Sales/SalesActivity';
import type {
  SalesActivityOutcome,
  SalesActivityType,
} from '../../../entities/Sales/SalesActivity';
import {
  SALES_ACTIVITY_NOTE_MAX,
  SALES_ACTIVITY_PROSPECT_MAX,
} from '../platform-sales.constants';
import { SalesPageQueryDto } from './sales-page-query.dto';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Body of `POST /platform/sales/employees/:id/activities`.
 *
 * The subject is EITHER a clinic on the platform (`tenantId`) OR a prospect
 * that is not on it (`prospectName`) — exactly one; the service enforces it and
 * `CHK_sales_activities_subject` backs it. The employee comes from the route,
 * and `source` / `recordedBy` are set by the server, never the client.
 */
export class CreateSalesActivityDto {
  @ApiProperty({ enum: SALES_ACTIVITY_TYPE })
  @IsIn(SALES_ACTIVITY_TYPE)
  type!: SalesActivityType;

  @ApiProperty({
    example: '2026-09-28T09:30:00.000Z',
    description: 'When it happened. Must not be in the future.',
  })
  @IsISO8601({ strict: true, strictSeparator: true })
  // A time AND an explicit zone (`Z` / `+03:00`) are required: a bare date or a zone-less
  // time would be read in the SERVER's local zone (UTC+3 on the dev host, UTC in production).
  @Matches(INSTANT, {
    message: 'occurredAt must include a time and a time zone, e.g. 2026-09-28T09:30:00Z',
  })
  occurredAt!: string;

  @ApiPropertyOptional({ description: 'A clinic on the platform.' })
  @IsOptional()
  @IsUUID('all')
  tenantId?: string;

  @ApiPropertyOptional({
    maxLength: SALES_ACTIVITY_PROSPECT_MAX,
    description: 'A prospect that is not on the platform (instead of `tenantId`).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(SALES_ACTIVITY_PROSPECT_MAX)
  prospectName?: string;

  @ApiPropertyOptional({ enum: SALES_ACTIVITY_OUTCOME })
  @IsOptional()
  @IsIn(SALES_ACTIVITY_OUTCOME)
  outcome?: SalesActivityOutcome;

  @ApiPropertyOptional({ maxLength: SALES_ACTIVITY_NOTE_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(SALES_ACTIVITY_NOTE_MAX)
  note?: string;
}

/** `GET /platform/sales/employees/:id/activities` — newest first. `from` / `to` are inclusive UTC days. */
export class QuerySalesActivitiesDto extends SalesPageQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @Matches(DAY, { message: 'from must be a date in the form YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @Matches(DAY, { message: 'to must be a date in the form YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional({ enum: SALES_ACTIVITY_TYPE })
  @IsOptional()
  @IsIn(SALES_ACTIVITY_TYPE)
  type?: SalesActivityType;

  @ApiPropertyOptional({ description: 'Only activities about this clinic.' })
  @IsOptional()
  @IsUUID('all')
  tenantId?: string;
}
