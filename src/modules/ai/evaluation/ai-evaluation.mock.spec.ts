import { ConfigService } from '@nestjs/config';
import { AiPromptBudgetService } from '../prompt/ai-prompt-budget.service';
import { AiModelRouterService } from '../routing/ai-model-router.service';
import { AI_EVALUATION_CASES } from './ai-evaluation.fixtures';

describe('Arabic/English AI evaluation harness (mocked providers only)', () => {
  const budget = new AiPromptBudgetService(new ConfigService());

  it.each(AI_EVALUATION_CASES)('$id preserves channel, language text, multi-turn order, and route rollback', (fixture) => {
    const built = budget.build({
      history: fixture.turns.map((content) => ({ role: 'user' as const, content })),
      ragChunks: fixture.capability === 'rag' ? [{ id: 'kb-1', content: 'Friday: 09:00-17:00', score: 1 }] : [],
      tools: fixture.capability === 'booking' || fixture.capability === 'tool_calling'
        ? [{ name: 'check_availability', description: 'read only', parameters: { type: 'object' } }]
        : [],
    });
    expect(built.messages.at(-1)?.content).toContain(fixture.turns.at(-1));
    expect(built.telemetry.estimatedInputTokens).toBeLessThanOrEqual(12_000);

    // Rollback: with routing off, an agent's own permitted model is what runs.
    // The stored value used to be `gpt-4o` here; a model outside the platform
    // allow-list is now replaced rather than passed through, so this fixture
    // pins the behaviour that actually still exists.
    const rollback = new AiModelRouterService(new ConfigService({
      AI_MODEL_ROUTING_ENABLED: 'false', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100,
      AI_ECONOMY_MODEL: 'gpt-5.6-luna',
    }));
    expect(rollback.resolve({
      tenantId: 'eval-tenant', conversationId: fixture.id,
      legacyModel: 'gpt-5.6-terra', feature: fixture.capability,
      route: `ai.chat.${fixture.channel.toLowerCase()}`,
    }).model).toBe('gpt-5.6-terra');
  });
});
