import { IntegrationSyncService } from './integration-sync.service';
import { JOB_STATUS, SYNC_DIRECTION, UPSERT_OUTCOME } from '../integration-platform.constants';
import { ErrorCode } from '../../../common/errors';

// Simulate a Postgres unique-violation the partial index would raise.
class PgUnique extends Error {
  code = '23505';
}
jest.mock('../../../common/errors', () => {
  const actual = jest.requireActual('../../../common/errors');
  return { ...actual, isUniqueViolation: (e: any) => e?.code === '23505' };
});

function jobsRepoMock(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn((x) => Promise.resolve({ id: x.id ?? 'sync-1', ...x })),
    update: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    ...over,
  } as any;
}
const connMock = (over: Partial<Record<string, jest.Mock>> = {}) => ({
  requireActive: jest.fn().mockResolvedValue({ id: 'c1', sync_direction: 'bidirectional' }),
  conflictPolicyOf: jest.fn().mockReturnValue('reject_and_report'),
  markSuccess: jest.fn().mockResolvedValue(undefined),
  markError: jest.fn().mockResolvedValue(undefined),
  assertResourceEnabled: jest.fn(),
  // No per-resource override configured in these tests — mirrors the
  // connection's own sync_direction, same as the pre-existing behaviour.
  effectiveDirectionOf: jest.fn((c: any) => c.sync_direction),
  ...over,
} as any);
const auditMock = () => ({ record: jest.fn().mockResolvedValue(undefined) } as any);
/** Admission control mock — permissive unless a test overrides it. */
const serviceAccountMock = () => ({ resolve: jest.fn().mockResolvedValue('svc-user'), resolveActorUserId: jest.fn(async (_t, u) => u ?? 'svc-user') } as any);
const admissionMock = (over: Partial<Record<string, jest.Mock>> = {}) => ({
  admit: jest.fn().mockResolvedValue(undefined),
  assertSyncConcurrency: jest.fn().mockResolvedValue(undefined),
  assertImportConcurrency: jest.fn().mockResolvedValue(undefined),
  assertPayloadSize: jest.fn(),
  ...over,
} as any);
const idMapMock = (over: Partial<Record<string, jest.Mock>> = {}) => ({
  findByInternalId: jest.fn().mockResolvedValue(null),
  link: jest.fn().mockResolvedValue(undefined),
  ...over,
} as any);

