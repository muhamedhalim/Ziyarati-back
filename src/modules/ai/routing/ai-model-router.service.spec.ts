import { ConfigService } from '@nestjs/config';
import { AiModelRouterService } from './ai-model-router.service';
import { AI_MODEL_IDS, findModel } from './ai-model-registry';

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

  /**
   * The flag-off path returning no definition is deliberate (above), but it
   * leaves the execution layer to recover the capabilities itself — it does so
   * with `routed.definition ?? findModel(routed.model)`
   * (ai-execution.service.ts:452, :1335). That fallback is the ONLY thing
   * carrying `supportsTemperature: false` to the provider for a tenant that
   * pinned a GPT-5.6 model on its agent row, because routing is off in
   * production. If it were ever dropped, the provider would send `temperature`
   * and every one of that clinic's turns would 400 — a total outage for them,
   * and invisible to everyone else.
   */
  it.each(AI_MODEL_IDS)(
    'lets the execution layer recover %s capabilities with routing OFF',
    (id) => {
      const off = new AiModelRouterService(
        new ConfigService({ AI_MODEL_ROUTING_ENABLED: 'false' }),
      );
      const routed = off.resolve({ ...base, legacyModel: id });
      expect(routed.model).toBe(id);

      const definition = routed.definition ?? findModel(routed.model);
      expect(definition?.id).toBe(id);
      // The two fields the provider branches on.
      expect(typeof definition?.supportsTemperature).toBe('boolean');
      if (definition?.supportsTemperature === false) {
        expect(definition.reasoningEffort).toBe('none');
      }
    },
  );

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

  describe('GPT-5.6 as a routing target', () => {
    /**
     * Selecting a GPT-5.6 model must carry its capability flags through the
     * decision, because the provider reads them off the definition to decide
     * whether to send `temperature` at all. A decision that resolved the id but
     * dropped the flags would 400 on every request.
     */
    it('carries the capability flags when a GPT-5.6 model is configured', () => {
      const decision = router({ AI_ECONOMY_MODEL: 'gpt-5.6-luna' }).resolve(base);
      expect(decision.model).toBe('gpt-5.6-luna');
      expect(decision.definition?.supportsTemperature).toBe(false);
      // 'none' is mandatory, not a preference: /v1/chat/completions rejects
      // function tools at any other effort — including when the field is
      // omitted. Established live, see docs/AI_MODEL_LIVE_VERIFICATION.md.
      expect(decision.definition?.reasoningEffort).toBe('none');
    });

    /**
     * The whole point of Phase 8, asserted rather than assumed: a model being
     * SELECTABLE is not the same as a model being ROUTED TO. With the shipped
     * tier configuration, nothing automatic lands on GPT-5.6 — a clinic reaches
     * it only by naming it, and an operator only by changing a tier variable.
     */
    it('never routes to GPT-5.6 automatically under the shipped tier config', () => {
      const r = router(); // AI_ECONOMY_MODEL=gpt-4.1-mini, AI_POWERFUL_MODEL=gpt-4o
      expect(r.resolve(base).model).toBe('gpt-4.1-mini');
      expect(r.resolve({ ...base, complexity: 'HIGH' }).model).toBe('gpt-4o');
      expect(
        r.resolve({ ...base, legacyModel: 'totally-made-up-model' }).model,
      ).toBe('gpt-4.1-mini');
    });

    /**
     * A tenant that HAS pinned GPT-5.6 on its agent row keeps it: the stored
     * value is a registered model, so the strict-mode fallback must not fire.
     */
    it('honours GPT-5.6 stored on an agent row for a powerful route', () => {
      const decision = router({ AI_POWERFUL_ROUTES: 'ai.chat.api', AI_POWERFUL_MODEL: '' })
        .resolve({ ...base, legacyModel: 'gpt-5.6-terra' });
      expect(decision.model).toBe('gpt-5.6-terra');
      expect(decision.definition?.supportsTemperature).toBe(false);
    });

    /**
     * Substitution still prefers the cheapest tier model that fits, and the
     * registry's order puts the GPT-4.x models first — so promoting GPT-5.6 did
     * not quietly redirect the existing residency substitution path.
     */
    it('still substitutes to gpt-4.1-mini, not GPT-5.6, for an EU residency turn', () => {
      const decision = router({ AI_ECONOMY_MODEL: 'gpt-4o-mini' }).resolve({
        ...base,
        // gpt-4o-mini is not residency-eligible, so a substitution must happen.
        processing: {
          executionMode: 'STANDARD' as const,
          residencyRequired: true,
          region: 'eu',
        },
      });
      expect(decision.model).toBe('gpt-4.1-mini');
    });

    /**
     * 'ae' is served by the GPT-5.6 family alone. This case USED to fail closed,
     * because reaching for an unproven model to satisfy a compliance constraint
     * is worse than refusing. Now that the family is GA — live-verified against
     * this codebase's exact request shape — serving the region is the correct
     * outcome, and refusing would be an outage with no safety benefit.
     */
    it('serves an AE residency turn from the GPT-5.6 family', () => {
      const decision = router().resolve({
        ...base,
        processing: {
          executionMode: 'STANDARD' as const,
          residencyRequired: true,
          region: 'ae',
        },
      });
      expect(decision.model).toMatch(/^gpt-5\.6-/);
      expect(decision.definition?.supportedResidencyRegions).toContain('ae');
      expect(decision.reason).toContain('capability_substituted');
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
