import { ConfigService } from '@nestjs/config';
import { AiModelRouterService } from './ai-model-router.service';
import { AI_MODEL_IDS, findModel } from './ai-model-registry';

describe('AiModelRouterService', () => {
  const input = {
    tenantId: 'tenant-1', conversationId: 'conv-1', legacyModel: 'gpt-5.6-terra',
    feature: 'chat', route: 'ai.chat.api',
  };

  it('rolls back to the legacy model immediately when the feature flag is off', () => {
    const router = new AiModelRouterService(new ConfigService({
      AI_MODEL_ROUTING_ENABLED: 'false', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100,
      AI_ECONOMY_MODEL: 'gpt-5.6-luna',
    }));
    expect(router.resolve(input)).toEqual({ model: 'gpt-5.6-terra', routed: false, reason: 'legacy_flag' });
  });

  it('uses the economy model for standard routes and the powerful model only for explicit complexity', () => {
    const router = new AiModelRouterService(new ConfigService({
      AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100,
      AI_ECONOMY_MODEL: 'gpt-5.6-luna', AI_POWERFUL_MODEL: 'gpt-5.6-terra',
    }));
    expect(router.resolve(input).model).toBe('gpt-5.6-luna');
    expect(router.resolve({ ...input, complexity: 'HIGH' }).model).toBe('gpt-5.6-terra');
  });

  it('makes rollout deterministic per tenant and conversation', () => {
    const router = new AiModelRouterService(new ConfigService({
      AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 50,
      AI_ECONOMY_MODEL: 'gpt-5.6-luna',
    }));
    expect(router.resolve(input)).toEqual(router.resolve(input));
  });
});

/**
 * PLATFORM MODEL POLICY — the property the whole feature exists to guarantee:
 * `resolve()` returns a permitted model on EVERY branch, in every
 * configuration, for every input. These are the cases that used to hand an
 * arbitrary string back to the caller, which then handed it to the provider.
 */
