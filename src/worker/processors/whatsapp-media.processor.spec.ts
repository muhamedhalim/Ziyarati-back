import { WhatsappMediaProcessor } from './whatsapp-media.processor';
import { WhatsappMediaService } from '../../modules/whatsapp/meta/whatsapp-media.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { QUEUE } from '../../queue/queue.constants';

describe('WhatsappMediaProcessor', () => {
  let processor: WhatsappMediaProcessor;
  let media: { downloadAndAttach: jest.Mock };
  let queue: { enqueueWhatsappDlq: jest.Mock };

  const jobData = {
    tenantId: 't1',
    accountId: 'acc-1',
    messageId: 'msg-1',
    mediaId: 'media-1',
    mediaType: 'image',
  };

  beforeEach(() => {
    media = { downloadAndAttach: jest.fn().mockResolvedValue({ attached: true }) };
    queue = { enqueueWhatsappDlq: jest.fn().mockResolvedValue(undefined) };
    processor = new WhatsappMediaProcessor(
      media as unknown as WhatsappMediaService,
      new TenantContextService(),
      queue as unknown as QueueService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('restores the job tenant context and delegates to downloadAndAttach', async () => {
    const job = { data: jobData, attemptsMade: 0, name: 'whatsapp.mediaDownload' };
    const res = await processor.process(job as any);
    expect(media.downloadAndAttach).toHaveBeenCalledWith(jobData);
    expect(res).toEqual({ attached: true });
  });

  describe('onFailed', () => {
    it('does NOT park a job that still has retries left', async () => {
      const job = { data: jobData, id: 'j1', attemptsMade: 1, opts: { attempts: 5 } };
      await processor.onFailed(job as any, new Error('media url expired'));
      expect(queue.enqueueWhatsappDlq).not.toHaveBeenCalled();
    });

    it('parks the job in the whatsapp DLQ once retries are exhausted', async () => {
      const job = { data: jobData, id: 'j1', name: 'whatsapp.mediaDownload', attemptsMade: 5, opts: { attempts: 5 } };
      await processor.onFailed(job as any, new Error('media url expired'));

      expect(queue.enqueueWhatsappDlq).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceQueue: QUEUE.WHATSAPP_MEDIA,
          originalJobId: 'j1',
          originalData: jobData,
          failedReason: 'media url expired',
          attemptsMade: 5,
        }),
      );
    });
  });
});
