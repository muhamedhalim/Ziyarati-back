import { ROLE } from '../../rbac/rbac.constants';
import {
  PLATFORM_ASSIGNABLE_ROLE_SLUGS,
  isPlatformAssignableRole,
} from './platform-staff.constants';

describe('PLATFORM_ASSIGNABLE_ROLE_SLUGS', () => {
  it('offers platform_support and platform_sales — and never super_admin', () => {
    expect([...PLATFORM_ASSIGNABLE_ROLE_SLUGS].sort()).toEqual([
      ROLE.PLATFORM_SALES,
      ROLE.PLATFORM_SUPPORT,
    ]);
    expect(isPlatformAssignableRole(ROLE.SUPER_ADMIN)).toBe(false);
    expect(isPlatformAssignableRole(ROLE.OWNER)).toBe(false);
  });
});
