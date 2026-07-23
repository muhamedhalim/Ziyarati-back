import { IntegrationImportJobService } from './integration-import-job.service';
import { JOB_STATUS, UPSERT_OUTCOME } from '../integration-platform.constants';
import { ErrorCode } from '../../../common/errors';

function jobsRepoMock(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn((x) => Promise.resolve({ id: x.id ?? 'job-1', ...x })),
    update: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    createQueryBuilder: jest.fn(),
    ...over,
  } as any;
}
const itemsRepoMock = () => ({ create: jest.fn((x) => x), save: jest.fn().mockResolvedValue({}), update: jest.fn(), findAndCount: jest.fn() } as any);

const connectionsMock = (over: Partial<Record<string, jest.Mock>> = {}) => ({
  requireActive: jest.fn().mockResolvedValue({ id: 'c1' }),
  conflictPolicyOf: jest.fn().mockReturnValue('reject_and_report'),
  markSuccess: jest.fn().mockResolvedValue(undefined),
  ...over,
} as any);

const auditMock = () => ({ record: jest.fn().mockResolvedValue(undefined) } as any);

/** Admission control mock — permissive unless a test overrides it. */
const admissionMock = (over: Partial<Record<string, jest.Mock>> = {}) => ({
  admit: jest.fn().mockResolvedValue(undefined),
  assertImportConcurrency: jest.fn().mockResolvedValue(undefined),
  assertSyncConcurrency: jest.fn().mockResolvedValue(undefined),
  assertPayloadSize: jest.fn(),
  ...over,
} as any);