describe('AiModelRouterService — model policy', () => {
  const base = {
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
    feature: 'chat',
    route: 'ai.chat.api',
  };

  /** Every meaningful shape of the flag/rollout/tier configuration space. */
  const CONFIGS: Array<[string, Record<string, unknown>]> = [
    ['routing off', { AI_MODEL_ROUTING_ENABLED: 'false' }],
    ['routing off, non-strict', { AI_MODEL_ROUTING_ENABLED: 'false', AI_MODEL_ROUTING_STRICT: 'false' }],
    ['routing on, no tier models configured', { AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100 }],
    ['routing on, economy configured', { AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100, AI_ECONOMY_MODEL: 'gpt-5.6-luna' }],
    ['routing on, powerful route', { AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100, AI_POWERFUL_ROUTES: 'ai.chat.api' }],
    ['routing on, 0% rollout', { AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 0 }],
    ['routing on, strict off', { AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100, AI_MODEL_ROUTING_STRICT: 'false' }],
  ];

  /**
   * Values a request could carry: a retired model, an invented one, the "Sol"
   * id from the policy brief that this platform never registered, a
   * different-vendor id, an outright hostile string, and nothing at all.
   */
  const DISALLOWED = [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-5.6-sol',
    'gpt-4o-2024-08-06',
    'claude-3-opus',
    'totally-made-up-model',
    '',
    undefined,
  ];

  describe.each(CONFIGS)('with %s', (_label, cfg) => {
    it.each(DISALLOWED)(
      'never returns %p — the platform default takes over',
      (legacyModel) => {
        const router = new AiModelRouterService(new ConfigService(cfg));
        const decision = router.resolve({
          ...base,
          legacyModel: legacyModel as string | undefined,
        });
        expect(AI_MODEL_IDS).toContain(decision.model);
        expect(decision.model).not.toBe(legacyModel);
      },
    );

    it.each([...AI_MODEL_IDS])('always lands on a permitted model when %s is stored', (id) => {
      const router = new AiModelRouterService(new ConfigService(cfg));
      expect(AI_MODEL_IDS).toContain(router.resolve({ ...base, legacyModel: id }).model);
    });
  });

  /**
   * The specific hole this closed. In the SHIPPED configuration — routing off —
   * the stored string was returned untouched and went straight to the provider,
   * so restricting the registry alone would have changed nothing for any clinic
   * that already had `gpt-4o` on its agent row.
   */
  it('replaces a disallowed stored model even with routing OFF', () => {
    const off = new AiModelRouterService(
      new ConfigService({ AI_MODEL_ROUTING_ENABLED: 'false' }),
    );
    const decision = off.resolve({ ...base, legacyModel: 'gpt-4o' });
    expect(decision.model).toBe('gpt-5.6-luna');
    expect(decision.routed).toBe(true);
    expect(decision.reason).toBe('legacy_flag_policy_default');
  });

  /**
   * `AI_MODEL_ROUTING_STRICT=false` used to mean "pass the stored string
   * through unchanged". An operator variable must not be a way back around the
   * platform policy.
   */
  it('does not let AI_MODEL_ROUTING_STRICT=false re-open the policy', () => {
    const lax = new AiModelRouterService(
      new ConfigService({
        AI_MODEL_ROUTING_ENABLED: 'true',
        AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100,
        AI_MODEL_ROUTING_STRICT: 'false',
      }),
    );
    expect(AI_MODEL_IDS).toContain(lax.resolve({ ...base, legacyModel: 'gpt-4o' }).model);
  });

  /**
   * A tier variable naming a model outside the registry is refused by Joi at
   * boot. This asserts the second line: even if one reaches the service (a
   * hand-built ConfigService, a process started around validation), it is
   * ignored rather than obeyed.
   */
  it('ignores a tier environment variable naming a disallowed model', () => {
    const router = new AiModelRouterService(
      new ConfigService({
        AI_MODEL_ROUTING_ENABLED: 'true',
        AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100,
        AI_ECONOMY_MODEL: 'gpt-4o',
        AI_POWERFUL_MODEL: 'gpt-4o',
      }),
    );
    expect(router.resolve(base).model).toBe('gpt-5.6-luna');
    expect(router.resolve({ ...base, complexity: 'HIGH' }).model).toBe('gpt-5.6-terra');
  });

  /**
   * `/platform/system-settings` reaching the router is what makes it the
   * CENTRAL configuration rather than a value applied once at agent creation.
   */
  describe('ai.default_model as the platform default', () => {
    function off() {
      return new AiModelRouterService(
        new ConfigService({ AI_MODEL_ROUTING_ENABLED: 'false' }),
      );
    }

    it('runs the platform setting when no model is pinned and routing is off', () => {
      expect(
        off().resolve({ ...base, platformDefaultModel: 'gpt-5.6-terra' }).model,
      ).toBe('gpt-5.6-terra');
    });

    it('lets an agent own permitted model win over the platform default', () => {
      expect(
        off().resolve({
          ...base,
          legacyModel: 'gpt-5.6-luna',
          platformDefaultModel: 'gpt-5.6-terra',
        }).model,
      ).toBe('gpt-5.6-luna');
    });

    it('falls back to the platform default when the pinned model is disallowed', () => {
      expect(
        off().resolve({
          ...base,
          legacyModel: 'gpt-4o',
          platformDefaultModel: 'gpt-5.6-terra',
        }).model,
      ).toBe('gpt-5.6-terra');
    });

    it('ignores a disallowed platform default rather than obeying it', () => {
      // Only reachable for a `system_settings` row written before the setting
      // became an enum — the write path is validated.
      expect(
        off().resolve({ ...base, platformDefaultModel: 'gpt-5.6-sol' }).model,
      ).toBe('gpt-5.6-luna');
    });

    it('is outranked by the operator tier variable when routing is ON', () => {
      // Routing is the more specific decision; the platform setting is the
      // default it falls back to, not a ceiling over it.
      const on = new AiModelRouterService(
        new ConfigService({
          AI_MODEL_ROUTING_ENABLED: 'true',
          AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100,
          AI_ECONOMY_MODEL: 'gpt-5.6-terra',
        }),
      );
      expect(
        on.resolve({ ...base, platformDefaultModel: 'gpt-5.6-luna' }).model,
      ).toBe('gpt-5.6-terra');
    });
  });

  it('canonicalizes casing and whitespace, so the dispatched id is exact', () => {
    const off = new AiModelRouterService(
      new ConfigService({ AI_MODEL_ROUTING_ENABLED: 'false' }),
    );
    expect(off.resolve({ ...base, legacyModel: '  GPT-5.6-Luna ' }).model).toBe(
      'gpt-5.6-luna',
    );
  });
});

