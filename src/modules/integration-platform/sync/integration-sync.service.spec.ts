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

describe('IntegrationSyncService', () => {
  const tenantId = 't1';

  describe('start', () => {
    it('rejects a direction the connection is not configured for', async () => {
      const conn = connMock({ requireActive: jest.fn().mockResolvedValue({ id: 'c1', sync_direction: SYNC_DIRECTION.OUTBOUND }) });
      const svc = new IntegrationSyncService(jobsRepoMock(), conn, {} as any, {} as any, auditMock(), { enqueueIntegrationSync: jest.fn() } as any, admissionMock(), serviceAccountMock());
      await expect(
        svc.start(tenantId, { connectionId: 'c1', resourceType: 'customer', direction: SYNC_DIRECTION.INBOUND } as any, {}),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('maps the DB partial-unique violation to a 409 (duplicate active run)', async () => {
      const jobs = jobsRepoMock({
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockRejectedValue(new PgUnique('dup')),
      });
      const svc = new IntegrationSyncService(jobs, connMock(), {} as any, {} as any, auditMock(), { enqueueIntegrationSync: jest.fn() } as any, admissionMock(), serviceAccountMock());
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
      const svc = new IntegrationSyncService(jobs, connMock(), {} as any, {} as any, auditMock(), queue as any, admissionMock(), serviceAccountMock());
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
      const svc = new IntegrationSyncService(jobs, conn, upsert as any, provider as any, auditMock(), {} as any, admissionMock(), serviceAccountMock());

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
      const provider = { pullChanges: jest.fn() };
      const conn = connMock();
      const svc = new IntegrationSyncService(jobs, conn, { upsertOne: jest.fn() } as any, provider as any, auditMock(), {} as any, admissionMock(), serviceAccountMock());
      await svc.process('sync-2');
      expect(provider.pullChanges).not.toHaveBeenCalled();
      expect(job.status).toBe(JOB_STATUS.COMPLETED);
    });

    it('is idempotent: a terminal run is a no-op', async () => {
      const job: any = { id: 'sync-3', status: JOB_STATUS.COMPLETED };
      const jobs = jobsRepoMock({ findOne: jest.fn().mockResolvedValue(job) });
      const provider = { pullChanges: jest.fn() };
      const svc = new IntegrationSyncService(jobs, connMock(), { upsertOne: jest.fn() } as any, provider as any, auditMock(), {} as any, admissionMock(), serviceAccountMock());
      await svc.process('sync-3');
      expect(provider.pullChanges).not.toHaveBeenCalled();
    });
  });
});
