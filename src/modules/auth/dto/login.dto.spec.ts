import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { LoginDto } from './login.dto';

const errorsFor = (payload: Record<string, unknown>) =>
  validate(plainToInstance(LoginDto, payload));

describe('LoginDto validation', () => {
  it('accepts a valid email + password (super-admin, no tenant slug)', async () => {
    expect(await errorsFor({ email: 'owner@clinic.com', password: 'pw' })).toHaveLength(0);
  });

  it('accepts an optional tenantSlug', async () => {
    expect(
      await errorsFor({ email: 'owner@clinic.com', password: 'pw', tenantSlug: 'al-noor' }),
    ).toHaveLength(0);
  });

  it('rejects a malformed email', async () => {
    const errors = await errorsFor({ email: 'not-an-email', password: 'pw' });
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('rejects a missing password', async () => {
    const errors = await errorsFor({ email: 'owner@clinic.com' });
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });
});
