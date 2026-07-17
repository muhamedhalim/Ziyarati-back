import { WhatsappDlqService } from './whatsapp-dlq.service';
import { QueueService } from '../../queue/queue.service';
import { QUEUE } from '../../queue/queue.constants';
import { ErrorCode } from '../../common/errors';

describe('WhatsappDlqService', () => {
  let service: WhatsappDlqService;
  let queue: {
    dlqDepth: jest.Mock;
    queue: jest.Mock;
    publish: jest.Mock;
  };
  let dlqQueue: { getJobs: jest.Mock; getJob: jest.Mock };

  beforeEach(() => {
    dlqQueue = { getJobs: jest.fn(), getJob: jest.fn() };
    queue = {
      dlqDepth: jest.fn().mockResolvedValue(3),
      queue: jest.fn().mockReturnValue(dlqQueue),
      publish: jest.fn().mockResolvedValue(undefined),
    };
    service = new WhatsappDlqService(queue as unknown as QueueService);
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
        data: { sourceQueue: 'campaigns.processRecipient', originalData: {} },
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
      dlqQueue.getJob.mockResolvedValueOnce({ id: 'j1', remove });

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
});
