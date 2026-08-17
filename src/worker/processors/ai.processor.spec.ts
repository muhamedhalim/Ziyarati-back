import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { JOB } from '../../queue/queue.constants';
import { AiProcessor } from './ai.processor';

function buildProcessor(overrides: { retention?: jest.Mock } = {}) {
  const exec = { sendMessage: jest.fn().mockResolvedValue({ message: { id: 'm1' } }) };
  const retention = {
    purgeExpiredAttempts:
      overrides.retention ??
      jest.fn().mockResolvedValue({ deleted: 0, cutoff: '2026-01-01T00:00:00.000Z' }),
  };
  const processor = new AiProcessor(
    exec as any,
    new TenantContextService(),
    { cleanupExpired: jest.fn() } as any,
    { sweep: jest.fn() } as any,
    { reconcileProcessing: jest.fn() } as any,
    { assertAuthorized: jest.fn().mockResolvedValue(undefined) } as any,
    retention as any,
  );
  return { processor, exec, retention };
}

describe('AiProcessor cost attribution', () => {
  it('passes a stable idempotency key and BACKGROUND_JOB transport to execution', async () => {
    const { processor, exec } = buildProcessor();
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

// AI-008 (FR-029c, T079): the retention job name must route to
// AiToolCallRetentionService and short-circuit before the AI_EXECUTE path
// (no exec.sendMessage call, no validateJobPayload requirement on
// tenantId/aiConversationId/content/idempotencyKey).
describe('AiProcessor — AI_TOOL_CALL_RETENTION routing (AI-008)', () => {
  it('routes the retention job to AiToolCallRetentionService.purgeExpiredAttempts and returns its result', async () => {
    const purge = jest
      .fn()
      .mockResolvedValue({ deleted: 42, cutoff: '2026-05-19T00:00:00.000Z' });
    const { processor, exec, retention } = buildProcessor({ retention: purge });

    const result = await processor.process({
      name: JOB.AI_TOOL_CALL_RETENTION,
      attemptsMade: 0,
      data: { tenantId: null },
    } as any);

    expect(retention.purgeExpiredAttempts).toHaveBeenCalledTimes(1);
    expect(exec.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 42, cutoff: '2026-05-19T00:00:00.000Z' });
  });

  // Existing behavior, unchanged by T079: a job name with no dedicated
  // branch and no REQUIRED_FIELDS entry falls through to the AI_EXECUTE
  // path untouched — this pins that the new branch didn't alter it.
  it('still falls through to the AI_EXECUTE path for an unregistered job name', async () => {
    const { processor, exec } = buildProcessor();

    await processor.process({
      name: 'some.unregistered.job',
      attemptsMade: 0,
      data: {
        tenantId: 'tenant-1',
        aiConversationId: 'conversation-1',
        content: 'hello',
        idempotencyKey: 'logical-request-2',
      },
    } as any);

    expect(exec.sendMessage).toHaveBeenCalledWith(
      'tenant-1',
      'conversation-1',
      { content: 'hello', idempotencyKey: 'logical-request-2' },
      'BACKGROUND_JOB',
    );
  });
});
