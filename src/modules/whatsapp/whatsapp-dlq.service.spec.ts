import { WhatsappDlqService } from './whatsapp-dlq.service';
import { QueueService } from '../../queue/queue.service';
import { QUEUE } from '../../queue/queue.constants';
import { ErrorCode } from '../../common/errors';

/** The caller's tenant for every test unless a case overrides it. */
const CALLER_TENANT = 't1';
/** A different tenant's id — used for the cross-tenant rejection cases. */
const OTHER_TENANT = 't2';

describe('WhatsappDlqService', () => {
  let service: WhatsappDlqService;
  let queue: {
    dlqDepth: jest.Mock;
    queue: jest.Mock;
    publish: jest.Mock;
  };
  let dlqQueue: { getJobs: jest.Mock; getJob: jest.Mock };
  let tenantContext: {
    requireTenantId: jest.Mock;
    getTenantId: jest.Mock;
    getUser: jest.Mock;
    getCorrelationId: jest.Mock;
  };
  let locks: { acquire: jest.Mock; release: jest.Mock };
  let auditLogs: { create: jest.Mock; save: jest.Mock };

  beforeEach(() => {
    dlqQueue = { getJobs: jest.fn(), getJob: jest.fn() };
    queue = {
      dlqDepth: jest.fn().mockResolvedValue(3),
      queue: jest.fn().mockReturnValue(dlqQueue),
      publish: jest.fn().mockResolvedValue(undefined),
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
    service = new WhatsappDlqService(
      queue as unknown as QueueService,
      tenantContext as never,
      locks as never,
      auditLogs as never,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('reports depth scoped to the whatsapp DLQ, not the campaigns one', async () => {
    await expect(service.depth()).resolves.toBe(3);
    expect(queue.dlqDepth).toHaveBeenCalledWith(QUEUE.WHATSAPP_DLQ);
  });

  it('lists parked jobs newest-first with forensic fields', async () => {
    dlqQueue.getJobs.mockResolvedValueOnce([
      {
        id: 'j1',
        data: {
          sourceQueue: QUEUE.WHATSAPP_WEBHOOK,
          sourceJobName: 'whatsapp.webhookProcess',
          tenantId: 't1',
          failedReason: 'boom',
          attemptsMade: 5,
          diedAt: '2026-01-01T00:00:00.000Z',
          originalData: { webhookEventId: 'evt-1' },
        },
      },
    ]);

    const res = await service.list();
    expect(res).toEqual([
      expect.objectContaining({ jobId: 'j1', sourceQueue: QUEUE.WHATSAPP_WEBHOOK, failedReason: 'boom' }),
    ]);
  });

  describe('replay', () => {
    it('re-publishes the original data onto the source queue and removes the DLQ entry', async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      dlqQueue.getJob.mockResolvedValueOnce({
        id: 'j1',
        data: {
          sourceQueue: QUEUE.WHATSAPP_WEBHOOK,
          sourceJobName: 'whatsapp.webhookProcess',
          tenantId: CALLER_TENANT,
          originalJobId: 'orig-1',
          originalData: { webhookEventId: 'evt-1', tenantId: 't1' },
          correlationId: 'cid-1',
        },
        remove,
      });

      const res = await service.replay('j1');

      expect(queue.publish).toHaveBeenCalledWith(
        QUEUE.WHATSAPP_WEBHOOK,
        'whatsapp.webhookProcess',
        expect.objectContaining({ webhookEventId: 'evt-1', tenantId: 't1', correlationId: 'cid-1' }),
        expect.stringContaining('whatsapp.webhookProcess-replay-orig-1-'),
      );
      expect(remove).toHaveBeenCalled();
      expect(res).toEqual({ replayed: true, jobId: 'j1' });
    });

    it('rejects a source queue it does not know how to replay', async () => {
      dlqQueue.getJob.mockResolvedValueOnce({
        id: 'j1',
        data: { sourceQueue: 'campaigns.processRecipient', tenantId: CALLER_TENANT, originalData: {} },
      });

      await expect(service.replay('j1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('404s on an unknown job id', async () => {
      dlqQueue.getJob.mockResolvedValueOnce(null);
      await expect(service.replay('gone')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('discard', () => {
    it('removes the job without replaying', async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      dlqQueue.getJob.mockResolvedValueOnce({ id: 'j1', data: { tenantId: CALLER_TENANT }, remove });

      const res = await service.discard('j1');
      expect(remove).toHaveBeenCalled();
      expect(queue.publish).not.toHaveBeenCalled();
      expect(res).toEqual({ discarded: true, jobId: 'j1' });
    });

    it('404s on an unknown job id', async () => {
      dlqQueue.getJob.mockResolvedValueOnce(null);
      await expect(service.discard('gone')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  // ── FND-002: tenant isolation ────────────────────────────────────────────
  describe('tenant isolation', () => {
    const parked = (id: string, tenantId: string | undefined) => ({
      id,
      data: {
        sourceQueue: QUEUE.WHATSAPP_WEBHOOK,
        sourceJobName: 'whatsapp.webhookProcess',
        tenantId,
        failedReason: 'boom',
        attemptsMade: 5,
        diedAt: '2026-01-01T00:00:00.000Z',
        correlationId: 'cid-1',
        originalData: { webhookEventId: 'evt-1', toWaId: '+441234567890' },
      },
      remove: jest.fn().mockResolvedValue(undefined),
    });

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
      expect(row).toMatchObject({ jobId: 'mine-1', correlationId: 'cid-1' });
    });

    it('keeps the page size predictable when other tenants own the newest jobs', async () => {
      const jobs = [
        ...Array.from({ length: 20 }, (_, i) => parked(`theirs-${i}`, OTHER_TENANT)),
        parked('mine-1', CALLER_TENANT),
        parked('mine-2', CALLER_TENANT),
      ];
      dlqQueue.getJobs.mockResolvedValueOnce(jobs);

      const res = await service.list(2);
      expect(res.map((r) => r.jobId)).toEqual(['mine-1', 'mine-2']);
    });

    it('bounds the queue scan rather than walking it unbounded', async () => {
      dlqQueue.getJobs.mockResolvedValueOnce([]);
      await service.list(100);
      const [, start, end] = dlqQueue.getJobs.mock.calls[0];
      expect(start).toBe(0);
      expect(end).toBeLessThanOrEqual(999); // hard cap, never unbounded
    });

    it('rejects replay of another tenant job indistinguishably from missing', async () => {
      dlqQueue.getJob.mockResolvedValueOnce(parked('theirs-1', OTHER_TENANT));
      const foreign = await service.replay('theirs-1').catch((e) => e);

      dlqQueue.getJob.mockResolvedValueOnce(null);
      const missing = await service.replay('nope').catch((e) => e);

      expect(foreign.code).toBe(ErrorCode.NOT_FOUND);
      expect(foreign.code).toBe(missing.code);
      expect(foreign.message).toBe(missing.message);
      expect(queue.publish).not.toHaveBeenCalled();
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

      // The caller's tenant changes between listing and mutation.
      tenantContext.requireTenantId.mockReturnValue(OTHER_TENANT);
      dlqQueue.getJob.mockResolvedValueOnce(parked('mine-1', CALLER_TENANT));

      await expect(service.replay('mine-1')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  // ── FR-012: replay claim ─────────────────────────────────────────────────
  describe('replay idempotency claim', () => {
    const replayable = () => ({
      id: 'j1',
      data: {
        sourceQueue: QUEUE.WHATSAPP_WEBHOOK,
        sourceJobName: 'whatsapp.webhookProcess',
        tenantId: CALLER_TENANT,
        originalJobId: 'orig-1',
        originalData: { webhookEventId: 'evt-1' },
        correlationId: 'cid-1',
      },
      remove: jest.fn().mockResolvedValue(undefined),
    });

    it('claims the job before publishing', async () => {
      const order: string[] = [];
      locks.acquire.mockImplementation(async () => {
        order.push('acquire');
        return 'tok';
      });
      queue.publish.mockImplementation(async () => {
        order.push('publish');
      });
      dlqQueue.getJob.mockResolvedValueOnce(replayable());

      await service.replay('j1');
      expect(order).toEqual(['acquire', 'publish']);
    });

    it('rejects a concurrent replay whose claim cannot be acquired', async () => {
      locks.acquire.mockResolvedValueOnce(null);
      dlqQueue.getJob.mockResolvedValueOnce(replayable());

      await expect(service.replay('j1')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('retains the parked entry and releases the claim when publishing fails', async () => {
      const job = replayable();
      queue.publish.mockRejectedValueOnce(new Error('redis down'));
      dlqQueue.getJob.mockResolvedValueOnce(job);

      await expect(service.replay('j1')).rejects.toThrow('redis down');
      expect(job.remove).not.toHaveBeenCalled(); // never lost
      expect(locks.release).toHaveBeenCalled(); // immediately retryable
    });

    it('releases the claim after a successful replay', async () => {
      dlqQueue.getJob.mockResolvedValueOnce(replayable());
      await service.replay('j1');
      expect(locks.release).toHaveBeenCalled();
    });
  });

  // ── FR-013: safe audit records ───────────────────────────────────────────
  describe('audit records', () => {
    it('records a safe audit row on replay with no payload or PII', async () => {
      dlqQueue.getJob.mockResolvedValueOnce({
        id: 'j1',
        data: {
          sourceQueue: QUEUE.WHATSAPP_WEBHOOK,
          sourceJobName: 'whatsapp.webhookProcess',
          tenantId: CALLER_TENANT,
          correlationId: 'cid-1',
          originalData: { toWaId: '+441234567890', variables: { name: 'Alice' } },
        },
        remove: jest.fn().mockResolvedValue(undefined),
      });

      await service.replay('j1');

      expect(auditLogs.save).toHaveBeenCalled();
      const row = auditLogs.save.mock.calls.at(-1)![0];
      expect(row).toMatchObject({
        action: 'whatsapp.dlq.replay',
        entity_type: 'whatsapp_dlq_job',
        new_values: expect.objectContaining({ jobId: 'j1', result: 'replayed' }),
      });
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain('441234567890');
      expect(serialised).not.toContain('Alice');
    });

    it('records a rejection audit row for a cross-tenant attempt', async () => {
      dlqQueue.getJob.mockResolvedValueOnce({
        id: 'theirs',
        data: { tenantId: OTHER_TENANT },
        remove: jest.fn(),
      });

      await service.replay('theirs').catch(() => undefined);

      const row = auditLogs.save.mock.calls.at(-1)![0];
      expect(row.new_values).toMatchObject({ jobId: 'theirs', result: 'rejected' });
    });
  });
});
