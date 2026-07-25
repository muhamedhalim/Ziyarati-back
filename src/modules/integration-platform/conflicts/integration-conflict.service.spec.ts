import { IntegrationConflictService } from './integration-conflict.service';
import { CONFLICT_RESOLUTION, CONFLICT_STATUS } from '../integration-platform.constants';
import { ErrorCode } from '../../../common/errors';

/**
 * Conditional-UPDATE double. `affected` is what the service branches on: 1 means
 * this caller won the atomic transition, 0 means someone else already did.
 */
function qbMock(affected = 1) {
  const qb: Record<string, unknown> = {};
  for (const m of ['update', 'set', 'where', 'andWhere', 'delete', 'from']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.execute = jest.fn().mockResolvedValue({ affected });
  return qb;
}

function repoMock(overrides: Partial<Record<string, jest.Mock>> = {}, affected = 1) {
  return {
    findOne: jest.fn(),
    save: jest.fn((x) => Promise.resolve({ id: 'cf1', ...x })),
    create: jest.fn((x) => x),
    findAndCount: jest.fn(),
    createQueryBuilder: jest.fn(() => qbMock(affected)),
    ...overrides,
  } as any;
}

const baseInput = {
  tenantId: 't1',
  connectionId: 'c1',
  resource: 'customer' as const,
  externalId: 'EXT-1',
  internalId: 'int-1',
  changedFields: ['full_name', 'email'],
  policy: 'reject_and_report',
  externalValues: { full_name: 'New Name', email: 'a@x.com' },
  platformValues: { full_name: 'Old Name', email: 'a@x.com' },
};

describe('IntegrationConflictService', () => {
  it('hashValues is deterministic and field-order independent', () => {
    const h1 = IntegrationConflictService.hashValues(['a', 'b'], { a: 1, b: 2 });
    const h2 = IntegrationConflictService.hashValues(['b', 'a'], { b: 2, a: 1 });
    expect(h1).toBe(h2);
    const h3 = IntegrationConflictService.hashValues(['a', 'b'], { a: 9, b: 2 });
    expect(h3).not.toBe(h1);
  });

  it('records a new pending conflict with safe hashes (no values stored)', async () => {
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(null) });
    const svc = new IntegrationConflictService(repo);
    const saved = await svc.record(baseInput);
    expect(repo.save).toHaveBeenCalled();
    const created = repo.create.mock.calls[0][0];
    expect(created.status).toBe(CONFLICT_STATUS.PENDING);
    expect(created.conflicting_fields).toEqual(['full_name', 'email']);
    expect(created.external_hash).toBeTruthy();
    expect(created.platform_hash).toBeTruthy();
    // Never stores raw values.
    expect(JSON.stringify(created)).not.toContain('New Name');
    expect(saved).toBeTruthy();
  });

  it('dedupes onto the existing pending conflict instead of inserting a duplicate', async () => {
    const existing = { id: 'cf-existing', status: CONFLICT_STATUS.PENDING };
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(existing) });
    const svc = new IntegrationConflictService(repo);
    await svc.record(baseInput);
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'cf-existing' }));
  });

  it('record never throws (best-effort) even if the repo fails', async () => {
    const repo = repoMock({ findOne: jest.fn().mockRejectedValue(new Error('db down')) });
    const svc = new IntegrationConflictService(repo);
    await expect(svc.record(baseInput)).resolves.toBeNull();
  });

  it('claim wins the atomic pending → resolving transition', async () => {
    const svc = new IntegrationConflictService(repoMock({}, 1));
    await expect(svc.claim('t1', 'cf1')).resolves.toBe(true);
  });

  it('claim LOSES when another resolver already transitioned the row', async () => {
    // 0 rows matched the conditional UPDATE — someone else got there first.
    const svc = new IntegrationConflictService(repoMock({}, 0));
    await expect(svc.claim('t1', 'cf1')).resolves.toBe(false);
  });

  it('markResolved completes a CLAIMED conflict and stamps the resolver', async () => {
    const resolved = {
      id: 'cf1',
      tenant: { id: 't1' },
      status: CONFLICT_STATUS.RESOLVED,
      resolution: CONFLICT_RESOLUTION.PLATFORM_WINS,
      resolved_by: { id: 'user-9' },
    };
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(resolved) }, 1);
    const svc = new IntegrationConflictService(repo);
    const res = await svc.markResolved('t1', 'cf1', CONFLICT_RESOLUTION.PLATFORM_WINS, 'user-9');
    expect(res.status).toBe(CONFLICT_STATUS.RESOLVED);
    expect(res.resolution).toBe(CONFLICT_RESOLUTION.PLATFORM_WINS);
    expect(res.resolved_by).toEqual({ id: 'user-9' });
  });

  it('markResolved(ignored) sets status ignored', async () => {
    const ignored = { id: 'cf1', tenant: { id: 't1' }, status: CONFLICT_STATUS.IGNORED };
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(ignored) }, 1);
    const svc = new IntegrationConflictService(repo);
    const res = await svc.markResolved('t1', 'cf1', CONFLICT_RESOLUTION.IGNORED);
    expect(res.status).toBe(CONFLICT_STATUS.IGNORED);
  });

  it('markResolved refuses when the conflict was NOT claimed by this caller (409)', async () => {
    // The conditional UPDATE matched nothing — the row is no longer `resolving`,
    // so a late/duplicate submit cannot overwrite the recorded outcome.
    const svc = new IntegrationConflictService(repoMock({}, 0));
    await expect(svc.markResolved('t1', 'cf1', CONFLICT_RESOLUTION.IGNORED)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });

  it('markStale refreshes the platform hash and counts the rejected attempt', async () => {
    const conflict = { id: 'cf1', tenant: { id: 't1' }, status: CONFLICT_STATUS.PENDING, stale_attempts: 0 };
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(conflict) });
    const svc = new IntegrationConflictService(repo);
    const res = await svc.markStale('t1', 'cf1', 'new-platform-hash');
    expect(res.status).toBe(CONFLICT_STATUS.STALE);
    expect(res.platform_hash).toBe('new-platform-hash');
    expect(res.stale_attempts).toBe(1);
  });

  it('throws NOT_FOUND for an unknown conflict', async () => {
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(null) });
    const svc = new IntegrationConflictService(repo);
    await expect(svc.getOrThrow('t1', 'nope')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
