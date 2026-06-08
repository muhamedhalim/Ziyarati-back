import {
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRoleDto {
  @ApiProperty({
    description: 'Human-readable display name for the role.',
    example: 'Senior Receptionist',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description:
      'URL-safe machine identifier for the role. **Immutable after creation** — referenced by application guards. Must be lowercase alphanumeric with dashes.',
    example: 'senior-receptionist',
    maxLength: 100,
    pattern: '^[a-z0-9-]+$',
  })
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must be lowercase alphanumeric with dashes',
  })
  slug!: string;

  @ApiPropertyOptional({
    description: 'Optional description explaining the purpose and scope of the role.',
    example: 'Handles VIP patient bookings and follow-ups.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description:
      'Permission slugs to attach to the role on creation. Use `GET /permissions` to discover available slugs. Can also be set later via `PUT /roles/:id/permissions`.',
    example: ['appointments.create', 'appointments.read', 'patients.read'],
    type: [String],
  })
  /** Permission slugs to grant to the role on creation. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissionSlugs?: string[];
}
