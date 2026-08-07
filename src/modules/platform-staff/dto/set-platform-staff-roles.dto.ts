import { ArrayMinSize, ArrayUnique, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { ROLE } from '../../../rbac/rbac.constants';
import type { RoleSlug } from '../../../rbac/rbac.constants';
import { PLATFORM_ASSIGNABLE_ROLE_SLUGS } from '../platform-staff.constants';

/**
 * Replaces the target's full platform role set. Slugs are resolved against
 * the hardcoded {@link PLATFORM_ASSIGNABLE_ROLE_SLUGS} allow-list server-side
 * — a role slug outside that list (including `super_admin`) is rejected by
 * validation before the service layer is even reached.
 */
export class SetPlatformStaffRolesDto {
  @ApiProperty({
    description: 'Full replacement set of platform role slugs.',
    enum: PLATFORM_ASSIGNABLE_ROLE_SLUGS,
    isArray: true,
    example: [ROLE.PLATFORM_SUPPORT],
  })
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(PLATFORM_ASSIGNABLE_ROLE_SLUGS, { each: true })
  roleSlugs!: RoleSlug[];
}
