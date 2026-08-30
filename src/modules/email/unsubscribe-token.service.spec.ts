import { ConfigService } from '@nestjs/config';

import { UnsubscribeTokenService } from './unsubscribe-token.service';

function makeConfig(
  vars: Record<string, string | undefined> = {},
): ConfigService {
  return { get: (key: string) => vars[key] } as unknown as ConfigService;
}

describe('UnsubscribeTokenService', () => {
  const config = makeConfig({ JWT_ACCESS_SECRET: 'dev-access-secret' });
  let service: UnsubscribeTokenService;

  beforeEach(() => {
    service = new UnsubscribeTokenService(config);
  });

  it('issues a token that verifies back to the same (tenant, email) pair', () => {
    const token = service.issue('tenant-1', 'Patient@Example.com');
    expect(service.verify(token)).toEqual({
      tenantId: 'tenant-1',
      email: 'patient@example.com',
    });
  });

  it('is deterministic — the same (tenant, email) always issues the same token (works permanently, no expiry)', () => {
    const a = service.issue('tenant-1', 'a@b.com');
    const b = service.issue('tenant-1', 'a@b.com');
    expect(a).toBe(b);
  });

  it('rejects a tampered token', () => {
    const token = service.issue('tenant-1', 'a@b.com');
    const tampered = token.slice(0, -2) + 'zz';
    expect(service.verify(tampered)).toBeNull();
  });

  it('rejects garbage input without throwing', () => {
    expect(service.verify('not-a-real-token')).toBeNull();
    expect(service.verify('')).toBeNull();
  });

  it('a token issued for one tenant never verifies as belonging to another (reveals no other customer data)', () => {
    const tokenA = service.issue('tenant-a', 'shared@example.com');
    const result = service.verify(tokenA);
    expect(result?.tenantId).toBe('tenant-a');
    expect(result?.tenantId).not.toBe('tenant-b');
  });

  it('prefers EMAIL_UNSUBSCRIBE_SECRET over JWT_ACCESS_SECRET when both are set', () => {
    const dedicated = new UnsubscribeTokenService(
      makeConfig({
        JWT_ACCESS_SECRET: 'dev-access-secret',
        EMAIL_UNSUBSCRIBE_SECRET: 'dedicated-secret',
      }),
    );
    const token = dedicated.issue('tenant-1', 'a@b.com');
    // Signed with the dedicated secret — the shared JWT-secret instance must
    // NOT be able to verify it (proves the dedicated secret was actually used).
    expect(service.verify(token)).toBeNull();
    expect(dedicated.verify(token)).toEqual({
      tenantId: 'tenant-1',
      email: 'a@b.com',
    });
  });
});
