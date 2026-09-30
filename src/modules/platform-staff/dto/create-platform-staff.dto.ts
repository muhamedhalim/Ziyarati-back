import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ROLE } from '../../../rbac/rbac.constants';
import type { RoleSlug } from '../../../rbac/rbac.constants';
import { PLATFORM_ASSIGNABLE_ROLE_SLUGS } from '../platform-staff.constants';

/**
 * Invites a new platform staff member (tenantId = NULL). No password field —
 * provisioning is invitation-only: a single-use set-password link is emailed,
 * the same infrastructure `StaffAccessService` uses for clinic staff.
 */
export class CreatePlatformStaffDto {
  @ApiProperty({
    description:
      'Email address for the new platform staff member. Must be globally unique (D7).',
    example: 'support-agent@ziyaratech.com',
    format: 'email',
    maxLength: 255,
  })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    description: 'Full display name of the platform staff member.',
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

  @ApiProperty({
    description:
      'Platform role to assign. Only roles in the platform allow-list are accepted.',
    enum: PLATFORM_ASSIGNABLE_ROLE_SLUGS,
    example: ROLE.PLATFORM_SUPPORT,
  })
  @IsIn(PLATFORM_ASSIGNABLE_ROLE_SLUGS)
  roleSlug!: RoleSlug;

  @ApiPropertyOptional({
    description:
      'Email the set-password invitation now. Defaults to true. Pass false to provision the account without a login (e.g. a sales employee who needs no access yet); the invitation can be sent later with `resend-invitation`.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  sendInvitation?: boolean;
}
