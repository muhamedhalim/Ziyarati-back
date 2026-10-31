import { of } from 'rxjs';

import { PLATFORM_ADMIN_AUDIT_ACTION } from '../platform/platform-admin-audit.service';
import { SupportReadAuditInterceptor } from './support-read-audit.interceptor';

describe('SupportReadAuditInterceptor', () => {
  const ctx = (req: unknown) =>
    ({ switchToHttp: () => ({ getRequest: () => req }) }) as never;

  it('audits the read (actor, target clinic, route template only) then proceeds', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const next = { handle: jest.fn(() => of('ok')) };
    const i = new SupportReadAuditInterceptor(audit as never);
    await i.intercept(
      ctx({
        user: { id: 'u1' },
        params: { tenantId: 't1' },
        route: { path: '/platform/support/clinics/:tenantId' },
        query: { search: 'secret-phone' },
      }),
      next,
    );
    expect(audit.record).toHaveBeenCalledWith({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_CLINIC_READ,
      userId: 'u1',
      entityType: 'SupportDiagnostics',
      entityId: 't1',
      tenantId: 't1',
      after: { route: '/platform/support/clinics/:tenantId' },
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('secret-phone');
    expect(next.handle).toHaveBeenCalled();
  });
});
