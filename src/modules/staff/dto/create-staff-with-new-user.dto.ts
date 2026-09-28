import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CUSTOM_ROLE_SENTINEL, ROLE } from '../../../rbac/rbac.constants';

/**
 * "Create new staff user" — the Add Staff Member path. Creates the
 * User account, its role, and the StaffProfile in one atomic step (see
 * `StaffService.createWithNewUser`). No password field: the account is
 * provisioned with a system-generated temporary password, returned once in
 * the response — the admin never types or sees it beforehand.
 *
 * Tenant scoping: no `tenantId`. The tenant comes from the authenticated
 * principal.
 */
export class CreateStaffWithNewUserDto {
  // ── Account ──────────────────────────────────────────────────────────── //

  @ApiProperty({
    description: 'Email address for the new staff member. Must be unique within the clinic.',
    example: 'receptionist@al-noor.com',
    format: 'email',
    maxLength: 255,
  })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    description: 'Full display name of the staff member.',
    example: 'Sara Al-Amin',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  fullName!: string;

  @ApiPropertyOptional({
    description: 'Contact phone number.',
    example: '+966509876543',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({
    description:
      'Slug of the role to assign — any of the tenant\'s own custom roles or a shared system role, fetched from `GET /staff/assignable-roles`. Founding/platform roles (`owner`, `super_admin`) and non-staff system roles (`customer`, `ai-bot`) are rejected, re-validated server-side regardless of what the client sends. Defaults to `receptionist` when omitted. Pass the reserved value `"other"` to synthesize a tenant-scoped custom role from `permissionSlugs` instead (see below).',
    example: ROLE.RECEPTIONIST,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  roleSlug?: string;

  @ApiPropertyOptional({
    description:
      `Permission slugs to grant, used ONLY when \`roleSlug\` is \`"${CUSTOM_ROLE_SENTINEL}"\`. A tenant-scoped custom role carrying exactly this set is created and assigned. Every slug must already be a permission the CALLER holds — requesting one they don't hold is rejected (privilege-escalation guard). Must be non-empty when \`roleSlug\` is \`"${CUSTOM_ROLE_SENTINEL}"\`. Discover selectable slugs via \`GET /staff/assignable-permissions\` (already scoped to what the caller may grant).`,
    example: ['appointments.read', 'customers.read'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissionSlugs?: string[];

  // ── Professional profile ─────────────────────────────────────────────── //

  @ApiProperty({
    description: 'Professional title shown to customers.',
    example: 'Senior Dermatologist',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional({
    description: 'Short biography / profile description.',
    example: '10+ years of experience in cosmetic dermatology.',
  })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiPropertyOptional({
    description:
      'Storage key of an avatar already uploaded via `POST /uploads` (docType `staff-avatar`) — not a URL.',
    example: 'a1b2c3d4-0000-.../staff-avatar/8c2e0000-....jpg',
    maxLength: 1024,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  avatarStorageKey?: string;

  // ── Booking settings ─────────────────────────────────────────────────── //

  @ApiPropertyOptional({
    description: 'Whether the staff member is bookable immediately. Defaults to true.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isAvailableForBooking?: boolean;

  @ApiPropertyOptional({
    description:
      'Buffer (in minutes) reserved after each appointment for this staff member before the next booking. Defaults to 0.',
    example: 10,
    minimum: 0,
    maximum: 240,
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  bookingBufferMinutes?: number;

  @ApiPropertyOptional({
    description: 'Branches (same clinic) to assign the staff member to. Omit on single-branch clinics.',
    type: [String],
    format: 'uuid',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  branchIds?: string[];

  @ApiPropertyOptional({
    description: 'Primary branch — must be one of `branchIds`.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  primaryBranchId?: string;
}
