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
} from '../activity-log.constants';

/**
 * Spec 014 (Clinic Platform Completion) — T193 (US14, contracts/
 * clinic-surfaces.md F14). `GET /activity`'s query params: `actorUserId?`,
 * `action?`, `entityType?`, `entityId?`, `from?`, `to?`, `q?`, `page`, `limit`.
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

  @ApiPropertyOptional({ description: 'Filter by entity type.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityType?: string;

  @ApiPropertyOptional({ description: 'Filter by entity id.' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

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

  @ApiPropertyOptional({
    description: 'Free-text search over the action string only.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  offset(): number {
    return (this.page - 1) * this.limit;
  }
}
