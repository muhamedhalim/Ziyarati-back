import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
} from 'class-validator';

import {
  FREE_ACCESS_MAX_DURATION_DAYS,
  FREE_ACCESS_MIN_DURATION_DAYS,
} from '../platform-billing.constants';

/**
 * Grant a free-access override to a tenant (super-admin only).
 *
 * Omit `durationDays` for an UNLIMITED override. The target tenant is taken from
 * the route param, never the body.
 *
 * `durationDays` is the ONLY thing a client may say about timing: both
 * timestamps are computed server-side from the database's own clock, so a
 * caller cannot back-date `starts_at` or push `ends_at` out. The global pipe
 * runs with `forbidNonWhitelisted`, so smuggling `endsAt`/`startsAt`/`tenantId`
 * into the body is a 400 rather than a silently ignored field.
 *
 * `@IsInt` (with the pipe's `enableImplicitConversion`) is what rejects `0.5`,
 * `"abc"` → NaN and `null`; `@Min`/`@Max` reject `0`, `-1` and anything past a
 * year. Validation lives here AND in the service — see
 * {@link FREE_ACCESS_MIN_DURATION_DAYS}.
 */
export class GrantOverrideDto {
  @ApiPropertyOptional({
    description: `Override duration in days (${FREE_ACCESS_MIN_DURATION_DAYS}–${FREE_ACCESS_MAX_DURATION_DAYS}). Omit for unlimited.`,
    minimum: FREE_ACCESS_MIN_DURATION_DAYS,
    maximum: FREE_ACCESS_MAX_DURATION_DAYS,
    example: 45,
  })
  @IsOptional()
  @IsInt()
  @Min(FREE_ACCESS_MIN_DURATION_DAYS)
  @Max(FREE_ACCESS_MAX_DURATION_DAYS)
  durationDays?: number;

  @ApiPropertyOptional({ description: 'Why the override was granted (audit).' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Extend (or make unlimited) a tenant's active override. */
export class ExtendOverrideDto {
  @ApiPropertyOptional({
    description:
      `Extra days to extend by (${FREE_ACCESS_MIN_DURATION_DAYS}–${FREE_ACCESS_MAX_DURATION_DAYS}), measured from the later of now / current end. ` +
      'Omit to make it unlimited.',
    minimum: FREE_ACCESS_MIN_DURATION_DAYS,
    maximum: FREE_ACCESS_MAX_DURATION_DAYS,
    example: 45,
  })
  @IsOptional()
  @IsInt()
  @Min(FREE_ACCESS_MIN_DURATION_DAYS)
  @Max(FREE_ACCESS_MAX_DURATION_DAYS)
  durationDays?: number;
}
