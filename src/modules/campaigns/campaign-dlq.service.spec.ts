import { CampaignDlqService } from './campaign-dlq.service';
import { QueueService } from '../../queue/queue.service';
import { QUEUE } from '../../queue/queue.constants';
import { ErrorCode } from '../../common/errors';

/**
 * Security regression suite for FND-003 (P0) — campaign dead-letter-queue admin
 * routes allowed cross-tenant read and write.
 *
 * Mirrors the WhatsApp DLQ suite. The owning tenant was recorded on every parked
 * job and returned to the caller, but never compared against the caller's own
 * tenant, so any user holding `campaigns.manage` in any tenant could list, view,
 * replay or discard another tenant's failed jobs.
 */

const CALLER_TENANT = 't1';
const OTHER_TENANT = 't2';

describe('CampaignDlqService', () => {
  let service: CampaignDlqService;
  let queue: { dlqDepth: jest.Mock; queue: jest.Mock; enqueueCampaignRecipient: jest.Mock };
  let dlqQueue: { getJobs: jest.Mock; getJob: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let tenantContext: {
    requireTenantId: jest.Mock;
    getTenantId: jest.Mock;
    getUser: jest.Mock;
    getCorrelationId: jest.Mock;
  };
  let locks: { acquire: jest.Mock; release: jest.Mock };
  let auditLogs: { create: jest.Mock; save: jest.Mock };
  /** Counts how many times the counter-reconciliation transaction actually ran. */
  let transactionRuns: number;

  const parked = (id: string, tenantId: string | undefined) => ({
    id,
    data: {
      sourceQueue: QUEUE.CAMPAIGNS_PROCESS,
      sourceJobName: 'campaigns.processRecipient',
      tenantId,
      failedReason: 'boom',
      attemptsMade: 5,
      diedAt: '2026-01-01T00:00:00.000Z',
      correlationId: 'cid-1',
      originalData: {
        tenantId,
        campaignId: 'camp-1',
        runId: 'run-1',
        recipientId: 'rcpt-1',
        toWaId: '+441234567890',
      },
    },
    remove: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    transactionRuns = 0;
    dlqQueue = { getJobs: jest.fn(), getJob: jest.fn() };
    queue = {
      dlqDepth: jest.fn().mockResolvedValue(7),
      queue: jest.fn().mockReturnValue(dlqQueue),
      enqueueCampaignRecipient: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (mgr: unknown) => Promise<void>) => {
        transactionRuns += 1;
        const mgr = {
          update: jest.fn().mockResolvedValue({ affected: 1 }),
          createQueryBuilder: jest.fn().mockReturnValue({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
          }),
        };
        await cb(mgr);
      }),
    };
    tenantContext = {
      requireTenantId: jest.fn().mockReturnValue(CALLER_TENANT),
      getTenantId: jest.fn().mockReturnValue(CALLER_TENANT),
      getUser: jest.fn().mockReturnValue({ id: 'user-1' }),
      getCorrelationId: jest.fn().mockReturnValue('cid-ctx'),
    };
    locks = {
      acquire: jest.fn().mockResolvedValue('lock-token'),
      release: jest.fn().mockResolvedValue(undefined),
    };
    auditLogs = {
      create: jest.fn().mockImplementation((v) => v),
      save: jest.fn().mockResolvedValue(undefined),
    };

    service = new CampaignDlqService(
      dataSource as never,
      queue as unknown as QueueService,
      tenantContext as never,
      locks as never,
      auditLogs as never,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('tenant isolation', () => {
    it('lists only jobs owned by the caller tenant', async () => {
      dlqQueue.getJobs.mockResolvedValueOnce([
        parked('mine-1', CALLER_TENANT),
        parked('theirs-1', OTHER_TENANT),
        parked('mine-2', CALLER_TENANT),
      ]);

      const res = await service.list();
      expect(res.map((r) => r.jobId)).toEqual(['mine-1', 'mine-2']);
    });

    it('treats a job with no recorded tenant as not owned (fail closed)', async () => {
      dlqQueue.getJobs.mockResolvedValueOnce([parked('orphan', undefined)]);
      await expect(service.list()).resolves.toEqual([]);
    });

    it('never returns originalData or tenantId in a listing', async () => {
      dlqQueue.getJobs.mockResolvedValueOnce([parked('mine-1', CALLER_TENANT)]);
      const [row] = await service.list();

      expect(row).not.toHaveProperty('originalData');
      expect(row).not.toHaveProperty('tenantId');
      expect(JSON.stringify(row)).not.toContain('441234567890');
    });

    it('keeps the page size predictable when other tenants own the newest jobs', async () => {
      dlqQueue.getJobs.mockResolvedValueOnce([
        ...Array.from({ length: 20 }, (_, i) => parked(`theirs-${i}`, OTHER_TENANT)),
        parked('mine-1', CALLER_TENANT),
        parked('mine-2', CALLER_TENANT),
      ]);

      const res = await service.list(2);
      expect(res.map((r) => r.jobId)).toEqual(['mine-1', 'mine-2']);
    });

    it('bounds the queue scan rather than walking it unbounded', async () => {
      dlqQueue.getJobs.mockResolvedValueOnce([]);
      await service.list(100);
      const [, start, end] = dlqQueue.getJobs.mock.calls[0];
      expect(start).toBe(0);
      expect(end).toBeLessThanOrEqual(999);
    });

    it('rejects replay of another tenant job indistinguishably from missing', async () => {
      dlqQueue.getJob.mockResolvedValueOnce(parked('theirs-1', OTHER_TENANT));
      const foreign = await service.replay('theirs-1').catch((e) => e);

      dlqQueue.getJob.mockResolvedValueOnce(null);
      const missing = await service.replay('nope').catch((e) => e);

      expect(foreign.code).toBe(ErrorCode.NOT_FOUND);
      expect(foreign.message).toBe(missing.message);
      expect(queue.enqueueCampaignRecipient).not.toHaveBeenCalled();
      expect(transactionRuns).toBe(0); // counters untouched
    });

    it('rejects discard of another tenant job indistinguishably from missing', async () => {
      const job = parked('theirs-1', OTHER_TENANT);
      dlqQueue.getJob.mockResolvedValueOnce(job);
      const foreign = await service.discard('theirs-1').catch((e) => e);

      dlqQueue.getJob.mockResolvedValueOnce(null);
      const missing = await service.discard('nope').catch((e) => e);

      expect(foreign.code).toBe(ErrorCode.NOT_FOUND);
      expect(foreign.message).toBe(missing.message);
      expect(job.remove).not.toHaveBeenCalled();
    });

    it('re-resolves ownership at action time, not from a prior listing', async () => {
      dlqQueue.getJobs.mockResolvedValueOnce([parked('mine-1', CALLER_TENANT)]);
      await service.list();

      tenantContext.requireTenantId.mockReturnValue(OTHER_TENANT);
      dlqQueue.getJob.mockResolvedValueOnce(parked('mine-1', CALLER_TENANT));

      await expect(service.replay('mine-1')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('replay behaviour', () => {
    it('reconciles counters and re-enqueues the recipient for an owned job', async () => {
      const job = parked('mine-1', CALLER_TENANT);
      dlqQueue.getJob.mockResolvedValueOnce(job);

      const res = await service.replay('mine-1');

      expect(transactionRuns).toBe(1);
      expect(queue.enqueueCampaignRecipient).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1', recipientId: 'rcpt-1', correlationId: 'cid-1' }),
      );
      expect(job.remove).toHaveBeenCalled();
      expect(res).toEqual({ replayed: true, jobId: 'mine-1' });
    });

    it('rejects a source queue it does not know how to replay', async () => {
      const job = parked('mine-1', CALLER_TENANT);
      job.data.sourceQueue = QUEUE.WHATSAPP_WEBHOOK as never;
      dlqQueue.getJob.mockResolvedValueOnce(job);

      await expect(service.replay('mine-1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(transactionRuns).toBe(0);
    });
  });

  describe('replay idempotency claim', () => {
    it('claims the job before reconciling counters or enqueuing', async () => {
      const order: string[] = [];
      locks.acquire.mockImplementation(async () => {
        order.push('acquire');
        return 'tok';
      });
      dataSource.transaction.mockImplementation(async () => {
        order.push('transaction');
        transactionRuns += 1;
      });
      queue.enqueueCampaignRecipient.mockImplementation(async () => {
        order.push('enqueue');
      });
      dlqQueue.getJob.mockResolvedValueOnce(parked('mine-1', CALLER_TENANT));

      await service.replay('mine-1');
      expect(order).toEqual(['acquire', 'transaction', 'enqueue']);
    });

    it('rejects a concurrent replay whose claim cannot be acquired', async () => {
      locks.acquire.mockResolvedValueOnce(null);
      dlqQueue.getJob.mockResolvedValueOnce(parked('mine-1', CALLER_TENANT));

      await expect(service.replay('mine-1')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(transactionRuns).toBe(0);
      expect(queue.enqueueCampaignRecipient).not.toHaveBeenCalled();
    });

    it('retains the parked entry and releases the claim when enqueue fails', async () => {
      const job = parked('mine-1', CALLER_TENANT);
      queue.enqueueCampaignRecipient.mockRejectedValueOnce(new Error('redis down'));
      dlqQueue.getJob.mockResolvedValueOnce(job);

      await expect(service.replay('mine-1')).rejects.toThrow('redis down');
      expect(job.remove).not.toHaveBeenCalled();
      expect(locks.release).toHaveBeenCalled();
    });

    it('releases the claim after a successful replay', async () => {
      dlqQueue.getJob.mockResolvedValueOnce(parked('mine-1', CALLER_TENANT));
      await service.replay('mine-1');
      expect(locks.release).toHaveBeenCalled();
    });
  });

  describe('audit records', () => {
    it('records a safe audit row on replay with no payload or PII', async () => {
      dlqQueue.getJob.mockResolvedValueOnce(parked('mine-1', CALLER_TENANT));
      await service.replay('mine-1');

      const row = auditLogs.save.mock.calls.at(-1)![0];
      expect(row).toMatchObject({
        action: 'campaigns.dlq.replay',
        entity_type: 'campaign_dlq_job',
        new_values: expect.objectContaining({ jobId: 'mine-1', result: 'replayed' }),
      });
      expect(JSON.stringify(row)).not.toContain('441234567890');
    });

    it('records a rejection audit row for a cross-tenant attempt', async () => {
      dlqQueue.getJob.mockResolvedValueOnce(parked('theirs-1', OTHER_TENANT));
      await service.replay('theirs-1').catch(() => undefined);

      const row = auditLogs.save.mock.calls.at(-1)![0];
      expect(row.new_values).toMatchObject({ jobId: 'theirs-1', result: 'rejected' });
    });
  });
});
