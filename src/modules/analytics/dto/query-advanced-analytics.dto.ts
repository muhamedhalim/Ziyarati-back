import { IsOptional, IsUUID, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Spec 014 (Clinic Platform Completion) — T146 (US11, contracts/clinic-
 * surfaces.md §F11). The shared `(from, to, branchId?)` filter every
 * advanced-analytics route accepts. `from`/`to` are REQUIRED and bounded
 * (see `MAX_ADVANCED_ANALYTICS_RANGE_DAYS`) — unlike the existing
 * daily/monthly report filters, which default to a trailing window, F11
 * requires the applied filters to always be explicit and visible on screen
 * (FR-A015).
 */
export class QueryAdvancedAnalyticsDto {
  @ApiPropertyOptional({
    description:
      "Filter by branch. Forced to the caller's own branch for a branch-restricted caller.",
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'From day (YYYY-MM-DD, inclusive). Required.',
    example: '2026-06-01',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @ApiPropertyOptional({
    description: 'To day (YYYY-MM-DD, inclusive). Required.',
    example: '2026-06-30',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to!: string;
}
