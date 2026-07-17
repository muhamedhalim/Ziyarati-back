import { WhatsappWebhookProcessor } from './whatsapp-webhook.processor';
import { WhatsappWebhookService } from '../../modules/whatsapp/whatsapp-webhook.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { QUEUE } from '../../queue/queue.constants';

describe('WhatsappWebhookProcessor', () => {
  let processor: WhatsappWebhookProcessor;
  let webhooks: { processEvent: jest.Mock };
  let queue: { enqueueWhatsappDlq: jest.Mock };

  beforeEach(() => {
    webhooks = { processEvent: jest.fn().mockResolvedValue({ processed: true }) };
    queue = { enqueueWhatsappDlq: jest.fn().mockResolvedValue(undefined) };
    processor = new WhatsappWebhookProcessor(
      webhooks as unknown as WhatsappWebhookService,
      new TenantContextService(),
      queue as unknown as QueueService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('restores the job tenant context and delegates to processEvent', async () => {
    const job = { data: { webhookEventId: 'evt-1', tenantId: 't1' }, attemptsMade: 0, name: 'whatsapp.webhookProcess' };
    const res = await processor.process(job as any);
    expect(webhooks.processEvent).toHaveBeenCalledWith('evt-1');
    expect(res).toEqual({ processed: true });
  });

  describe('onFailed', () => {
    it('does NOT park a job that still has retries left', async () => {
      const job = { data: { webhookEventId: 'evt-1', tenantId: 't1' }, id: 'j1', attemptsMade: 1, opts: { attempts: 5 } };
      await processor.onFailed(job as any, new Error('boom'));
      expect(queue.enqueueWhatsappDlq).not.toHaveBeenCalled();
    });

    it('parks the job in the whatsapp DLQ once retries are exhausted', async () => {
      const job = { data: { webhookEventId: 'evt-1', tenantId: 't1' }, id: 'j1', name: 'whatsapp.webhookProcess', attemptsMade: 5, opts: { attempts: 5 } };
      await processor.onFailed(job as any, new Error('boom'));

      expect(queue.enqueueWhatsappDlq).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceQueue: QUEUE.WHATSAPP_WEBHOOK,
          originalJobId: 'j1',
          originalData: job.data,
          failedReason: 'boom',
          attemptsMade: 5,
        }),
      );
    });

    it('does not throw when the DLQ enqueue itself fails', async () => {
      queue.enqueueWhatsappDlq.mockRejectedValueOnce(new Error('redis down'));
      const job = { data: { webhookEventId: 'evt-1', tenantId: 't1' }, id: 'j1', name: 'whatsapp.webhookProcess', attemptsMade: 5, opts: { attempts: 5 } };

      await expect(processor.onFailed(job as any, new Error('boom'))).resolves.toBeUndefined();
    });
  });
});
