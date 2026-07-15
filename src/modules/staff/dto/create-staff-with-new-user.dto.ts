import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ROLE } from '../../../rbac/rbac.constants';
import type { RoleSlug } from '../../../rbac/rbac.constants';
import { ASSIGNABLE_STAFF_ROLES } from '../../auth/dto/register-user.dto';

/**
 * "Create new staff user" — the second Add Staff Member path. Creates the
 * User account, its role, and the StaffProfile in one atomic step (see
 * `StaffService.createWithNewUser`). No password field: the account is
 * provisioned with a system-generated temporary password, returned once in
 * the response — the admin never types or sees it beforehand.
 *
 * Tenant scoping: no `tenantId`. The tenant comes from the authenticated
 * principal, exactly like `CreateStaffDto`.
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
      'Role to assign to the new user. Only `manager` and `receptionist` are allowed — privileged roles (`owner`, `super_admin`) are blocked. Defaults to `receptionist` when omitted.',
    enum: ASSIGNABLE_STAFF_ROLES,
    example: ROLE.RECEPTIONIST,
  })
  @IsOptional()
  @IsIn(ASSIGNABLE_STAFF_ROLES)
  roleSlug?: RoleSlug;

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
    description: 'Avatar image URL (already uploaded to storage).',
    example: 'https://cdn.example.com/staff/avatar-1.png',
  })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

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
