import { Allow } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * PLATFORM-ONLY (super admin). Upsert a registry-defined setting by its key.
 *
 * The value is intentionally free-typed here — the service's `validateValue()`
 * method enforces the per-key type constraint (boolean / number / enum / string)
 * against the SETTINGS_REGISTRY schema. We use @Allow() purely to whitelist the
 * property against the global ValidationPipe (whitelist:true / forbidNonWhitelisted).
 */
export class UpsertTypedSettingDto {
  @ApiProperty({
    description: 'The new value for the setting. Must conform to the registry type for this key.',
    example: true,
  })
  @Allow()
  value: unknown;
}
