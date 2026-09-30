import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ROLE } from '../../../rbac/rbac.constants';
import { QueryPlatformStaffDto } from './query-platform-staff.dto';

// Mirrors the global ValidationPipe in main.ts.
const check = (plain: object) => {
  const inst = plainToInstance(QueryPlatformStaffDto, plain, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(inst, { whitelist: true, forbidNonWhitelisted: true });
  return { inst, fields: errors.map((e) => e.property) };
};

describe('QueryPlatformStaffDto', () => {
  it('?isActive=false filters INACTIVE staff — it used to be coerced to true', () => {
    const { inst, fields } = check({ isActive: 'false' });
    expect(fields).toHaveLength(0);
    expect(inst.isActive).toBe(false);
  });

  it('?isActive=true filters active staff', () => {
    expect(check({ isActive: 'true' }).inst.isActive).toBe(true);
  });

  it('rejects a non-boolean isActive instead of coercing it', () => {
    expect(check({ isActive: 'yes' }).fields).toContain('isActive');
  });

  it('accepts a platform role filter and rejects anything outside the allow-list', () => {
    expect(check({ role: ROLE.PLATFORM_SALES }).fields).toHaveLength(0);
    expect(check({ role: ROLE.PLATFORM_SUPPORT }).fields).toHaveLength(0);
    expect(check({ role: ROLE.SUPER_ADMIN }).fields).toContain('role');
    expect(check({ role: ROLE.OWNER }).fields).toContain('role');
  });
});