describe('IntegrationImportJobService', () => {
  const tenantId = 't1';

  describe('create', () => {
    it('rejects atomic mode (no transactional support yet)', async () => {
      const svc = new IntegrationImportJobService(
        jobsRepoMock(), itemsRepoMock(), connectionsMock(),
        { supports: () => true } as any, auditMock(), { enqueueIntegrationImport: jest.fn() } as any,
        admissionMock(),
      );
      await expect(
        svc.create(tenantId, 'customer' as never, { connectionId: 'c1', mode: 'atomic', records: [{ externalId: 'A', data: {} }] } as any, {}),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('persists a pending job, enqueues, and returns the job id immediately', async () => {
      const jobs = jobsRepoMock({ save: jest.fn().mockResolvedValue({ id: 'job-9', status: 'pending', total: 1 }) });
      const queue = { enqueueIntegrationImport: jest.fn().mockResolvedValue({ id: 'q1' }) };
      const svc = new IntegrationImportJobService(jobs, itemsRepoMock(), connectionsMock(), { supports: () => true } as any, auditMock(), queue as any, admissionMock());
      const res = await svc.create(tenantId, 'customer' as never, { connectionId: 'c1', records: [{ externalId: 'A', data: {} }] } as any, { userId: 'u1' });
      expect(res).toEqual({ jobId: 'job-9', status: 'pending', total: 1 });
      expect(queue.enqueueIntegrationImport).toHaveBeenCalledWith({ tenantId, importJobId: 'job-9' });
    });

    it('keeps the job (does not throw) if enqueue fails — recovery sweep handles it', async () => {
      const jobs = jobsRepoMock({ save: jest.fn().mockResolvedValue({ id: 'job-9', status: 'pending', total: 1 }) });
      const queue = { enqueueIntegrationImport: jest.fn().mockRejectedValue(new Error('redis down')) };
      const svc = new IntegrationImportJobService(jobs, itemsRepoMock(), connectionsMock(), { supports: () => true } as any, auditMock(), queue as any, admissionMock());
      await expect(
        svc.create(tenantId, 'customer' as never, { connectionId: 'c1', records: [{ externalId: 'A', data: {} }] } as any, {}),
      ).resolves.toMatchObject({ jobId: 'job-9' });
    });
  });

  describe('process', () => {
    it('drains records: dedupes within batch, tallies, and ends partially_completed', async () => {
      const job: any = {
        id: 'job-1', status: JOB_STATUS.PENDING, tenant: { id: tenantId }, connection: { id: 'c1' },
        resource_type: 'customer', dry_run: false, total: 3, processed: 0,
        created_count: 0, updated_count: 0, linked_count: 0, skipped_count: 0, conflicted_count: 0, failed_count: 0,
        duplicates_in_batch: 0, requested_by: null,
        payload: [{ externalId: 'A', data: {} }, { externalId: 'A', data: {} }, { externalId: 'B', data: {} }],
      };
      const qb: any = { addSelect: () => qb, leftJoinAndSelect: () => qb, where: () => qb, getOne: jest.fn().mockResolvedValue(job) };
      const saves: any[] = [];
      const jobs = jobsRepoMock({
        createQueryBuilder: jest.fn(() => qb),
        findOne: jest.fn().mockResolvedValue({ cancel_requested: false }),
        save: jest.fn((x) => { saves.push(JSON.parse(JSON.stringify({ status: x.status, payload: x.payload, failed: x.failed_count }))); return Promise.resolve(x); }),
      });
      const upsert = {
        upsertOne: jest.fn(async (_t: any, _r: any, _c: any, _p: any, externalId: string) =>
          externalId === 'B'
            ? { outcome: UPSERT_OUTCOME.FAILED, externalId, internalId: null, error: 'bad' }
            : { outcome: UPSERT_OUTCOME.CREATED, externalId, internalId: 'int-A' }),
      };
      const connections = connectionsMock();
      const svc = new IntegrationImportJobService(jobs, itemsRepoMock(), connections, upsert as any, auditMock(), { enqueueIntegrationImport: jest.fn() } as any, admissionMock());

      await svc.process('job-1');

      expect(job.created_count).toBe(1);
      expect(job.failed_count).toBe(1);
      expect(job.duplicates_in_batch).toBe(1);
      expect(job.processed).toBe(3);
      expect(job.status).toBe(JOB_STATUS.PARTIALLY_COMPLETED);
      // Payload trimmed to only the failed record for retry.
      expect(job.payload).toEqual([{ externalId: 'B', data: {} }]);
      expect(connections.markSuccess).toHaveBeenCalledWith('c1');
      // Upsert called for A and B, NOT for the duplicate A.
      expect(upsert.upsertOne).toHaveBeenCalledTimes(2);
    });

    it('is idempotent: a terminal job is a no-op', async () => {
      const job: any = { id: 'job-1', status: JOB_STATUS.COMPLETED };
      const qb: any = { addSelect: () => qb, leftJoinAndSelect: () => qb, where: () => qb, getOne: jest.fn().mockResolvedValue(job) };
      const jobs = jobsRepoMock({ createQueryBuilder: jest.fn(() => qb) });
      const upsert = { upsertOne: jest.fn() };
      const svc = new IntegrationImportJobService(jobs, itemsRepoMock(), connectionsMock(), upsert as any, auditMock(), {} as any, admissionMock());
      await svc.process('job-1');
      expect(upsert.upsertOne).not.toHaveBeenCalled();
    });

    it('fails the job cleanly when the connection is no longer active', async () => {
      const job: any = {
        id: 'job-1', status: JOB_STATUS.PENDING, tenant: { id: tenantId }, connection: { id: 'c1' },
        resource_type: 'customer', dry_run: false, total: 1, processed: 0, failed_count: 0, payload: [{ externalId: 'A', data: {} }],
      };
      const qb: any = { addSelect: () => qb, leftJoinAndSelect: () => qb, where: () => qb, getOne: jest.fn().mockResolvedValue(job) };
      const jobs = jobsRepoMock({ createQueryBuilder: jest.fn(() => qb) });
      const connections = connectionsMock({ requireActive: jest.fn().mockRejectedValue(new Error('not active')) });
      const svc = new IntegrationImportJobService(jobs, itemsRepoMock(), connections, { upsertOne: jest.fn() } as any, auditMock(), {} as any, admissionMock());
      await svc.process('job-1');
      expect(job.status).toBe(JOB_STATUS.FAILED);
    });
  });
});
