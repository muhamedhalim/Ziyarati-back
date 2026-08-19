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

/**
 * Registry-backed behaviour. Kept in its own block so the three cases above —
 * which encode the pre-registry contract and the rollback guarantee — stay
 * untouched: with the flag off, `resolve()` must still return exactly
 * `{ model, routed, reason }` and nothing more.
 */
describe('AiModelRouterService — registry and capability validation', () => {
  const base = {
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
    feature: 'chat',
    route: 'ai.chat.api',
  };

  function router(overrides: Record<string, unknown> = {}) {
    return new AiModelRouterService(
      new ConfigService({
        AI_MODEL_ROUTING_ENABLED: 'true',
        AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100,
        AI_ECONOMY_MODEL: 'gpt-4.1-mini',
        AI_POWERFUL_MODEL: 'gpt-4o',
        ...overrides,
      }),
    );
  }

  it('returns the chosen model’s definition when routing is active', () => {
    const decision = router().resolve({ ...base, legacyModel: 'gpt-4o' });
    expect(decision.model).toBe('gpt-4.1-mini');
    expect(decision.definition?.id).toBe('gpt-4.1-mini');
    expect(decision.definition?.contextWindowTokens).toBeGreaterThan(0);
  });

  it('returns NO definition on the flag-off path, so disabling the flag is a true no-op', () => {
    const off = new AiModelRouterService(
      new ConfigService({ AI_MODEL_ROUTING_ENABLED: 'false' }),
    );
    expect(off.resolve({ ...base, legacyModel: 'gpt-4o' }).definition).toBeUndefined();
  });

  it('ignores an unregistered model stored on an agent row under strict mode', () => {
    const decision = router().resolve({ ...base, legacyModel: 'totally-made-up-model' });
    expect(decision.model).toBe('gpt-4.1-mini');
    expect(decision.routed).toBe(true);
  });

  it('resolves a dated snapshot alias stored on an agent row to its canonical model', () => {
    // Powerful route so the stored model is the one under test, not the tier default.
    const decision = router({ AI_POWERFUL_ROUTES: 'ai.chat.api', AI_POWERFUL_MODEL: '' })
      .resolve({ ...base, legacyModel: 'gpt-4o-2024-08-06' });
    expect(decision.model).toBe('gpt-4o');
  });

  it('escalates to the powerful model for a configured route', () => {
    const decision = router({ AI_POWERFUL_ROUTES: 'ai.chat.api' }).resolve(base);
    expect(decision.model).toBe('gpt-4o');
    expect(decision.reason).toContain('powerful_route');
  });

  describe('PREVIEW models', () => {
    /**
     * An operator naming a PREVIEW model in env is a deliberate act taken after
     * running the live compatibility spec. The router honours it — that IS the
     * Phase 7 rollout mechanism — and carries the capability flags through, so
     * the provider knows to omit `temperature` rather than 400 every request.
     */
    it('honours a PREVIEW model an operator configured explicitly', () => {
      const decision = router({ AI_ECONOMY_MODEL: 'gpt-5.6-luna' }).resolve(base);
      expect(decision.model).toBe('gpt-5.6-luna');
      expect(decision.definition?.releaseStage).toBe('PREVIEW');
      expect(decision.definition?.supportsTemperature).toBe(false);
      // 'none' is mandatory, not a preference: /v1/chat/completions rejects
      // function tools at any other effort — including when the field is
      // omitted. Established live, see docs/AI_MODEL_LIVE_VERIFICATION.md.
      expect(decision.definition?.reasoningEffort).toBe('none');
    });

    /**
     * The inverse, and the one that actually matters: nothing AUTOMATIC may land
     * on a PREVIEW model. Substitution fires when a constraint has already gone
     * unsatisfied — resolving that by promoting an unproven model would turn a
     * compliance refusal into a total outage.
     */
    it('never substitutes into a PREVIEW model to satisfy a residency constraint', () => {
      const decision = router({ AI_ECONOMY_MODEL: 'gpt-4o-mini' }).resolve({
        ...base,
        // gpt-4o-mini is not residency-eligible, so a substitution must happen.
        processing: {
          executionMode: 'STANDARD' as const,
          residencyRequired: true,
          region: 'eu',
        },
      });
      expect(decision.definition?.releaseStage).toBe('GA');
      expect(decision.model).toBe('gpt-4.1-mini');
    });

    it('refuses rather than reaching for a PREVIEW model in a region only it serves', () => {
      // 'ae' is served by the GPT-5.6 family alone. Refusing is correct: the
      // alternative is silently running compliance-critical traffic on a model
      // whose compatibility has never been demonstrated.
      expect(() =>
        router().resolve({
          ...base,
          processing: {
            executionMode: 'STANDARD' as const,
            residencyRequired: true,
            region: 'ae',
          },
        }),
      ).toThrow(/residency/i);
    });
  });

  describe('processing-mode capability validation', () => {
    const standardGlobal = {
      executionMode: 'STANDARD' as const,
      residencyRequired: false,
      region: null,
    };

    it('passes a model straight through when it satisfies the constraints', () => {
      const decision = router().resolve({ ...base, processing: standardGlobal });
      expect(decision.model).toBe('gpt-4.1-mini');
      expect(decision.reason).not.toContain('substituted');
    });

    it('substitutes a residency-capable model rather than dropping the residency requirement', () => {
      // gpt-4o-mini is registered but is NOT residency-eligible.
      const decision = router({ AI_ECONOMY_MODEL: 'gpt-4o-mini' }).resolve({
        ...base,
        processing: { executionMode: 'STANDARD', residencyRequired: true, region: 'eu' },
      });
      expect(decision.model).not.toBe('gpt-4o-mini');
      expect(decision.definition?.supportedResidencyRegions).toContain('eu');
      expect(decision.reason).toContain('capability_substituted');
    });

    it('refuses when no registered model supports the required region', () => {
      expect(() =>
        router().resolve({
          ...base,
          processing: {
            executionMode: 'STANDARD',
            residencyRequired: true,
            region: 'antarctica',
          },
        }),
      ).toThrow(/data residency/i);
    });

    it('refuses a residency requirement that names no region — never guesses one', () => {
      expect(() =>
        router().resolve({
          ...base,
          processing: { executionMode: 'STANDARD', residencyRequired: true, region: null },
        }),
      ).toThrow(/data residency/i);
    });

    it('accepts BATCH combined with residency when a model supports both', () => {
      const decision = router().resolve({
        ...base,
        processing: { executionMode: 'BATCH', residencyRequired: true, region: 'eu' },
      });
      expect(decision.definition?.supportedExecutionModes).toContain('BATCH');
      expect(decision.definition?.supportedResidencyRegions).toContain('eu');
    });

    it('never applies capability validation on the flag-off path', () => {
      const off = new AiModelRouterService(
        new ConfigService({ AI_MODEL_ROUTING_ENABLED: 'false' }),
      );
      // An impossible constraint must not throw when routing is disabled —
      // rollback has to be total.
      expect(() =>
        off.resolve({
          ...base,
          legacyModel: 'gpt-4o',
          processing: {
            executionMode: 'STANDARD',
            residencyRequired: true,
            region: 'antarctica',
          },
        }),
      ).not.toThrow();
    });
  });
});
