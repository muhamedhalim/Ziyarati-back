import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * PLATFORM-ONLY (super admin). Create a global system setting.
 *
 * `key` is unique (schema). `value` is free-form JSON (jsonb) — e.g.
 * `maintenance_mode`, `default_trial_days`, `max_file_upload_mb`,
 * `ai_default_model`. Only `key` + `value` exist on the entity; no other fields
 * are assumed.
 */
export class CreateSystemSettingDto {
  @ApiProperty({ description: 'Unique setting key.', example: 'maintenance_mode' })
  @IsString()
  @MaxLength(120)
  key!: string;

  @ApiPropertyOptional({
    description: 'Setting value (any JSON).',
    example: false,
  })
  @IsOptional()
  value?: any;
}
