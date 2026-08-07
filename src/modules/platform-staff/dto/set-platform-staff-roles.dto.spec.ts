import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { SetPlatformStaffRolesDto } from './set-platform-staff-roles.dto';
import { ROLE } from '../../../rbac/rbac.constants';

async function errorsFor(overrides: Record<string, unknown>) {
  const dto = plainToInstance(SetPlatformStaffRolesDto, overrides);
  return validate(dto);
}

describe('SetPlatformStaffRolesDto validation', () => {
  it('accepts an allow-listed platform role', async () => {
    const errors = await errorsFor({ roleSlugs: [ROLE.PLATFORM_SUPPORT] });
    expect(errors).toHaveLength(0);
  });

  it('rejects super_admin — the escalation this DTO must prevent structurally', async () => {
    const errors = await errorsFor({ roleSlugs: [ROLE.SUPER_ADMIN] });
    expect(errors.some((e) => e.property === 'roleSlugs')).toBe(true);
  });

  it('rejects owner (a tenant role, not a platform role)', async () => {
    const errors = await errorsFor({ roleSlugs: [ROLE.OWNER] });
    expect(errors.some((e) => e.property === 'roleSlugs')).toBe(true);
  });

  it('rejects an empty array', async () => {
    const errors = await errorsFor({ roleSlugs: [] });
    expect(errors.some((e) => e.property === 'roleSlugs')).toBe(true);
  });

  it('rejects a mix of a valid and an invalid slug', async () => {
    const errors = await errorsFor({
      roleSlugs: [ROLE.PLATFORM_SUPPORT, ROLE.SUPER_ADMIN],
    });
    expect(errors.some((e) => e.property === 'roleSlugs')).toBe(true);
  });
});
