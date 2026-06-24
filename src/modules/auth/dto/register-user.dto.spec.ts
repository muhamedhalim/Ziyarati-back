import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RegisterUserDto } from './register-user.dto';
import { ROLE } from '../../../rbac/rbac.constants';

const errorsFor = (payload: Record<string, unknown>) =>
  validate(plainToInstance(RegisterUserDto, payload));

const base = {
  email: 'staff@clinic.com',
  password: 'TempPass123!',
  fullName: 'Sara Staff',
};

describe('RegisterUserDto validation', () => {
  it('accepts a valid staff payload without a role (defaults later to receptionist)', async () => {
    expect(await errorsFor(base)).toHaveLength(0);
  });

  it('accepts an assignable role (manager)', async () => {
    expect(await errorsFor({ ...base, roleSlug: ROLE.MANAGER })).toHaveLength(0);
  });

  it('rejects a privileged role (owner) — cannot be set via the staff DTO', async () => {
    const errors = await errorsFor({ ...base, roleSlug: ROLE.OWNER });
    expect(errors.some((e) => e.property === 'roleSlug')).toBe(true);
  });

  it('rejects super_admin', async () => {
    const errors = await errorsFor({ ...base, roleSlug: ROLE.SUPER_ADMIN });
    expect(errors.some((e) => e.property === 'roleSlug')).toBe(true);
  });

  it('rejects a too-short password', async () => {
    const errors = await errorsFor({ ...base, password: 'short' });
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  it('rejects a malformed email', async () => {
    const errors = await errorsFor({ ...base, email: 'nope' });
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });
});
