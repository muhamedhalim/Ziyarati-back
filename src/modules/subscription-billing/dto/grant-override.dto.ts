import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/**
 * Grant a free-access override to a tenant (super-admin only).
 *
 * Omit `durationDays` for an UNLIMITED override. The target tenant is taken from
 * the route param, never the body.
 */
export class GrantOverrideDto {
  @ApiPropertyOptional({
    description: 'Override duration in days. Omit for unlimited.',
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
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
    description: 'Extra days to extend by, measured from the later of now / current end. Omit to make it unlimited.',
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  durationDays?: number;
}
