import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ROLE } from '../../../rbac/rbac.constants';
import type { RoleSlug } from '../../../rbac/rbac.constants';

/**
 * Roles a tenant admin may assign to staff. Privileged roles (`super_admin`,
 * `owner`) are intentionally excluded and can never be set through this DTO.
 */
export const ASSIGNABLE_STAFF_ROLES: RoleSlug[] = [
  ROLE.MANAGER,
  ROLE.RECEPTIONIST,
];

/**
 * Payload for creating a staff member inside an EXISTING tenant. The tenant is
 * taken from the authenticated admin's principal, never from the body.
 */
export class RegisterUserDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsString()
  @MaxLength(255)
  fullName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  /** Defaults to `receptionist` when omitted — staff are never role-less. */
  @IsOptional()
  @IsIn(ASSIGNABLE_STAFF_ROLES)
  roleSlug?: RoleSlug;
}
