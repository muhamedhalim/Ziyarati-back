import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Preset windows offered by the dashboard range selector. */
export const DASHBOARD_RANGE_PRESETS = ['today', '7d', '30d', '90d'] as const;
export type DashboardRangePreset = (typeof DASHBOARD_RANGE_PRESETS)[number];

/**
 * Range for the PERIOD endpoints (`/summary`, `/activity`).
 *
 * Deliberately absent from `/snapshot`: everything that endpoint returns is
 * point-in-time, and a period-less endpoint that cannot ACCEPT a range can never
 * be accidentally filtered by one. That structural split is what keeps "142
 * clinics" from silently becoming "142 clinics in the last 7 days" when someone
 * moves the selector.
 *
 * `from`/`to` win when both are supplied; otherwise `range` applies; otherwise
 * the service falls back to the 30-day default. All boundaries are resolved to
 * UTC in the service (see `DASHBOARD_TIMEZONE`) — never in SQL.
 */
export class QueryDashboardRangeDto {
  @ApiPropertyOptional({
    enum: DASHBOARD_RANGE_PRESETS,
    description: 'Preset window. Ignored when both `from` and `to` are given.',
    example: '30d',
  })
  @IsOptional()
  @IsIn(DASHBOARD_RANGE_PRESETS as unknown as string[])
  range?: DashboardRangePreset;

  @ApiPropertyOptional({
    description: 'Custom window start (inclusive), ISO-8601.',
    example: '2026-07-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description:
      'Custom window end (EXCLUSIVE), ISO-8601. Windows are half-open so a row is never counted in two buckets.',
    example: '2026-08-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  /**
   * Rows for the activity feed. Declared HERE rather than as a standalone
   * `@Query('limit')` because the global `ValidationPipe` runs with
   * `forbidNonWhitelisted` — a parameter absent from the DTO is rejected
   * outright, so a separate decorator produces a 400 on every call.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
