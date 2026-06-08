import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePermissionDto {
  @ApiProperty({
    description: 'Human-readable display name for the permission.',
    example: 'Create Appointments',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description:
      'Unique machine identifier using dot-notation. **Immutable after creation** — referenced by `@RequirePermissions()` guards throughout the codebase. Changing a slug silently breaks RBAC.',
    example: 'appointments.create',
    maxLength: 100,
    pattern: '^[a-z0-9:._-]+$',
  })
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9:._-]+$/, {
    message: 'slug must be lowercase (e.g. "appointments:create")',
  })
  slug!: string;

  @ApiPropertyOptional({
    description:
      'Logical domain grouping for display and filtering in the Swagger UI and admin dashboards. Examples: `appointments`, `reports`, `users`, `billing`, `patients`.',
    example: 'appointments',
    maxLength: 100,
  })
  /** Logical grouping, e.g. "appointments", "payments". */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  module?: string;
}
