import { IntegrationConflictResolutionService } from './integration-conflict-resolution.service';
import { IntegrationConflictService } from './integration-conflict.service';
import { CONFLICT_STATUS, CONFLICT_RESOLUTION } from '../integration-platform.constants';
import { ErrorCode } from '../../../common/errors';

/**
 * Conflict resolution must be safe under CONCURRENCY. The two failure modes that
 * matter: two admins applying competing outcomes, and one admin applying a
 * snapshot after the platform record has already moved on.
 */

const CHANGED = ['full_name'];

function conflictRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cf-1',
    resource_type: 'customer',
    external_id: 'EXT-1',
    internal_resource_id: 'int-1',
    conflicting_fields: CHANGED,
    platform_hash: IntegrationConflictService.hashValues(CHANGED, { full_name: 'Original' }),
    external_hash: IntegrationConflictService.hashValues(CHANGED, { full_name: 'External' }),
    policy: 'reject_and_report',
    reason: 'field_divergence',
    status: CONFLICT_STATUS.PENDING,
    connection: { id: 'c1' },
    ...over,
  };
}

function build(opts: {
  conflict?: Record<string, unknown>;
  claimed?: boolean;
  currentView?: Record<string, unknown> | null;
} = {}) {
  const conflict = opts.conflict ?? conflictRow();
  const conflicts = {
    getOrThrow: jest.fn(async () => conflict),
    claim: jest.fn(async () => opts.claimed ?? true),
    release: jest.fn(async () => undefined),
    markStale: jest.fn(async () => ({ ...conflict, status: CONFLICT_STATUS.STALE })),
    markResolved: jest.fn(async () => ({ ...conflict, status: CONFLICT_STATUS.RESOLVED })),
  };
  const upsert = {
    upsertOne: jest.fn(async () => ({ outcome: 'updated', externalId: 'EXT-1', internalId: 'int-1' })),
    currentViewOf: jest.fn(async () =>
      opts.currentView === undefined ? { full_name: 'Original' } : opts.currentView,
    ),
  };
  const audit = { record: jest.fn(async (..._a: unknown[]) => undefined) as jest.Mock };
  const svc = new IntegrationConflictResolutionService(
    conflicts as never,
    { requireActive: jest.fn(async () => ({ id: 'c1' })) } as never,
    upsert as never,
    { resolveActorUserId: jest.fn(async () => 'u1') } as never,
    audit as never,
  );
  return { svc, conflicts, upsert, audit };
}

