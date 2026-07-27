import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { CUSTOM_ROLE_SENTINEL, ROLE } from '../../../rbac/rbac.constants';

/**
 * Updates mutable profile fields. `userId` is immutable (a profile is bound to
 * one user for life). Use the activate/deactivate endpoints for booking
 * availability toggling, though `isAvailableForBooking` is also accepted here.
 *
 * `roleSlug`/`permissionSlugs` are optional and independent of the profile
 * fields above: omit both to leave the account's role untouched. Changing the
 * role additionally requires `staff.manage` (checked in the service, not just
 * the controller-level `staff.update` guard) — see `StaffService.update`.
 */
export class UpdateStaffDto {
  @ApiPropertyOptional({ description: 'Professional title.', example: 'Lead Physiotherapist', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ description: 'Biography / profile description.', example: 'Specialises in sports rehabilitation.' })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiPropertyOptional({
    description:
      'Storage key of a new/replacement avatar from `POST /uploads` (docType `staff-avatar`), or `null` to remove the current avatar. Omit entirely to leave it unchanged.',
    example: 'a1b2c3d4-0000-.../staff-avatar/8c2e0000-....jpg',
    maxLength: 1024,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(1024)
  avatarStorageKey?: string | null;

  @ApiPropertyOptional({
    description: 'Post-appointment buffer in minutes.',
    example: 15,
    minimum: 0,
    maximum: 240,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  bookingBufferMinutes?: number;

  @ApiPropertyOptional({
    description: 'Whether the staff member is currently bookable. Prefer the activate/deactivate endpoints for clarity.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isAvailableForBooking?: boolean;

  @ApiPropertyOptional({
    description:
      `Slug of the role to (re)assign — any of the tenant's own custom roles or a shared system role, fetched from \`GET /staff/assignable-roles\`. Omit entirely to leave the account's role unchanged. Pass the reserved value \`"${CUSTOM_ROLE_SENTINEL}"\` to synthesize/update a tenant-scoped custom role from \`permissionSlugs\` instead. Requires \`staff.manage\`; founding/platform/non-staff roles are rejected server-side regardless of what is sent.`,
    example: ROLE.RECEPTIONIST,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  roleSlug?: string;

  @ApiPropertyOptional({
    description:
      `Permission slugs to grant, used ONLY when \`roleSlug\` is \`"${CUSTOM_ROLE_SENTINEL}"\`. Every slug must already be a permission the CALLER holds. Must be non-empty when \`roleSlug\` is \`"${CUSTOM_ROLE_SENTINEL}"\`.`,
    example: ['appointments.read', 'customers.read'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissionSlugs?: string[];
}
