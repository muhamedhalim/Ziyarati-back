import { IsBoolean, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Enables or disables a feature for the caller's tenant. Upserts the
 * (tenant, feature_key) flag.
 */
export class SetFeatureFlagDto {
  @ApiProperty({
    description:
      'Feature key to toggle. Lowercase dot/underscore notation, e.g. `appointments`, `ai.assistant`, `whatsapp`.',
    example: 'ai.assistant',
    maxLength: 100,
    pattern: '^[a-z0-9._-]+$',
  })
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9._-]+$/, {
    message: 'featureKey must be lowercase alphanumeric with . _ -',
  })
  featureKey!: string;

  @ApiProperty({
    description: 'Whether the feature is enabled for this tenant.',
    example: true,
  })
  @IsBoolean()
  isEnabled!: boolean;
}