describe('conflict resolution — concurrency safety', () => {
  const actor = { userId: 'u1', ip: '1.2.3.4' };

  it('claims the conflict atomically before doing anything', async () => {
    const { svc, conflicts } = build();
    await svc.resolve('t1', 'cf-1', { resolution: CONFLICT_RESOLUTION.PLATFORM_WINS } as never, actor);
    expect(conflicts.claim).toHaveBeenCalledWith('t1', 'cf-1');
  });

  it('refuses when another resolver already holds the claim (409)', async () => {
    const { svc, upsert } = build({ claimed: false });
    await expect(
      svc.resolve('t1', 'cf-1', { resolution: CONFLICT_RESOLUTION.EXTERNAL_WINS, data: { full_name: 'X' } } as never, actor),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    // Critically: nothing was applied by the loser.
    expect(upsert.upsertOne).not.toHaveBeenCalled();
  });

  it('refuses to re-resolve an already-resolved conflict', async () => {
    const { svc, conflicts } = build({ conflict: conflictRow({ status: CONFLICT_STATUS.RESOLVED }) });
    await expect(
      svc.resolve('t1', 'cf-1', { resolution: CONFLICT_RESOLUTION.PLATFORM_WINS } as never, actor),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    expect(conflicts.claim).not.toHaveBeenCalled();
  });

  it('applies external data when the record is UNCHANGED since the conflict', async () => {
    const { svc, upsert, conflicts } = build();
    await svc.resolve(
      't1', 'cf-1',
      { resolution: CONFLICT_RESOLUTION.EXTERNAL_WINS, data: { full_name: 'External' } } as never,
      actor,
    );
    expect(upsert.upsertOne).toHaveBeenCalled();
    expect(conflicts.markResolved).toHaveBeenCalled();
  });

  it('REFUSES to apply stale external data when the record has since changed', async () => {
    // Someone edited the customer after the conflict was raised.
    const { svc, upsert, conflicts } = build({ currentView: { full_name: 'Edited Since' } });
    await expect(
      svc.resolve(
        't1', 'cf-1',
        { resolution: CONFLICT_RESOLUTION.EXTERNAL_WINS, data: { full_name: 'External' } } as never,
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });

    expect(upsert.upsertOne).not.toHaveBeenCalled(); // the newer edit is not overwritten
    expect(conflicts.markStale).toHaveBeenCalled(); // refreshed, not discarded
    expect(conflicts.markResolved).not.toHaveBeenCalled();
  });

  it('marks stale (not resolved) when the internal record was deleted', async () => {
    const { svc, conflicts, upsert } = build({ currentView: null });
    await expect(
      svc.resolve(
        't1', 'cf-1',
        { resolution: CONFLICT_RESOLUTION.EXTERNAL_WINS, data: { full_name: 'External' } } as never,
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(conflicts.markStale).toHaveBeenCalledWith('t1', 'cf-1', null);
    expect(upsert.upsertOne).not.toHaveBeenCalled();
  });

  it('audits a stale/rejected attempt with its previous status', async () => {
    const { svc, audit } = build({ currentView: { full_name: 'Edited Since' } });
    await svc
      .resolve('t1', 'cf-1', { resolution: CONFLICT_RESOLUTION.EXTERNAL_WINS, data: { full_name: 'X' } } as never, actor)
      .catch(() => undefined);
    const stale = audit.record.mock.calls.find((c) => String(c[0]).includes('stale'));
    expect(stale).toBeDefined();
    expect(stale?.[5]).toMatchObject({ previousStatus: CONFLICT_STATUS.PENDING, rejected: true });
  });

  it('audits a successful resolution with who, policy, previous status and result', async () => {
    const { svc, audit } = build();
    await svc.resolve('t1', 'cf-1', { resolution: CONFLICT_RESOLUTION.PLATFORM_WINS } as never, actor);
    const resolved = audit.record.mock.calls.find((c) => String(c[0]).includes('resolve'));
    expect(resolved?.[4]).toMatchObject({ userId: 'u1' });
    expect(resolved?.[5]).toMatchObject({
      previousStatus: CONFLICT_STATUS.PENDING,
      resolution: CONFLICT_RESOLUTION.PLATFORM_WINS,
      policy: 'reject_and_report',
    });
  });

  it('releases the claim when applying fails, so it is never stuck in `resolving`', async () => {
    const { svc, conflicts, upsert } = build();
    upsert.upsertOne.mockRejectedValueOnce(new Error('domain rejected'));
    await expect(
      svc.resolve('t1', 'cf-1', { resolution: CONFLICT_RESOLUTION.EXTERNAL_WINS, data: { full_name: 'X' } } as never, actor),
    ).rejects.toThrow();
    expect(conflicts.release).toHaveBeenCalledWith('t1', 'cf-1');
  });

  it('requires `data` for external_wins, and releases the claim without it', async () => {
    const { svc, conflicts } = build();
    await expect(
      svc.resolve('t1', 'cf-1', { resolution: CONFLICT_RESOLUTION.EXTERNAL_WINS } as never, actor),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(conflicts.release).toHaveBeenCalled();
  });

  it('allows resolving a STALE conflict once it has been re-reviewed', async () => {
    const { svc, conflicts } = build({ conflict: conflictRow({ status: CONFLICT_STATUS.STALE }) });
    await svc.resolve('t1', 'cf-1', { resolution: CONFLICT_RESOLUTION.PLATFORM_WINS } as never, actor);
    expect(conflicts.claim).toHaveBeenCalled();
    expect(conflicts.markResolved).toHaveBeenCalled();
  });
});

describe('conflict hashing — safe comparison without values', () => {
  it('produces the same hash for equal values and a different one otherwise', () => {
    const a = IntegrationConflictService.hashValues(['x'], { x: 'same' });
    const b = IntegrationConflictService.hashValues(['x'], { x: 'same' });
    const c = IntegrationConflictService.hashValues(['x'], { x: 'different' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('never contains the value itself', () => {
    const secret = 'Patient-Identifiable-Value';
    expect(IntegrationConflictService.hashValues(['x'], { x: secret })).not.toContain(secret);
  });

  it('is field-order independent', () => {
    const a = IntegrationConflictService.hashValues(['a', 'b'], { a: '1', b: '2' });
    const b = IntegrationConflictService.hashValues(['b', 'a'], { a: '1', b: '2' });
    expect(a).toBe(b);
  });
});
