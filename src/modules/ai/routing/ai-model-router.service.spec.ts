import { ConfigService } from '@nestjs/config';
import { AiModelRouterService } from './ai-model-router.service';

describe('AiModelRouterService', () => {
  const input = {
    tenantId: 'tenant-1', conversationId: 'conv-1', legacyModel: 'gpt-4o',
    feature: 'chat', route: 'ai.chat.api',
  };

  it('rolls back to the legacy model immediately when the feature flag is off', () => {
    const router = new AiModelRouterService(new ConfigService({
      AI_MODEL_ROUTING_ENABLED: 'false', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100,
      AI_ECONOMY_MODEL: 'gpt-4.1-mini',
    }));
    expect(router.resolve(input)).toEqual({ model: 'gpt-4o', routed: false, reason: 'legacy_flag' });
  });

  it('uses the economy model for standard routes and the powerful model only for explicit complexity', () => {
    const router = new AiModelRouterService(new ConfigService({
      AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100,
      AI_ECONOMY_MODEL: 'gpt-4.1-mini', AI_POWERFUL_MODEL: 'gpt-4o',
    }));
    expect(router.resolve(input).model).toBe('gpt-4.1-mini');
    expect(router.resolve({ ...input, complexity: 'HIGH' }).model).toBe('gpt-4o');
  });

  it('makes rollout deterministic per tenant and conversation', () => {
    const router = new AiModelRouterService(new ConfigService({
      AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 50,
      AI_ECONOMY_MODEL: 'gpt-4.1-mini',
    }));
    expect(router.resolve(input)).toEqual(router.resolve(input));
  });
});
