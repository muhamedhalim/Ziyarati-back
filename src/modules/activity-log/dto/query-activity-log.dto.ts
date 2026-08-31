import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  ACTIVITY_LOG_MAX_PAGE_SIZE,
  ACTIVITY_LOG_PAGE_SIZE,
  ACTIVITY_SEARCH_MIN_LENGTH,
} from '../activity-log.constants';

/**
 * Spec 014 (Clinic Platform Completion) — T193 (US14, contracts/
 * clinic-surfaces.md F14). `GET /activity`'s query params: `actorUserId?`,
 * `action?`, `branchId?`, `from?`, `to?`, `q?`, `page`, `limit`.
 *
 * Every filter is optional and every empty value is simply absent from the
 * SQL — an omitted or blank filter never contributes a predicate, so it can
 * never produce an invalid or accidentally-matching query.
 */
export class QueryActivityLogDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    example: ACTIVITY_LOG_PAGE_SIZE,
    minimum: 1,
    maximum: ACTIVITY_LOG_MAX_PAGE_SIZE,
    default: ACTIVITY_LOG_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ACTIVITY_LOG_MAX_PAGE_SIZE)
  limit: number = ACTIVITY_LOG_PAGE_SIZE;

  @ApiPropertyOptional({ description: 'Filter by acting user id.' })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({
    description:
      'Exact action from the allow-list (see GET /activity/actions).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  action?: string;

  @ApiPropertyOptional({
    description: 'ISO date/time — lower bound (inclusive).',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description: 'ISO date/time — upper bound (inclusive).',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Filter to one branch.' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  /**
   * Was already part of this surface's contract — `activity-log.e2e-spec.ts`
   * has asserted an `entityType`-filtered page since T190 — but no property
   * ever existed to accept it, so with the app's global
   * `forbidNonWhitelisted: true` every such request was rejected as 400.
   * Backed by the existing `IDX_audit_logs_tenant_entity`.
   */
  @ApiPropertyOptional({
    description: 'Filter to one resource type (e.g. `Appointment`).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityType?: string;

  @ApiPropertyOptional({
    description:
      'Free-text search, case-insensitive partial match, across the action, ' +
      'entity type, entity label, entity id, branch name, and the acting ' +
      "user's name and email. Terms shorter than " +
      ACTIVITY_SEARCH_MIN_LENGTH +
      ' characters (after trimming) are ignored rather than rejected.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  offset(): number {
    return (this.page - 1) * this.limit;
  }
}