/**
 * Registry-backed behaviour. Kept in its own block so the three cases at the
 * top — which encode the rollout/rollback contract — stay untouched.
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
        AI_ECONOMY_MODEL: 'gpt-5.6-luna',
        AI_POWERFUL_MODEL: 'gpt-5.6-terra',
        ...overrides,
      }),
    );
  }

  it('returns the chosen model definition when routing is active', () => {
    const decision = router().resolve({ ...base, legacyModel: 'gpt-5.6-terra' });
    expect(decision.model).toBe('gpt-5.6-luna');
    expect(decision.definition?.id).toBe('gpt-5.6-luna');
    expect(decision.definition?.contextWindowTokens).toBeGreaterThan(0);
  });

  it('returns NO definition on the flag-off path, so disabling the flag is a true no-op', () => {
    const off = new AiModelRouterService(
      new ConfigService({ AI_MODEL_ROUTING_ENABLED: 'false' }),
    );
    expect(off.resolve({ ...base, legacyModel: 'gpt-5.6-terra' }).definition).toBeUndefined();
  });

  /**
   * The flag-off path returning no definition is deliberate (above), but it
   * leaves the execution layer to recover the capabilities itself — it does so
   * with `routed.definition ?? findModel(routed.model)`. That fallback is the
   * ONLY thing carrying `supportsTemperature: false` to the provider, because
   * routing is off in production. If it were ever dropped, the provider would
   * send `temperature` and EVERY turn would 400 — a total outage, now that
   * every permitted model is a reasoning model.
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
      expect(definition?.supportsTemperature).toBe(false);
      expect(definition?.reasoningEffort).toBe('none');
    },
  );

  it('ignores an unregistered model stored on an agent row', () => {
    const decision = router().resolve({ ...base, legacyModel: 'totally-made-up-model' });
    expect(decision.model).toBe('gpt-5.6-luna');
    expect(decision.routed).toBe(true);
  });

  it('honours a permitted stored model for a powerful route', () => {
    const decision = router({ AI_POWERFUL_ROUTES: 'ai.chat.api', AI_POWERFUL_MODEL: '' })
      .resolve({ ...base, legacyModel: 'gpt-5.6-terra' });
    expect(decision.model).toBe('gpt-5.6-terra');
    expect(decision.definition?.supportsTemperature).toBe(false);
  });

  it('escalates to the powerful model for a configured route', () => {
    const decision = router({ AI_POWERFUL_ROUTES: 'ai.chat.api' }).resolve(base);
    expect(decision.model).toBe('gpt-5.6-terra');
    expect(decision.reason).toContain('powerful_route');
  });

  it('falls back to the tier own registry default when no tier model is configured', () => {
    const r = router({ AI_ECONOMY_MODEL: '', AI_POWERFUL_MODEL: '' });
    expect(r.resolve(base).model).toBe('gpt-5.6-luna');
    expect(r.resolve({ ...base, complexity: 'HIGH' }).model).toBe('gpt-5.6-terra');
  });

  describe('GPT-5.6 capability flags', () => {
    /**
     * Selecting a model must carry its capability flags through the decision,
     * because the provider reads them off the definition to decide whether to
     * send `temperature` at all. A decision that resolved the id but dropped
     * the flags would 400 on every request.
     */
    it('carries the capability flags with the decision', () => {
      const decision = router({ AI_ECONOMY_MODEL: 'gpt-5.6-luna' }).resolve(base);
      expect(decision.model).toBe('gpt-5.6-luna');
      expect(decision.definition?.supportsTemperature).toBe(false);
      // 'none' is mandatory, not a preference: /v1/chat/completions rejects
      // function tools at any other effort — including when the field is
      // omitted. Established live, see docs/AI_MODEL_LIVE_VERIFICATION.md.
      expect(decision.definition?.reasoningEffort).toBe('none');
    });

    it('serves an AE residency turn — the GPT-5.6 family is what covers it', () => {
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
      expect(decision.model).toBe('gpt-5.6-luna');
      expect(decision.reason).not.toContain('substituted');
    });

    /**
     * Substitution is currently UNREACHABLE, and that is a property of the
     * permitted set rather than of the mechanism: both models declare the same
     * execution modes and the same residency regions, so no satisfiable
     * constraint can rule one out and leave the other. The mechanism is kept —
     * a future model with a narrower capability set will need it — and this
     * test pins the reason, so its disappearance from coverage is a recorded
     * fact rather than a silent gap.
     */
    it('needs no substitution: every permitted model has the same capabilities', () => {
      for (const region of ['us', 'eu', 'ae']) {
        for (const id of AI_MODEL_IDS) {
          const model = findModel(id)!;
          expect(model.supportedResidencyRegions).toContain(region);
          expect(model.supportedExecutionModes).toEqual(
            expect.arrayContaining(['STANDARD', 'BATCH']),
          );
        }
      }
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
          legacyModel: 'gpt-5.6-terra',
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

/**
 * `ai.default_model` precedence — the platform setting must actually decide the
 * model for a turn whose agent pins none, in BOTH routing states.
 */
describe('AiModelRouterService — platform default precedence', () => {
  const base = { tenantId: 't', conversationId: 'c', feature: 'chat', route: 'ai.chat.api' };
  const on = { AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100 };
  const make = (env: Record<string, unknown>) => new AiModelRouterService(new ConfigService(env));

  it('routing OFF, agent pins nothing → the platform default', () => {
    const d = make({}).resolve({ ...base, platformDefaultModel: 'gpt-5.6-terra' });
    expect(d.model).toBe('gpt-5.6-terra');
  });

  it('routing OFF, agent pins a model → the pin wins over the platform default', () => {
    const d = make({}).resolve({ ...base, legacyModel: 'gpt-5.6-luna', platformDefaultModel: 'gpt-5.6-terra' });
    expect(d.model).toBe('gpt-5.6-luna');
  });

  it('routing ON, AI_ECONOMY_MODEL unset → the platform default beats the tier default', () => {
    const d = make(on).resolve({ ...base, platformDefaultModel: 'gpt-5.6-terra' });
    expect(d.model).toBe('gpt-5.6-terra');
  });

  it('routing ON, AI_ECONOMY_MODEL set → the explicit operator override wins', () => {
    const d = make({ ...on, AI_ECONOMY_MODEL: 'gpt-5.6-luna' }).resolve({
      ...base,
      platformDefaultModel: 'gpt-5.6-terra',
    });
    expect(d.model).toBe('gpt-5.6-luna');
  });

  it('refuses nothing silently: an unpermitted platform default falls to the tier default', () => {
    const d = make(on).resolve({ ...base, platformDefaultModel: 'gpt-4o' });
    expect(d.model).toBe('gpt-5.6-luna');
  });
});
