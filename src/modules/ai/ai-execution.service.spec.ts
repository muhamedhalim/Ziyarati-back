import { AiExecutionService } from './ai-execution.service';
import { SettingKey } from '../platform/settings.registry';

/**
 * Focused coverage for `resolveTemperature` — the seam that used to leave a
 * guest/discovery-tenant turn (no `AiAgent` row) reading `OpenAiChatProvider`'s
 * own hardcoded `?? 0.2`, invisible to `ai.default_temperature`. Every other
 * collaborator is a stub: none of them are exercised by this method, so a full
 * `sendMessage`/`streamMessage` fixture would only add unrelated maintenance
 * surface for the same assertion.
 */
describe('AiExecutionService — resolveTemperature', () => {
  let service: AiExecutionService;
  let platformSettings: { getTyped: jest.Mock };

  beforeEach(() => {
    platformSettings = { getTyped: jest.fn() };
    const unused = {} as any;
    service = new AiExecutionService(
      unused, // aiConversations
      unused, // messages
      unused, // rag
      unused, // providers
      unused, // dataSource
      unused, // usage
      unused, // dispatch
      unused, // ctx
      unused, // timeline
      unused, // metrics
      unused, // emitter
      unused, // budgets
      unused, // costs
      unused, // requests
      unused, // modelRouter
      unused, // processingPolicy
      unused, // subscriptions
      unused, // access
      { get: jest.fn().mockReturnValue(10) } as any, // config
      platformSettings as any,
      unused, // bookingContext
    );
  });

  const resolveTemperature = (agent?: { temperature: number }) =>
    (service as any).resolveTemperature(agent);

  it("uses the agent's own stored temperature when an agent is present, without consulting the platform setting", async () => {
    await expect(resolveTemperature({ temperature: 0.7 } as any)).resolves.toBe(0.7);
    expect(platformSettings.getTyped).not.toHaveBeenCalled();
  });

  it('falls back to the live platform default for a turn with no agent row (guest/discovery-tenant widget)', async () => {
    platformSettings.getTyped.mockResolvedValue(0.42);
    await expect(resolveTemperature(undefined)).resolves.toBe(0.42);
    expect(platformSettings.getTyped).toHaveBeenCalledWith(SettingKey.AI_DEFAULT_TEMP);
  });

  it('reads the setting fresh each turn rather than caching a value at startup, so a super-admin change takes effect', async () => {
    platformSettings.getTyped.mockResolvedValueOnce(0.2).mockResolvedValueOnce(0.9);
    await expect(resolveTemperature(undefined)).resolves.toBe(0.2);
    await expect(resolveTemperature(undefined)).resolves.toBe(0.9);
  });
});
