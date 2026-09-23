import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { FREE_ACCESS_OVERVIEW_EXPIRING_SOON_DAYS } from '../platform-billing.constants';

/** `overview`'s lifecycle filter — `'all'` applies no filter. */
export const FREE_ACCESS_OVERVIEW_STATES = [
  'all',
  'active',
  'expiring',
  'expired',
  'revoked',
  'unlimited',
  'none',
] as const;

export type FreeAccessOverviewState =
  (typeof FREE_ACCESS_OVERVIEW_STATES)[number];

/**
 * Platform-admin filter/pagination for `GET /platform/billing/overview` — the
 * cross-clinic free-access lifecycle listing behind `/platform/feature-flags`.
 * Every field is server-validated; the client can only narrow what it sees,
 * never influence the underlying computation (see
 * `FreeAccessOverrideService.listOverview` — lifecycle, day counts and dates
 * are all computed server-side from the database clock).
 */
export class ListFreeAccessOverviewQueryDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive partial match on clinic name or slug.',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    description:
      `Lifecycle filter. \`expiring\` means ACTIVE with ` +
      `${FREE_ACCESS_OVERVIEW_EXPIRING_SOON_DAYS} or fewer days remaining — ` +
      'an admin-visibility grouping, independent of the server-side 48h ' +
      'expiry-warning notice window.',
    enum: FREE_ACCESS_OVERVIEW_STATES,
    default: 'all',
  })
  @IsOptional()
  @IsIn(FREE_ACCESS_OVERVIEW_STATES)
  state: FreeAccessOverviewState = 'all';

  @ApiPropertyOptional({
    description: 'Page number for pagination (1-based).',
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: 'Number of results per page. Maximum 100.',
    minimum: 1,
    maximum: 100,
    default: 25,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
}
