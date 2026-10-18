import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { TenantTargetType } from '../../../entities/SaaS-Core/TenantTarget';

export const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_MSG = 'month must be in YYYY-MM format';

/** `GET /tenants/me/targets` — both filters optional (current month, all branches). */
export class TargetProgressQueryDto {
  @ApiPropertyOptional({
    example: '2026-10',
    description: 'UTC calendar month, YYYY-MM. Defaults to the current month.',
  })
  @IsOptional()
  @Matches(MONTH_REGEX, { message: MONTH_MSG })
  month?: string;

  @ApiPropertyOptional({
    description: 'Branch to scope to. Omit for all branches.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** `GET /tenants/me/targets/history` */
export class TargetHistoryQueryDto {
  @ApiPropertyOptional({ enum: TenantTargetType })
  @IsEnum(TenantTargetType)
  type!: TenantTargetType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    example: '2026-10',
    description: 'Restrict to one month.',
  })
  @IsOptional()
  @Matches(MONTH_REGEX, { message: MONTH_MSG })
  month?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @ApiPropertyOptional({ default: 12, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** `GET /tenants/me/targets/changes` — the edit ledger of ONE scope/month/type. */
export class TargetChangesQueryDto {
  @ApiPropertyOptional({ enum: TenantTargetType })
  @IsEnum(TenantTargetType)
  type!: TenantTargetType;

  @ApiPropertyOptional({ example: '2026-10' })
  @Matches(MONTH_REGEX, { message: MONTH_MSG })
  month!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/**
 * `PATCH /tenants/me/targets`. Explicit allow-list: tenant, actor, original
 * value and timestamps are never accepted from the body.
 */
export class UpdateTenantTargetsDto {
  @ApiPropertyOptional({
    example: '2026-10',
    description:
      'Target month (YYYY-MM). Defaults to the current month; past months are rejected.',
  })
  @IsOptional()
  @Matches(MONTH_REGEX, { message: MONTH_MSG })
  month?: string;

  @ApiPropertyOptional({
    description:
      'Branch this target belongs to. Omit for the clinic-wide target.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100_000, example: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  appointmentTarget?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100_000_000, example: 50000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000_000)
  revenueTarget?: number;
}
