import { AiOrchestratorController } from './ai-orchestrator.controller';
import type { AiOrchestratorService } from './ai-orchestrator.service';
import type { ConversationSessionService } from './conversation-session.service';
import type { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import type { AiWsRateLimitService } from '../ai-realtime/ai-ws-rate-limit.service';
import { ErrorCode } from '../../common/errors';

/**
 * RL-11 — `POST /ai/orchestrator/message` runs a paid model turn. It used to
 * carry only the platform-wide default throttle (300/min per IP) while the
 * `/ai` socket enforced a per-user turn budget; now both share that budget.
 */
describe('AiOrchestratorController.message — per-user turn budget (RL-11)', () => {
  const dto = { channel: 'web', content: 'hello' } as never;
  let orchestrator: { handle: jest.Mock };
  let turnLimit: { checkAndRecord: jest.Mock };
  let user: { id: string } | undefined;

  const controller = () =>
    new AiOrchestratorController(
      orchestrator as unknown as AiOrchestratorService,
      {} as ConversationSessionService,
      {
        requireTenantId: () => 'tenant-1',
        getUser: () => user,
      } as unknown as TenantContextService,
      turnLimit as unknown as AiWsRateLimitService,
    );

  beforeEach(() => {
    orchestrator = { handle: jest.fn().mockResolvedValue({ reply: 'hi' }) };
    turnLimit = {
      checkAndRecord: jest.fn().mockResolvedValue({ allowed: true }),
    };
    user = { id: 'user-7' };
  });

  it('checks the authenticated tier with the user id — the same key the socket uses — before running the turn', async () => {
    await controller().message(dto);

    expect(turnLimit.checkAndRecord).toHaveBeenCalledWith(
      'user-7',
      'authenticated',
    );
    expect(orchestrator.handle).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ content: 'hello' }),
    );
  });

  it('a spent budget is refused with RATE_LIMITED and the model is never called', async () => {
    turnLimit.checkAndRecord.mockResolvedValue({
      allowed: false,
      code: ErrorCode.RATE_LIMITED,
      tier: 'authenticated',
    });

    await expect(controller().message(dto)).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
    });
    expect(orchestrator.handle).not.toHaveBeenCalled();
  });

  it('a degraded limiter keeps its own SERVICE_UNAVAILABLE code', async () => {
    turnLimit.checkAndRecord.mockResolvedValue({
      allowed: false,
      code: ErrorCode.SERVICE_UNAVAILABLE,
    });

    await expect(controller().message(dto)).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE,
    });
    expect(orchestrator.handle).not.toHaveBeenCalled();
  });
});
