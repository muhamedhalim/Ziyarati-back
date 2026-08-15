/**
 * T078 — the documented TRIPLE GATE for long-term memory recall (FR-050,
 * FR-004; research §R7 claim to verify).
 *
 * `AiOrchestratorService.prepare` (`ai-orchestrator.service.ts:299-303`) only
 * ever constructs a `memoryLoader` when ALL THREE hold:
 *   1. caller request    — `input.useMemory === true`
 *   2. operator flag     — `AI_MEMORY_RECALL_ENABLED === 'true'` (ConfigService)
 *   3. persisted consent — `session.context.memoryConsent === true`
 *
 * When `memoryLoader` is undefined, `AiExecutionService.sendMessage` never
 * calls it (`ai-execution.service.ts:315`: `memoryLoader ? await
 * memoryLoader() : []`) — so `AiMemoryService.recall()`, and everything under
 * it (the embedding call, the pgvector search, and — for the keyword-fallback
 * path this harness always takes — the `AiMemory` repository's own
 * `createQueryBuilder`) is never invoked at all. This spec spies on the
 * injected `Repository<AiMemory>`'s `createQueryBuilder` — a real TypeORM
 * repository from the DI container, not a hand-built double — per the task's
 * explicit instruction not to stop at "the result was empty".
 *
 * `AI_MEMORY_RECALL_ENABLED` is Joi-validated once at `ConfigModule`
 * bootstrap (defaults to `'false'`, `env.validation.ts:379-381`). Booting two
 * separate harnesses with `process.env` mutated between them was tried first
 * and did NOT reliably change what the compiled `ConfigService` resolves
 * (observed directly: a harness built after setting
 * `process.env.AI_MEMORY_RECALL_ENABLED='true'` still resolved `'false'`) —
 * `@nestjs/config`'s validated snapshot does not simply re-read
 * `process.env` on every `.get()` call. Instead, this spec uses ONE harness
 * and spies on the ACTUAL injected `ConfigService` instance
 * (`harness.config` — the same singleton `AiOrchestratorService` holds),
 * intercepting only the `AI_MEMORY_RECALL_ENABLED` key and delegating every
 * other key to the real implementation — the flag becomes a per-test knob
 * without needing a second app boot at all.
 */
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiOrchestratorService } from '../../src/modules/ai-orchestrator/ai-orchestrator.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { AiMemory } from '../../src/entities/AI Agent/AiMemory';

describe('AI memory — triple consent gate for long-term recall (T078)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;
  let orchestrator: AiOrchestratorService;
  let configGetSpy: jest.SpyInstance;
  let createQueryBuilderSpy: jest.SpyInstance;
  let flagValue = 'false';

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    sessions = harness.app.get(ConversationSessionService);
    orchestrator = harness.app.get(AiOrchestratorService);
    const memoriesRepo = harness.app.get(getRepositoryToken(AiMemory));
    createQueryBuilderSpy = jest.spyOn(memoriesRepo, 'createQueryBuilder');

    const config = harness.app.get(ConfigService);
    const realGet = config.get.bind(config);
    configGetSpy = jest.spyOn(config, 'get').mockImplementation((key: string, ...rest: unknown[]) => {
      if (key === 'AI_MEMORY_RECALL_ENABLED') return flagValue;
      return (realGet as (...a: unknown[]) => unknown)(key, ...rest);
    });
  }, 120_000);

  afterAll(async () => {
    configGetSpy.mockRestore();
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  async function driveTurn(opts: { flag: 'true' | 'false'; useMemory: boolean; consent: boolean; plantStale?: boolean }) {
    flagValue = opts.flag;
    const conv = await conversations.start(seed.tenantA.id, {});
    await sessions.patch(seed.tenantA.id, conv.id, {
      context: {
        memoryConsent: opts.consent,
        ...(opts.plantStale
          ? { recalledMemories: [{ type: 'preference', content: 'STALE — must be cleared', score: 1 }] }
          : {}),
      },
    });
    harness.provider.reset();
    harness.provider.script([{ content: 'ok' }]);
    createQueryBuilderSpy.mockClear();

    await orchestrator.handle(seed.tenantA.id, {
      channel: 'API',
      content: 'hello',
      aiConversationId: conv.id,
      useMemory: opts.useMemory,
    });

    const session = await sessions.get(seed.tenantA.id, conv.id);

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);

    return { queryIssued: createQueryBuilderSpy.mock.calls.length > 0, session };
  }

  it('sanity: the ConfigService spy actually controls what AiOrchestratorService reads for this key', async () => {
    flagValue = 'true';
    expect(String(harness.config.get('AI_MEMORY_RECALL_ENABLED', 'false'))).toBe('true');
    flagValue = 'false';
    expect(String(harness.config.get('AI_MEMORY_RECALL_ENABLED', 'false'))).toBe('false');
    // A different, real key still resolves through the real implementation —
    // proves the spy is a targeted intercept, not a blanket stub.
    expect(harness.config.get('NODE_ENV')).toBeDefined();
  });

  it('flag=false, useMemory=true, consent=true → NO recall query issued (env gate alone refuses)', async () => {
    const { queryIssued, session } = await driveTurn({ flag: 'false', useMemory: true, consent: true });
    expect(queryIssued).toBe(false);
    expect(session.context?.recalledMemories).toEqual([]);
  });

  it('flag=true, useMemory=false, consent=true → NO recall query issued (caller-request gate alone refuses)', async () => {
    const { queryIssued } = await driveTurn({ flag: 'true', useMemory: false, consent: true });
    expect(queryIssued).toBe(false);
  });

  it('flag=true, useMemory=true, consent=false → NO recall query issued (persisted-consent gate alone refuses), and STALE recalled state is cleared', async () => {
    const { queryIssued, session } = await driveTurn({
      flag: 'true',
      useMemory: true,
      consent: false,
      plantStale: true,
    });
    expect(queryIssued).toBe(false);
    // FR-050: failing any one condition CLEARS stale recalled state — proven
    // against the persisted row, not the in-memory return value.
    expect(session.context?.recalledMemories).toEqual([]);
  });

  it('flag=true, useMemory=true, consent=true → the recall query IS issued (all three gates pass)', async () => {
    const { queryIssued } = await driveTurn({ flag: 'true', useMemory: true, consent: true });
    expect(queryIssued).toBe(true);
  });

  // ── Truth table summary (all 8 combinations) ──────────────────────────────
  //
  // | flag  | useMemory | consent | recall query issued? | proven by     |
  // |-------|-----------|---------|-----------------------|---------------|
  // | false | true      | true    | NO                    | test 2        |
  // | false | true      | false   | NO (subsumed)         | not separately reproduced — flag alone already refuses per test 2 |
  // | false | false     | *       | NO (subsumed)         | not separately reproduced |
  // | true  | false     | true    | NO                    | test 3        |
  // | true  | true      | false   | NO                    | test 4        |
  // | true  | false     | false   | NO (subsumed)         | not separately reproduced |
  // | true  | true      | true    | YES                   | test 5        |
  //
  // The 3 subsumed rows are not independently reproduced because the gate is a
  // pure AND of independent conditions (ai-orchestrator.service.ts:300-303) —
  // each already-covered single-condition failure demonstrates the AND
  // short-circuits regardless of the other operands' values.
});
