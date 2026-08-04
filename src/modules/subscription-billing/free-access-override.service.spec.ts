import { DataSource } from 'typeorm';

import { FreeAccessOverrideService } from './free-access-override.service';
import { ErrorCode } from '../../common/errors';
import { PlatformAdminAuditService } from '../platform/platform-admin-audit.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'ov-1',
  tenant_id: 't1',
  granted_by: 'admin-1',
  reason: 'partner',
  starts_at: '2026-01-01T00:00:00Z',
  ends_at: null,
  status: 'ACTIVE',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: null,
  ...overrides,
});

describe('FreeAccessOverrideService', () => {
  let service: FreeAccessOverrideService;
  let query: jest.Mock;
  let audit: { record: jest.Mock };
  let tenantContext: { getUser: jest.Mock };

  beforeEach(() => {
    query = jest.fn();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    tenantContext = { getUser: jest.fn().mockReturnValue({ id: 'super-admin-1' }) };
    service = new FreeAccessOverrideService(
      { query } as unknown as DataSource,
      audit as unknown as PlatformAdminAuditService,
      tenantContext as unknown as TenantContextService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('getActive maps the active override row', async () => {
    query.mockResolvedValueOnce([row()]);
    const active = await service.getActive('t1');
    expect(active).toMatchObject({ id: 'ov-1', tenant_id: 't1', status: 'ACTIVE' });
  });

  it('hasActive is false when there is no active override', async () => {
    query.mockResolvedValueOnce([]);
    expect(await service.hasActive('t1')).toBe(false);
  });

  it('grant inserts a new override when none is active', async () => {
    query.mockResolvedValueOnce([]); // hasActive → getActive → none
    query.mockResolvedValueOnce([row()]); // INSERT RETURNING
    const granted = await service.grant('t1', { grantedBy: 'admin-1', durationDays: 30 });
    expect(granted.id).toBe('ov-1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('grant rejects when an override is already active', async () => {
    query.mockResolvedValueOnce([row()]); // hasActive → active
    await expect(service.grant('t1', {})).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('extend throws when there is no active override', async () => {
    query.mockResolvedValueOnce([]); // getActive → none
    await expect(service.extend('t1', 30)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('extend updates the active override', async () => {
    query.mockResolvedValueOnce([row()]); // getActive
    query.mockResolvedValueOnce([row({ ends_at: '2026-12-31T00:00:00Z' })]); // UPDATE RETURNING
    const res = await service.extend('t1', 30);
    expect(res.ends_at).toEqual(new Date('2026-12-31T00:00:00Z'));
  });

  it('revoke succeeds when a row was affected', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await expect(service.revoke('t1')).resolves.toEqual({ revoked: true });
  });

  it('revoke throws when nothing was active', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });
    await expect(service.revoke('t1')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  // FND-015 — grant/extend/revoke previously wrote NO audit entry.
  describe('FND-015 — audit trail', () => {
    it('audits a successful grant, tagged to the TARGET tenant (not the actor)', async () => {
      query.mockResolvedValueOnce([]); // hasActive → none
      query.mockResolvedValueOnce([row()]); // INSERT RETURNING

      await service.grant('t1', { grantedBy: 'admin-1', reason: 'partner', durationDays: 30 });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.override.grant',
          userId: 'super-admin-1',
          entityType: 'free_access_override',
          entityId: 'ov-1',
          tenantId: 't1',
          before: null,
        }),
      );
    });

    it('audits a REJECTED grant (AD-14: refusals recorded too)', async () => {
      query.mockResolvedValueOnce([row()]); // hasActive → already active

      await expect(service.grant('t1', {})).rejects.toMatchObject({ code: ErrorCode.CONFLICT });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.override.grant_rejected',
          userId: 'super-admin-1',
          entityType: 'free_access_override',
          tenantId: 't1',
        }),
      );
      // The rejection never reaches an INSERT.
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('audits a successful extend with before/after ends_at', async () => {
      query.mockResolvedValueOnce([row({ ends_at: '2026-06-30T00:00:00Z' })]); // getActive
      query.mockResolvedValueOnce([row({ ends_at: '2026-12-31T00:00:00Z' })]); // UPDATE RETURNING

      await service.extend('t1', 30);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.override.extend',
          userId: 'super-admin-1',
          entityType: 'free_access_override',
          entityId: 'ov-1',
          tenantId: 't1',
          before: { endsAt: new Date('2026-06-30T00:00:00Z') },
          after: { endsAt: new Date('2026-12-31T00:00:00Z') },
        }),
      );
    });

    it('audits a successful revoke', async () => {
      query.mockResolvedValueOnce([[{ id: 'ov-1' }], 1]);

      await service.revoke('t1');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.override.revoke',
          userId: 'super-admin-1',
          entityType: 'free_access_override',
          entityId: 'ov-1',
          tenantId: 't1',
          before: { status: 'ACTIVE' },
          after: { status: 'REVOKED' },
        }),
      );
    });
  });
});
