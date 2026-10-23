import { WhatsappProcessor } from './whatsapp.processor';
import { WhatsappExecutionService } from '../../modules/whatsapp/whatsapp-execution.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { JOB } from '../../queue/queue.constants';
import { WHATSAPP_DELIVERY_STATUS } from '../../modules/whatsapp/whatsapp.constants';

/**
 * T050 — `WhatsappSendJob` (job-data.interface.ts) was not reshaped by Wave 2;
 * this proves a job carrying only the fields a PRE-Wave-2 producer would have
 * populated (no `logId`, no `correlationId`, no `payload.variables`) still
 * flows through the modified processor (FND-022: throw-on-FAILED + DLQ on
 * exhaustion) without crashing on a payload it wasn't holding before.
 */
describe('WhatsappProcessor — pre-deployment payload compatibility (T050)', () => {
  let exec: { sendTemplateMessage: jest.Mock };
  let authz: { assertAuthorized: jest.Mock };
  let ctx: TenantContextService;
  let queue: { enqueueWhatsappDlq: jest.Mock };
  let processor: WhatsappProcessor;

  const OLD_SHAPE_JOB = {
    name: JOB.WHATSAPP_SEND,
    data: {
      tenantId: 't1',
      templateId: 'tpl1',
      payload: { toWaId: '966500000000' },
      // no logId, no correlationId, no payload.variables — matches the
      // shape a producer enqueued before logId/variables existed.
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as any;

  beforeEach(() => {
    exec = {
      sendTemplateMessage: jest
        .fn()
        .mockResolvedValue({ status: WHATSAPP_DELIVERY_STATUS.SENT }),
    };
    ctx = new TenantContextService();
    authz = { assertAuthorized: jest.fn().mockResolvedValue(undefined) };
    queue = { enqueueWhatsappDlq: jest.fn().mockResolvedValue(undefined) };
    processor = new WhatsappProcessor(
      exec as unknown as WhatsappExecutionService,
      ctx,
      authz as unknown as WorkerAuthorizationService,
      queue as unknown as QueueService,
      {} as never, // WhatsappCoexistenceSyncService — only the coexistence-sync job uses it
    );
  });

  it('processes an old-shape job (no logId/correlationId/variables) without crashing', async () => {
    const result = await processor.process(OLD_SHAPE_JOB);

    expect(result).toEqual({ status: WHATSAPP_DELIVERY_STATUS.SENT });
    expect(exec.sendTemplateMessage).toHaveBeenCalledWith(
      't1',
      'tpl1',
      OLD_SHAPE_JOB.data.payload,
      undefined, // logId absent → no {logId} option passed
    );
  });

  it('still converts a returned FAILED status into a throw for an old-shape job (FND-022)', async () => {
    exec.sendTemplateMessage.mockResolvedValueOnce({
      status: WHATSAPP_DELIVERY_STATUS.FAILED,
      error: 'provider down',
    });

    await expect(processor.process(OLD_SHAPE_JOB)).rejects.toThrow('provider down');
  });
});
