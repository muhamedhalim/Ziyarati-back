import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { JOB } from '../../queue/queue.constants';
import { AiProcessor } from './ai.processor';

describe('AiProcessor cost attribution', () => {
  it('passes a stable idempotency key and BACKGROUND_JOB transport to execution', async () => {
    const exec = { sendMessage: jest.fn().mockResolvedValue({ message: { id: 'm1' } }) };
    const processor = new AiProcessor(
      exec as any,
      new TenantContextService(),
      { cleanupExpired: jest.fn() } as any,
    );
    await processor.process({
      name: JOB.AI_EXECUTE,
      attemptsMade: 0,
      data: {
        tenantId: 'tenant-1',
        aiConversationId: 'conversation-1',
        content: 'hello',
        idempotencyKey: 'logical-request-1',
      },
    } as any);

    expect(exec.sendMessage).toHaveBeenCalledWith(
      'tenant-1',
      'conversation-1',
      { content: 'hello', idempotencyKey: 'logical-request-1' },
      'BACKGROUND_JOB',
    );
  });
});