describe('IntegrationSyncService', () => {
  const tenantId = 't1';

  describe('start', () => {
    it('rejects a direction the connection is not configured for', async () => {
      const conn = connMock({ requireActive: jest.fn().mockResolvedValue({ id: 'c1', sync_direction: SYNC_DIRECTION.OUTBOUND }) });
      const svc = new IntegrationSyncService(jobsRepoMock(), conn, {} as any, {} as any, auditMock(), { enqueueIntegrationSync: jest.fn() } as any, admissionMock(), serviceAccountMock(), idMapMock());
      await expect(
        svc.start(tenantId, { connectionId: 'c1', resourceType: 'customer', direction: SYNC_DIRECTION.INBOUND } as any, {}),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('maps the DB partial-unique violation to a 409 (duplicate active run)', async () => {
      const jobs = jobsRepoMock({
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockRejectedValue(new PgUnique('dup')),
      });
      const svc = new IntegrationSyncService(jobs, connMock(), {} as any, {} as any, auditMock(), { enqueueIntegrationSync: jest.fn() } as any, admissionMock(), serviceAccountMock(), idMapMock());
      await expect(
        svc.start(tenantId, { connectionId: 'c1', resourceType: 'customer', direction: SYNC_DIRECTION.INBOUND } as any, {}),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('resumes an incremental run from the last successful cursor', async () => {
      const jobs = jobsRepoMock({
        findOne: jest.fn().mockResolvedValue({ last_successful_cursor: 'watermark-7' }),
        save: jest.fn((x) => Promise.resolve({ id: 'sync-1', ...x })),
      });
      const queue = { enqueueIntegrationSync: jest.fn().mockResolvedValue({ id: 'q' }) };
      const svc = new IntegrationSyncService(jobs, connMock(), {} as any, {} as any, auditMock(), queue as any, admissionMock(), serviceAccountMock(), idMapMock());
      const res = await svc.start(tenantId, { connectionId: 'c1', resourceType: 'customer', direction: SYNC_DIRECTION.INBOUND, mode: 'incremental' } as any, {});
      expect(res.cursor).toBe('watermark-7');
      expect(queue.enqueueIntegrationSync).toHaveBeenCalledWith({ tenantId, syncJobId: 'sync-1' });
    });
  });

  describe('process (inbound pull)', () => {
    it('advances the cursor page by page and completes', async () => {
      const job: any = {
        id: 'sync-1', status: JOB_STATUS.PENDING, tenant: { id: tenantId }, connection: { id: 'c1' },
        resource_type: 'customer', direction: SYNC_DIRECTION.INBOUND, mode: 'incremental',
        cursor: null, last_successful_cursor: null, processed: 0, retry_count: 0,
        created_count: 0, updated_count: 0, skipped_count: 0, conflicted_count: 0, failed_count: 0,
        triggered_by: null,
      };
      const jobs = jobsRepoMock({
        findOne: jest.fn()
          // process() first load (with relations)
          .mockResolvedValueOnce(job)
          // cancel-check reads inside the loop
          .mockResolvedValue({ cancel_requested: false }),
        save: jest.fn((x) => Promise.resolve(x)),
      });
      const provider = {
        pullChanges: jest.fn()
          .mockResolvedValueOnce({ records: [{ externalId: 'A', data: {} }], nextCursor: 'p1', hasMore: true })
          .mockResolvedValueOnce({ records: [{ externalId: 'B', data: {} }], nextCursor: 'p2', hasMore: false }),
      };
      const upsert = { upsertOne: jest.fn().mockResolvedValue({ outcome: UPSERT_OUTCOME.CREATED, externalId: 'X', internalId: 'i' }) };
      const conn = connMock();
      const svc = new IntegrationSyncService(jobs, conn, upsert as any, provider as any, auditMock(), {} as any, admissionMock(), serviceAccountMock(), idMapMock());

      await svc.process('sync-1');

      expect(provider.pullChanges).toHaveBeenCalledTimes(2);
      expect(job.processed).toBe(2);
      expect(job.created_count).toBe(2);
      expect(job.cursor).toBe('p2');
      expect(job.last_successful_cursor).toBe('p2');
      expect(job.status).toBe(JOB_STATUS.COMPLETED);
      expect(conn.markSuccess).toHaveBeenCalledWith('c1');
    });

    it('outbound sync via a built-in provider is a clean no-op completion', async () => {
      const job: any = {
        id: 'sync-2', status: JOB_STATUS.PENDING, tenant: { id: tenantId }, connection: { id: 'c1' },
        resource_type: 'customer', direction: SYNC_DIRECTION.OUTBOUND, retry_count: 0, processed: 0,
      };
      const jobs = jobsRepoMock({ findOne: jest.fn().mockResolvedValue(job), save: jest.fn((x) => Promise.resolve(x)) });
      // `custom`-style adapter: no push capability — the no-op path must be preserved exactly.
      const provider = { pullChanges: jest.fn(), capabilitiesOf: jest.fn().mockReturnValue({ pushChanges: false }) };
      const conn = connMock();
      const svc = new IntegrationSyncService(jobs, conn, { upsertOne: jest.fn() } as any, provider as any, auditMock(), {} as any, admissionMock(), serviceAccountMock(), idMapMock());
      await svc.process('sync-2');
      expect(provider.pullChanges).not.toHaveBeenCalled();
      expect(job.status).toBe(JOB_STATUS.COMPLETED);
    });

    it('is idempotent: a terminal run is a no-op', async () => {
      const job: any = { id: 'sync-3', status: JOB_STATUS.COMPLETED };
      const jobs = jobsRepoMock({ findOne: jest.fn().mockResolvedValue(job) });
      const provider = { pullChanges: jest.fn() };
      const svc = new IntegrationSyncService(jobs, connMock(), { upsertOne: jest.fn() } as any, provider as any, auditMock(), {} as any, admissionMock(), serviceAccountMock(), idMapMock());
      await svc.process('sync-3');
      expect(provider.pullChanges).not.toHaveBeenCalled();
    });
  });

  describe('process (outbound push — real sync)', () => {
    function baseJob(over: Partial<Record<string, unknown>> = {}) {
      return {
        id: 'sync-out', status: JOB_STATUS.PENDING, tenant: { id: tenantId }, connection: { id: 'c1' },
        resource_type: 'customer', direction: SYNC_DIRECTION.OUTBOUND, mode: 'incremental',
        cursor: null, last_successful_cursor: null, processed: 0, retry_count: 0,
        created_count: 0, updated_count: 0, skipped_count: 0, conflicted_count: 0, failed_count: 0,
        triggered_by: null,
        ...over,
      } as any;
    }
    function jobsFor(job: any) {
      return jobsRepoMock({
        findOne: jest.fn()
          .mockResolvedValueOnce(job)
          .mockResolvedValue({ cancel_requested: false }),
        save: jest.fn((x) => Promise.resolve(x)),
      });
    }
    const canPushProvider = (over: Partial<Record<string, jest.Mock>> = {}) => ({
      capabilitiesOf: jest.fn().mockReturnValue({ pushChanges: true }),
      pushChanges: jest.fn(),
      ...over,
    });

    it('pushes a new (create) and an already-mapped (update) record, links the new mapping, and completes', async () => {
      const job = baseJob();
      const jobs = jobsFor(job);
      const upsert = {
        listDirtyInternal: jest.fn().mockResolvedValueOnce({
          rows: [{ internalId: 'i1', cursor: 'cur-1' }, { internalId: 'i2', cursor: 'cur-2' }],
          hasMore: false,
        }),
        currentViewOf: jest.fn().mockResolvedValue({ name: 'x' }),
      };
      const idMap = idMapMock({
        findByInternalId: jest.fn()
          .mockResolvedValueOnce(null) // i1 has no mapping yet -> create
          .mockResolvedValueOnce({ external_id: 'ext-2' }), // i2 already mapped -> update
        link: jest.fn().mockResolvedValue(undefined),
      });
      const provider = canPushProvider({
        pushChanges: jest.fn()
          .mockResolvedValueOnce({ pushed: 1, failed: 0, results: [{ internalId: 'i1', ok: true, externalId: 'ext-1' }] })
          .mockResolvedValueOnce({ pushed: 1, failed: 0, results: [{ internalId: 'i2', ok: true }] }),
      });
      const svc = new IntegrationSyncService(jobs, connMock(), upsert as any, provider as any, auditMock(), {} as any, admissionMock(), serviceAccountMock(), idMap);

      await svc.process('sync-out');

      expect(provider.pushChanges).toHaveBeenCalledTimes(2);
      expect(idMap.link).toHaveBeenCalledWith(tenantId, 'c1', 'customer', 'ext-1', 'i1', expect.any(String));
      expect(job.created_count).toBe(1);
      expect(job.updated_count).toBe(1);
      expect(job.processed).toBe(2);
      expect(job.cursor).toBe('cur-2');
      expect(job.status).toBe(JOB_STATUS.COMPLETED);
    });

    it('pages through internal records changed since the cursor', async () => {
      const job = baseJob();
      const jobs = jobsFor(job);
      const upsert = {
        listDirtyInternal: jest.fn()
          .mockResolvedValueOnce({ rows: [{ internalId: 'i1', cursor: 'cur-1' }], hasMore: true })
          .mockResolvedValueOnce({ rows: [{ internalId: 'i2', cursor: 'cur-2' }], hasMore: false }),
        currentViewOf: jest.fn().mockResolvedValue({ name: 'x' }),
      };
      const idMap = idMapMock();
      const provider = canPushProvider({
        pushChanges: jest.fn()
          .mockResolvedValueOnce({ pushed: 1, failed: 0, results: [{ internalId: 'i1', ok: true }] })
          .mockResolvedValueOnce({ pushed: 1, failed: 0, results: [{ internalId: 'i2', ok: true }] }),
      });
      const svc = new IntegrationSyncService(jobs, connMock(), upsert as any, provider as any, auditMock(), {} as any, admissionMock(), serviceAccountMock(), idMap);

      await svc.process('sync-out');

      expect(upsert.listDirtyInternal).toHaveBeenCalledTimes(2);
      expect(upsert.listDirtyInternal).toHaveBeenNthCalledWith(1, tenantId, 'customer', null, expect.any(Number));
      expect(upsert.listDirtyInternal).toHaveBeenNthCalledWith(2, tenantId, 'customer', 'cur-1', expect.any(Number));
      expect(job.cursor).toBe('cur-2');
      expect(job.status).toBe(JOB_STATUS.COMPLETED);
    });

    it('a transient push failure halts the run at that row — the cursor never advances past it, and later rows in the page are never attempted', async () => {
      const job = baseJob();
      const jobs = jobsFor(job);
      const upsert = {
        listDirtyInternal: jest.fn().mockResolvedValueOnce({
          rows: [
            { internalId: 'i1', cursor: 'cur-1' },
            { internalId: 'i2', cursor: 'cur-2' },
            { internalId: 'i3', cursor: 'cur-3' },
          ],
          hasMore: false,
        }),
        currentViewOf: jest.fn().mockResolvedValue({ name: 'x' }),
      };
      const idMap = idMapMock();
      const provider = canPushProvider({
        pushChanges: jest.fn()
          .mockResolvedValueOnce({ pushed: 1, failed: 0, results: [{ internalId: 'i1', ok: true }] })
          .mockResolvedValueOnce({ pushed: 0, failed: 1, results: [{ internalId: 'i2', ok: false, transient: true, error: 'network blip' }] }),
      });
      const svc = new IntegrationSyncService(jobs, connMock(), upsert as any, provider as any, auditMock(), {} as any, admissionMock(), serviceAccountMock(), idMap);

      await svc.process('sync-out');

      // i3 must never be attempted — its record would already be on the wire
      // by the time the engine "decided" to stop, defeating the whole point.
      expect(provider.pushChanges).toHaveBeenCalledTimes(2);
      expect(job.cursor).toBe('cur-1'); // resumes from BEFORE the failed row, not at/after it
      expect(job.last_successful_cursor).toBe('cur-1');
      expect(job.failed_count).toBe(1);
      expect(job.status).toBe(JOB_STATUS.PARTIALLY_COMPLETED);
    });

    it('a permanent push failure is tallied but does not block the cursor from advancing past it', async () => {
      const job = baseJob();
      const jobs = jobsFor(job);
      const upsert = {
        listDirtyInternal: jest.fn().mockResolvedValueOnce({
          rows: [{ internalId: 'i1', cursor: 'cur-1' }, { internalId: 'i2', cursor: 'cur-2' }],
          hasMore: false,
        }),
        currentViewOf: jest.fn().mockResolvedValue({ name: 'x' }),
      };
      const idMap = idMapMock();
      const provider = canPushProvider({
        pushChanges: jest.fn()
          .mockResolvedValueOnce({ pushed: 0, failed: 1, results: [{ internalId: 'i1', ok: false, transient: false, error: 'validation failed' }] })
          .mockResolvedValueOnce({ pushed: 1, failed: 0, results: [{ internalId: 'i2', ok: true }] }),
      });
      const svc = new IntegrationSyncService(jobs, connMock(), upsert as any, provider as any, auditMock(), {} as any, admissionMock(), serviceAccountMock(), idMap);

      await svc.process('sync-out');

      // Both rows attempted — a permanent failure does not block the row after it.
      expect(provider.pushChanges).toHaveBeenCalledTimes(2);
      expect(job.cursor).toBe('cur-2');
      expect(job.failed_count).toBe(1);
      expect(job.status).toBe(JOB_STATUS.PARTIALLY_COMPLETED);
    });
  });
});
