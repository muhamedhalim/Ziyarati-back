import { ConfigService } from '@nestjs/config';

import { AiExecutionService } from './ai-execution.service';
import { SettingKey } from '../platform/settings.registry';
import { AiModelRouterService } from './routing/ai-model-router.service';
import { AI_MODEL_IDS } from './routing/ai-model-registry';

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
      unused, // directives
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

/**
 * `/platform/system-settings` → `AiExecutionService` → `AiModelRouterService`.
 *
 * The counterpart of `resolveTemperature` above, and the link that makes the
 * settings page the platform's CENTRAL model configuration: before it existed,
 * `ai.default_model` was consulted only by `AiAgentService.create()`, so it
 * seeded a new agent row and then never influenced another turn — and the
 * public booking widget, which has no agent row at all, never saw it.
 */
describe('AiExecutionService — resolveDefaultModel', () => {
  let service: AiExecutionService;
  let platformSettings: { getTyped: jest.Mock };

  beforeEach(() => {
    platformSettings = { getTyped: jest.fn() };
    const unused = {} as any;
    service = new AiExecutionService(
      unused, unused, unused, unused, unused, unused, unused, unused,
      unused, unused, unused, unused, unused, unused, unused, unused,
      unused, unused,
      { get: jest.fn().mockReturnValue(10) } as any, // config
      platformSettings as any,
      unused, // bookingContext
      unused, // directives
    );
  });

  const resolveDefaultModel = () => (service as any).resolveDefaultModel();

  it.each(AI_MODEL_IDS)('hands the router %s when that is what the super admin selected', async (model) => {
    platformSettings.getTyped.mockResolvedValue(model);
    await expect(resolveDefaultModel()).resolves.toBe(model);
    expect(platformSettings.getTyped).toHaveBeenCalledWith(SettingKey.AI_DEFAULT_MODEL);
  });

  it('reads the setting each turn, so switching Luna → Terra takes effect without a deploy', async () => {
    platformSettings.getTyped
      .mockResolvedValueOnce('gpt-5.6-luna')
      .mockResolvedValueOnce('gpt-5.6-terra');
    await expect(resolveDefaultModel()).resolves.toBe('gpt-5.6-luna');
    await expect(resolveDefaultModel()).resolves.toBe('gpt-5.6-terra');
  });

  it('goes through the cached settings service, not a fresh query per message', () => {
    // `SystemSettingService.getTyped` is the 30 s-cached read. Asserted
    // structurally because the cost of getting this wrong is one DB round-trip
    // on every AI message on the platform, which no unit assertion would show.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source: string = require('node:fs').readFileSync(
      require.resolve('./ai-execution.service.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /resolveDefaultModel\(\)[\s\S]{0,200}platformSettings\.getTyped<string>\(\s*SettingKey\.AI_DEFAULT_MODEL/,
    );
    // Both turn paths (sendMessage + streamMessage) must pass it to the router,
    // or one surface silently ignores the platform setting.
    expect(source.match(/platformDefaultModel: await this\.resolveDefaultModel\(\)/g))
      .toHaveLength(2);
  });
});

/**
 * END-TO-END POLICY, at the seam the whole platform funnels through.
 *
 * Every AI feature — dashboard chat, the public booking widget, WhatsApp
 * inbound, appointment/service/doctor/availability tool calls, RAG, the
 * knowledge base, and the queue worker's background turns — reaches a model
 * through `AiExecutionService`, which reaches one through
 * `AiModelRouterService`. So a property proved of the router holds for all of
 * them, and this block proves it against the REAL router rather than a stub.
 */
describe('every AI execution path resolves to a permitted model', () => {
  // The real feature and route strings each surface passes in.
  const SURFACES: Array<[string, string, string]> = [
    ['dashboard chat', 'chat', 'ai.chat.api'],
    ['public booking widget', 'booking_chat', 'ai.chat.website'],
    ['WhatsApp inbound', 'whatsapp_chat', 'ai.chat.whatsapp'],
    ['live chat handover', 'live_chat', 'ai.chat.live'],
    ['tool / function call', 'tool_call', 'ai.chat.api'],
    ['appointment mutation', 'appointment_mutation', 'ai.chat.api'],
    ['RAG query', 'rag_query', 'ai.chat.api'],
    ['knowledge-base embedding', 'kb_embedding', 'ai.kb.embed'],
    ['background report job', 'report', 'ai.report.generate'],
    ['scheduled evaluation job', 'evaluation', 'ai.evaluation.run'],
    ['billing upgrade estimate', 'billing_upgrade_estimate', 'billing.upgrade.estimate'],
  ];

  const STORED: Array<string | undefined> = [
    undefined,
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    // What a pre-policy row, a forged request or a stale env could carry.
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-5.6-sol',
    'claude-3-opus',
  ];

  it.each(SURFACES)('%s never resolves outside the allow-list', (_label, feature, route) => {
    for (const cfg of [
      { AI_MODEL_ROUTING_ENABLED: 'false' },
      { AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100 },
      // A stale operator variable naming a retired model.
      { AI_MODEL_ROUTING_ENABLED: 'true', AI_MODEL_ROUTING_ROLLOUT_PERCENT: 100, AI_ECONOMY_MODEL: 'gpt-4o' },
    ]) {
      const router = new AiModelRouterService(new ConfigService(cfg));
      for (const legacyModel of STORED) {
        const decision = router.resolve({
          tenantId: 't1',
          conversationId: 'c1',
          legacyModel,
          feature,
          route,
        });
        expect(AI_MODEL_IDS).toContain(decision.model);
      }
    }
  });

  it('has no AI completion call site that picks its own model', () => {
    // Structural, and deliberately so: the regression is a NEW call site that
    // reaches AiProviderFactory directly with a model of its own — exactly what
    // the (since removed) guest attachment vision pass used to do. A behavioural test can only
    // cover the call sites it already knows about.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          const source: string = fs.readFileSync(full, 'utf8');
          // Reaches an AI provider, but never asks the router which model to
          // use. `AiProviderFactory` in the imports is what distinguishes this
          // from the email/payment factories, which share the `.resolve()` name
          // and have nothing to do with model policy.
          const usesAiFactory =
            /\bAiProviderFactory\b/.test(source) && /providers\.resolve\(/.test(source);
          if (usesAiFactory && !/modelRouter\.resolve\(/.test(source)) {
            offenders.push(path.relative(SRC, full).split(path.sep).join('/'));
          }
        }
      }
    };
    const SRC = path.resolve(__dirname, '..', '..');
    walk(SRC);

    // The factory is the seam itself; it enforces the policy rather than
    // consulting the router.
    expect(
      offenders.filter((f) => !f.includes('ai-provider.factory')),
    ).toEqual([]);
  });
});
