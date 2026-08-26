import { DataSource } from 'typeorm';

import { FreeAccessOverrideService } from './free-access-override.service';
import { ErrorCode } from '../../common/errors';
import { PlatformAdminAuditService } from '../platform/platform-admin-audit.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { AccessCacheService } from './access-cache.service';
import { createMockAccessCache } from '../../../test/utils/mock-factories';

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
  let accessCache: ReturnType<typeof createMockAccessCache>;

  beforeEach(() => {
    query = jest.fn();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    tenantContext = {
      getUser: jest.fn().mockReturnValue({ id: 'super-admin-1' }),
    };
    accessCache = createMockAccessCache();
    service = new FreeAccessOverrideService(
      {
        query,
        // grant/extend now run inside ONE transaction behind a per-tenant
        // advisory lock; the manager is the same query mock, so the existing
        // call-order assertions keep describing real statements.
        transaction: (cb: (m: { query: jest.Mock }) => unknown) =>
          cb({ query }),
      } as unknown as DataSource,
      audit as unknown as PlatformAdminAuditService,
      tenantContext as unknown as TenantContextService,
      accessCache as unknown as AccessCacheService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('getActive maps the active override row', async () => {
    query.mockResolvedValueOnce([row()]);
    const active = await service.getActive('t1');
    expect(active).toMatchObject({
      id: 'ov-1',
      tenant_id: 't1',
      status: 'ACTIVE',
    });
  });

  it('hasActive is false when there is no active override', async () => {
    query.mockResolvedValueOnce([]);
    expect(await service.hasActive('t1')).toBe(false);
  });

  // FND-047: `getActive`/`hasActive` are called from `AccessControlService.isEnforced`,
  // itself called from inside `UsageService.incrementIfWithinLimit` — possibly already
  // inside a caller's open transaction. A supplied manager must be used for this raw
  // query so it reuses the transaction's own connection rather than borrowing a second
  // one from the pool (the exact mechanism behind the FND-047 hang).
  describe('manager threading (FND-047)', () => {
    it('getActive queries through manager.query when a manager is supplied', async () => {
      const managerQuery = jest.fn().mockResolvedValueOnce([row()]);
      const manager = { query: managerQuery } as any;

      const active = await service.getActive('t1', manager);

      expect(active).toMatchObject({ id: 'ov-1' });
      expect(managerQuery).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    });

    it('hasActive threads the manager through to getActive', async () => {
      const managerQuery = jest.fn().mockResolvedValueOnce([]);
      const manager = { query: managerQuery } as any;

      expect(await service.hasActive('t1', manager)).toBe(false);

      expect(managerQuery).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    });

    it('falls back to the injected DataSource when no manager is supplied (standalone callers unchanged)', async () => {
      query.mockResolvedValueOnce([row()]);
      const active = await service.getActive('t1');
      expect(active).toMatchObject({ id: 'ov-1' });
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  it('grant inserts a new override when none is active', async () => {
    query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    query.mockResolvedValueOnce([]); // getActive → none
    query.mockResolvedValueOnce([row()]); // INSERT RETURNING
    const granted = await service.grant('t1', {
      grantedBy: 'admin-1',
      durationDays: 30,
    });
    expect(granted.id).toBe('ov-1');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('grant rejects when an override is already active', async () => {
    query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    query.mockResolvedValueOnce([row()]); // getActive → active
    await expect(service.grant('t1', {})).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });

  it('extend throws when there is no active override', async () => {
    query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    query.mockResolvedValueOnce([]); // getActive → none
    await expect(service.extend('t1', 30)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('extend updates the active override', async () => {
    query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
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
    await expect(service.revoke('t1')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  /**
   * Plan §16 — "caching is never allowed to extend a grant". A revoked
   * tenant-wide override that stays cached IS an extended grant, so the bust is
   * part of the revocation, not an optimisation detail.
   */
  describe('access-cache invalidation', () => {
    it('busts the tenant on grant', async () => {
      query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
      query.mockResolvedValueOnce([]); // getActive → none
      query.mockResolvedValueOnce([row()]); // INSERT RETURNING
      await service.grant('t1', { durationDays: 30 });
      expect(accessCache.invalidate).toHaveBeenCalledWith('t1');
    });

    it('busts the tenant on revoke', async () => {
      query.mockResolvedValueOnce([[{ id: 'ov-1' }], 1]);
      await service.revoke('t1');
      expect(accessCache.invalidate).toHaveBeenCalledWith('t1');
    });

    it('does NOT bust when the revoke found nothing to revoke', async () => {
      query.mockResolvedValueOnce({ rowCount: 0 });
      await expect(service.revoke('t1')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(accessCache.invalidate).not.toHaveBeenCalled();
    });
  });

  // FND-015 — grant/extend/revoke previously wrote NO audit entry.
  describe('FND-015 — audit trail', () => {
    it('audits a successful grant, tagged to the TARGET tenant (not the actor)', async () => {
      query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
      query.mockResolvedValueOnce([]); // getActive → none
      query.mockResolvedValueOnce([row()]); // INSERT RETURNING

      await service.grant('t1', {
        grantedBy: 'admin-1',
        reason: 'partner',
        durationDays: 30,
      });

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
      query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
      query.mockResolvedValueOnce([row()]); // getActive → already active

      await expect(service.grant('t1', {})).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.override.grant_rejected',
          userId: 'super-admin-1',
          entityType: 'free_access_override',
          tenantId: 't1',
        }),
      );
      // The rejection never reaches an INSERT — only the lock and the check.
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('audits a successful extend with before/after ends_at', async () => {
      query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
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
  /**
   * The duration contract, enforced HERE as well as in `GrantOverrideDto` —
   * seeds and other in-process callers never pass through a DTO, so a bound
   * that lived only in the validation layer would not actually be a bound.
   */
  describe('duration bounds', () => {
    it.each([
      ['zero', 0],
      ['negative', -1],
      ['decimal', 1.5],
      ['NaN', Number.NaN],
      ['above the 365-day maximum', 366],
      ['absurdly large', 1e9],
    ])(
      'grant refuses a %s duration before touching the database',
      async (_label, durationDays) => {
        await expect(
          service.grant('t1', { durationDays: durationDays as number }),
        ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
        expect(query).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['the 1-day minimum', 1],
      ['a mid-range 45 days', 45],
      ['the 365-day maximum', 365],
    ])('grant accepts %s', async (_label, durationDays) => {
      query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
      query.mockResolvedValueOnce([]); // getActive → none
      query.mockResolvedValueOnce([row()]); // INSERT RETURNING
      await expect(
        service.grant('t1', { durationDays: durationDays as number }),
      ).resolves.toMatchObject({ id: 'ov-1' });
    });

    it('treats an omitted duration as UNLIMITED rather than an invalid one', async () => {
      query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
      query.mockResolvedValueOnce([]); // getActive → none
      query.mockResolvedValueOnce([row({ ends_at: null })]);

      const granted = await service.grant('t1', {});

      expect(granted.ends_at).toBeNull();
      // Bound as NULL, which the INSERT's CASE turns into an open-ended grant
      // — not a zero-day one.
      expect(query.mock.calls[2][1][4]).toBeNull();
    });

    it('extend refuses an out-of-range duration too', async () => {
      await expect(service.extend('t1', 366)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
      expect(query).not.toHaveBeenCalled();
    });
  });

  /**
   * The backend owns BOTH timestamps, and they must come from ONE clock.
   * `starts_at` was already the database's `now()` while `ends_at` was computed
   * in Node from the API server's clock — so under any skew between the two
   * hosts the stored grant was not actually `startedAt + durationDays`.
   * Computing both inside a single statement makes them exact by construction:
   * `now()` is transaction time, so both occurrences in one INSERT return the
   * identical instant.
   */
  describe('server-side expiry computation', () => {
    it('derives ends_at from the same now() as starts_at, inside one statement', async () => {
      query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
      query.mockResolvedValueOnce([]); // getActive → none
      query.mockResolvedValueOnce([row()]); // INSERT RETURNING

      await service.grant('t1', { durationDays: 45 });

      const [sql, params] = query.mock.calls[2];
      expect(sql).toContain('now()');
      expect(sql).toContain('make_interval(days => $5::int)');
      // Only the DAY COUNT crosses the boundary — never a timestamp.
      expect(params[4]).toBe(45);
      expect(params.some((p: unknown) => p instanceof Date)).toBe(false);
    });

    it('extends from the later of the current end and now(), in SQL', async () => {
      query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
      query.mockResolvedValueOnce([row({ ends_at: '2026-06-30T00:00:00Z' })]);
      query.mockResolvedValueOnce([row({ ends_at: '2026-08-14T00:00:00Z' })]);

      await service.extend('t1', 45);

      const [sql, params] = query.mock.calls[2];
      expect(sql).toContain('GREATEST(ends_at, now())');
      expect(params[1]).toBe(45);
    });
  });

  /**
   * `hasActive()` then `INSERT` is a read-then-write race: two grants for one
   * clinic arriving together both saw "none active" and both inserted. The
   * lock must be taken BEFORE the check, or it protects nothing.
   */
  describe('concurrent-grant serialization', () => {
    it('takes a per-tenant advisory lock before checking for an existing grant', async () => {
      query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
      query.mockResolvedValueOnce([]); // getActive → none
      query.mockResolvedValueOnce([row()]); // INSERT RETURNING

      await service.grant('t1', { durationDays: 30 });

      const [lockSql, lockParams] = query.mock.calls[0];
      expect(lockSql).toContain('pg_advisory_xact_lock');
      // Namespaced, so it cannot collide with the migration lock; keyed on the
      // tenant, so one clinic's grant never blocks another clinic's.
      expect(lockParams[1]).toBe('t1');
      expect(query.mock.calls[1][0]).toContain(
        'SELECT * FROM free_access_overrides',
      );
      expect(query.mock.calls[2][0]).toContain(
        'INSERT INTO free_access_overrides',
      );
    });

    it('locks before the read on extend as well', async () => {
      query.mockResolvedValueOnce([]); // pg_advisory_xact_lock
      query.mockResolvedValueOnce([row()]);
      query.mockResolvedValueOnce([row()]);

      await service.extend('t1', 30);

      expect(query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    });
  });
});
