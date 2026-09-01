import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ROLE } from '../../../rbac/rbac.constants';
import type { RoleSlug } from '../../../rbac/rbac.constants';

/**
 * Roles a tenant admin may assign to staff. Privileged roles (`super_admin`,
 * `owner`) are intentionally excluded and can never be set through this DTO.
 * `manager` ("Operations Manager") was retired from this list — it is no
 * longer offered for new staff, superseded by `branch_manager` on the
 * current staff-creation flow; existing `manager` accounts are unaffected.
 */
export const ASSIGNABLE_STAFF_ROLES: RoleSlug[] = [ROLE.RECEPTIONIST];

/**
 * Payload for creating a staff member inside an EXISTING tenant. The tenant is
 * taken from the authenticated admin's principal, never from the body.
 */
export class RegisterUserDto {
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
    description: 'Initial password for the account. Minimum 8 characters, maximum 72.',
    example: 'TempPass123!',
    minLength: 8,
    maxLength: 72,
    format: 'password',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

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
      'Role to assign to the new user. Only `receptionist` is allowed — privileged roles (`owner`, `super_admin`) are blocked, and `manager` is retired from this endpoint. Defaults to `receptionist` when omitted.',
    enum: ASSIGNABLE_STAFF_ROLES,
    example: ROLE.RECEPTIONIST,
  })
  /** Defaults to `receptionist` when omitted — staff are never role-less. */
  @IsOptional()
  @IsIn(ASSIGNABLE_STAFF_ROLES)
  roleSlug?: RoleSlug;
}
