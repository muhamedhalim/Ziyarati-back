import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

import { CONFLICT_RESOLUTION } from '../integration-platform.constants';

/**
 * Manual resolution of a persisted conflict. `platform_wins`/`ignored` need no
 * data (the platform record is kept). `external_wins` re-applies the external
 * values through the SHARED write pipeline, so the caller must re-supply `data`
 * (the values are never retained on the conflict row) — protected fields are
 * still rejected by the pipeline.
 */
export class ResolveConflictDto {
  @ApiProperty({ description: 'Chosen resolution.', enum: Object.values(CONFLICT_RESOLUTION) })
  @IsString()
  @IsIn(Object.values(CONFLICT_RESOLUTION))
  resolution!: string;

  @ApiPropertyOptional({
    description: 'Required for `external_wins`: the external values to apply (protected fields rejected).',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
