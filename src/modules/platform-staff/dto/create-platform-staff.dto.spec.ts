import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreatePlatformStaffDto } from './create-platform-staff.dto';
import { ROLE } from '../../../rbac/rbac.constants';

const VALID = {
  email: 'agent@ziyaratech.com',
  fullName: 'Support Agent',
  roleSlug: ROLE.PLATFORM_SUPPORT,
};

async function errorsFor(overrides: Record<string, unknown>) {
  const dto = plainToInstance(CreatePlatformStaffDto, {
    ...VALID,
    ...overrides,
  });
  return validate(dto);
}

describe('CreatePlatformStaffDto validation', () => {
  it('accepts a fully valid payload', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it('rejects super_admin as roleSlug', async () => {
    const errors = await errorsFor({ roleSlug: ROLE.SUPER_ADMIN });
    expect(errors.some((e) => e.property === 'roleSlug')).toBe(true);
  });

  it('rejects a tenant staff role (receptionist) — this DTO only accepts platform roles', async () => {
    const errors = await errorsFor({ roleSlug: ROLE.RECEPTIONIST });
    expect(errors.some((e) => e.property === 'roleSlug')).toBe(true);
  });

  it('rejects an invalid email', async () => {
    const errors = await errorsFor({ email: 'not-an-email' });
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('rejects a missing fullName', async () => {
    const dto = plainToInstance(CreatePlatformStaffDto, {
      ...VALID,
      fullName: undefined,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'fullName')).toBe(true);
  });

  it('has no password field — a spoofed one is stripped by the app-wide whitelist config', async () => {
    const dto = plainToInstance(CreatePlatformStaffDto, {
      ...VALID,
      password: 'ForcedPass123!',
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });
});
