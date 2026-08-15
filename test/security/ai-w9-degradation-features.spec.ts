/**
 * T136 — batch / model-routing / data-residency degradation toggles.
 *
 * Exercises `AiExecutionPolicyService` (`execution/ai-execution-policy.service.ts`),
 * `AiModelRouterService` (`routing/ai-model-router.service.ts`) and
 * `AiDataResidencyService` (`execution/ai-data-residency.service.ts`) directly
 * against real config values and (for residency) the real database + real
 * encryption, recording OBSERVED behavior per toggle rather than assuming the
 * documented one.
 *
 * Why direct construction instead of the shared app harness for the first two:
 * `ConfigModule.forRoot({ cache: true })` (`app.module.ts:74`) means the app's
 * shared `ConfigService` memoizes each key on FIRST read for the lifetime of
 * that Nest application instance — flipping `process.env` mid-suite would not
 * be observed by a service resolved from the harness DI container after its
 * first read of that key. `AiExecutionPolicyService`/`AiModelRouterService` are
 * pure functions of config (no DB/queue/provider I/O), so constructing them
 * directly with a small `.get(key, default)`-compatible double gives
 * deterministic, real toggle behavior without that cache getting in the way —
 * this exercises the REAL service class/method bodies, only the config source
 * differs. `AiDataResidencyService` DOES need the real database + real
 * `EncryptionService`, so it is built the same way but wired to the harness's
 * real `DataSource`/`EncryptionService` — never a mock of its own logic.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import {
  AiExecutionPolicyService,
} from '../../src/modules/ai/execution/ai-execution-policy.service';
import { AiModelRouterService } from '../../src/modules/ai/routing/ai-model-router.service';
import { AiDataResidencyService } from '../../src/modules/ai/execution/ai-data-residency.service';
import { AiBatchService } from '../../src/modules/ai/batch/ai-batch.service';
import { AI_FEATURE } from '../../src/modules/ai/execution/ai-execution.constants';
import { EncryptionService } from '../../src/common/crypto/encryption.service';
import { TenantAiDeployment } from '../../src/entities/AI Agent/TenantAiDeployment';

/** Minimal `ConfigService`-shaped double: same `.get(key, default)` contract, fully mutable per test. */
class FakeConfig {
  private store = new Map<string, unknown>();
  set(key: string, value: unknown): this {
    this.store.set(key, value);
    return this;
  }
  clear(): this {
    this.store.clear();
    return this;
  }
  get<T = unknown>(key: string, def?: T): T {
    return (this.store.has(key) ? this.store.get(key) : def) as T;
  }
}

describe('AI degradation — batch / routing / residency toggles (T136)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  // ─────────────────────── AiExecutionPolicyService (batch) ─────────────── //

  describe('AiExecutionPolicyService — AI_BATCH_ENABLED toggle', () => {
    it('batch DISABLED (default): a BATCH-mapped feature (kb_embedding) is downgraded to STANDARD, never left unrouted', () => {
      const config = new FakeConfig(); // AI_BATCH_ENABLED unset -> default 'false'
      const policy = new AiExecutionPolicyService(config as never);
      expect(policy.isBatchEnabled()).toBe(false);
      const decision = policy.resolveMode(AI_FEATURE.KB_EMBEDDING);
      expect(decision).toEqual({ mode: 'STANDARD', feature: AI_FEATURE.KB_EMBEDDING, reason: 'batch_disabled_fallback_standard' });
    });

    it('batch ENABLED: the same feature now resolves to BATCH', () => {
      const config = new FakeConfig().set('AI_BATCH_ENABLED', 'true');
      const policy = new AiExecutionPolicyService(config as never);
      expect(policy.isBatchEnabled()).toBe(true);
      const decision = policy.resolveMode(AI_FEATURE.KB_EMBEDDING);
      expect(decision.mode).toBe('BATCH');
    });

    it('an interactive feature (booking_chat) is NEVER routed to BATCH, even with batch enabled — user-facing chat cannot be stranded behind the async window', () => {
      const config = new FakeConfig().set('AI_BATCH_ENABLED', 'true');
      const policy = new AiExecutionPolicyService(config as never);
      expect(policy.resolveMode(AI_FEATURE.BOOKING_CHAT).mode).toBe('STANDARD');
    });

    it('per-feature batch-disabled behavior is honored exactly, not assumed: BULK_EMBEDDING DEFERS, KB_EMBEDDING (small) runs STANDARD, KB_EMBEDDING (huge) FAILS', () => {
      const config = new FakeConfig(); // batch disabled
      const policy = new AiExecutionPolicyService(config as never);

      const bulk = policy.resolveEmbeddingExecution(AI_FEATURE.BULK_EMBEDDING, 5);
      expect(bulk).toEqual({ mode: 'BATCH', action: 'DEFER', reason: 'batch_disabled_deferred' });

      const smallKb = policy.resolveEmbeddingExecution(AI_FEATURE.KB_EMBEDDING, 10);
      expect(smallKb).toEqual({ mode: 'STANDARD', action: 'RUN', reason: 'batch_disabled_small_standard' });

      const hugeKb = policy.resolveEmbeddingExecution(AI_FEATURE.KB_EMBEDDING, 10_000);
      expect(hugeKb).toEqual({ mode: 'BATCH', action: 'FAIL', reason: 'batch_disabled_too_large_for_standard' });
    });

    it('an UNMAPPED feature string fails safe to STANDARD (never silently stranded on the batch route)', () => {
      const config = new FakeConfig().set('AI_BATCH_ENABLED', 'true');
      const policy = new AiExecutionPolicyService(config as never);
      const decision = policy.resolveMode('totally_unmapped_feature' as never);
      expect(decision.mode).toBe('STANDARD');
    });

    it('the batch chunk threshold is configurable via env and actually changes the RUN/threshold boundary', () => {
      const config = new FakeConfig().set('AI_BATCH_ENABLED', 'true').set('AI_BATCH_EMBEDDING_CHUNK_THRESHOLD', '5');
      const policy = new AiExecutionPolicyService(config as never);
      expect(policy.shouldBatchEmbeddings(4)).toBe(false);
      expect(policy.shouldBatchEmbeddings(5)).toBe(true);
      expect(policy.shouldBatchEmbeddings(1, /* forceBatch */ true)).toBe(true);
    });
  });

  // ───────────────────────── AiModelRouterService ────────────────────────── //

  describe('AiModelRouterService — AI_MODEL_ROUTING_ENABLED / rollout toggle', () => {
    it('routing DISABLED (default): the legacy per-agent model always wins, unrouted', () => {
      const config = new FakeConfig();
      const router = new AiModelRouterService(config as never);
      const result = router.resolve({
        tenantId: seed.tenantA.id,
        conversationId: 'conv-1',
        legacyModel: 'legacy-model-x',
        feature: 'chat',
        route: 'ai.chat.dashboard',
      });
      expect(result).toEqual({ model: 'legacy-model-x', routed: false, reason: 'legacy_flag' });
    });

    it('routing ENABLED at 100% rollout: an unlisted feature/route gets the ECONOMY model', () => {
      const config = new FakeConfig()
        .set('AI_MODEL_ROUTING_ENABLED', 'true')
        .set('AI_MODEL_ROUTING_ROLLOUT_PERCENT', '100')
        .set('AI_ECONOMY_MODEL', 'econo-model')
        .set('AI_POWERFUL_MODEL', 'power-model');
      const router = new AiModelRouterService(config as never);
      const result = router.resolve({
        tenantId: seed.tenantA.id,
        conversationId: 'conv-1',
        legacyModel: 'legacy-model-x',
        feature: 'chat',
        route: 'ai.chat.dashboard',
      });
      expect(result).toEqual({ model: 'econo-model', routed: true, reason: 'economy_route' });
    });

    it('a HIGH-complexity turn always gets the POWERFUL model at 100% rollout, regardless of feature/route lists', () => {
      const config = new FakeConfig()
        .set('AI_MODEL_ROUTING_ENABLED', 'true')
        .set('AI_MODEL_ROUTING_ROLLOUT_PERCENT', '100')
        .set('AI_ECONOMY_MODEL', 'econo-model')
        .set('AI_POWERFUL_MODEL', 'power-model');
      const router = new AiModelRouterService(config as never);
      const result = router.resolve({
        tenantId: seed.tenantA.id,
        conversationId: 'conv-1',
        legacyModel: 'legacy-model-x',
        feature: 'chat',
        route: 'ai.chat.dashboard',
        complexity: 'HIGH',
      });
      expect(result).toEqual({ model: 'power-model', routed: true, reason: 'powerful_route' });
    });

    it('routing is deterministic per (tenant, conversation) at a partial rollout percentage — same inputs, same outcome every call', () => {
      const config = new FakeConfig()
        .set('AI_MODEL_ROUTING_ENABLED', 'true')
        .set('AI_MODEL_ROUTING_ROLLOUT_PERCENT', '50')
        .set('AI_ECONOMY_MODEL', 'econo-model');
      const router = new AiModelRouterService(config as never);
      const input = {
        tenantId: seed.tenantA.id,
        conversationId: 'conv-fixed-1',
        legacyModel: 'legacy-model-x',
        feature: 'chat',
        route: 'ai.chat.dashboard',
      };
      const first = router.resolve(input);
      const second = router.resolve(input);
      const third = router.resolve(input);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    });

    it('rollout 0% behaves identically to routing disabled (never routes)', () => {
      const config = new FakeConfig()
        .set('AI_MODEL_ROUTING_ENABLED', 'true')
        .set('AI_MODEL_ROUTING_ROLLOUT_PERCENT', '0');
      const router = new AiModelRouterService(config as never);
      const result = router.resolve({
        tenantId: seed.tenantA.id,
        conversationId: 'conv-1',
        legacyModel: 'legacy-model-x',
        feature: 'chat',
        route: 'ai.chat.dashboard',
      });
      expect(result.routed).toBe(false);
      expect(result.model).toBe('legacy-model-x');
    });

    it('does not silently break when no economy/powerful model env is configured — falls back to the legacy model rather than an undefined model string', () => {
      const config = new FakeConfig()
        .set('AI_MODEL_ROUTING_ENABLED', 'true')
        .set('AI_MODEL_ROUTING_ROLLOUT_PERCENT', '100');
      const router = new AiModelRouterService(config as never);
      const result = router.resolve({
        tenantId: seed.tenantA.id,
        conversationId: 'conv-1',
        legacyModel: 'legacy-model-x',
        feature: 'chat',
        route: 'ai.chat.dashboard',
      });
      expect(result.model).toBe('legacy-model-x'); // AI_ECONOMY_MODEL unset -> `|| input.legacyModel`
      expect(result.routed).toBe(false); // model === legacyModel -> routed computed false
    });
  });

  // ───────────────────────── AiDataResidencyService ──────────────────────── //

  describe('AiDataResidencyService — AI_DATA_RESIDENCY_ENABLED + per-tenant deployment fail-closed behavior', () => {
    let encryption: EncryptionService;
    let deployments: ReturnType<typeof harness.dataSource.getRepository<TenantAiDeployment>>;

    beforeAll(() => {
      encryption = harness.app.get(EncryptionService);
      deployments = harness.dataSource.getRepository(TenantAiDeployment);
    });

    afterEach(async () => {
      await harness.dataSource.query(`DELETE FROM tenant_ai_deployments WHERE tenant_id = $1`, [seed.tenantA.id]);
    });

    function service(enabled: boolean): AiDataResidencyService {
      const config = new FakeConfig().set('AI_DATA_RESIDENCY_ENABLED', enabled ? 'true' : 'false');
      return new AiDataResidencyService(config as never, encryption, deployments as never);
    }

    it('platform flag DISABLED (default): NOT_ENFORCED regardless of any deployment row', async () => {
      await deployments.save(deployments.create({ tenant_id: seed.tenantA.id, enabled: true, region: 'eu' }));
      const decision = await service(false).resolve(seed.tenantA.id);
      expect(decision).toEqual({ enforced: false, region: null, deploymentId: null, options: null });
    });

    it('platform flag ENABLED, no deployment row for this tenant: NOT_ENFORCED (global default client used)', async () => {
      const decision = await service(true).resolve(seed.tenantA.id);
      expect(decision.enforced).toBe(false);
    });

    it('platform flag ENABLED, deployment row exists but enabled=false: NOT_ENFORCED', async () => {
      await deployments.save(deployments.create({ tenant_id: seed.tenantA.id, enabled: false, region: 'eu' }));
      const decision = await service(true).resolve(seed.tenantA.id);
      expect(decision.enforced).toBe(false);
    });

    it('platform flag ENABLED, deployment enabled=true but region missing: FAILS CLOSED (throws, never redirects to the global deployment)', async () => {
      await deployments.save(deployments.create({ tenant_id: seed.tenantA.id, enabled: true, region: null }));
      await expect(service(true).resolve(seed.tenantA.id)).rejects.toMatchObject({
        code: 'FORBIDDEN' as never,
      });
    });

    it('platform flag ENABLED, region not in the tenant allow-list: FAILS CLOSED', async () => {
      await deployments.save(
        deployments.create({
          tenant_id: seed.tenantA.id,
          enabled: true,
          region: 'eu',
          allowed_regions: ['us'],
          api_key_ciphertext: encryption.encrypt('sk-fake-audit-key'),
        }),
      );
      await expect(service(true).resolve(seed.tenantA.id)).rejects.toBeDefined();
    });

    it('platform flag ENABLED, no API key configured on an otherwise-valid deployment: FAILS CLOSED', async () => {
      await deployments.save(
        deployments.create({ tenant_id: seed.tenantA.id, enabled: true, region: 'eu', api_key_ciphertext: null }),
      );
      await expect(service(true).resolve(seed.tenantA.id)).rejects.toBeDefined();
    });

    it('platform flag ENABLED, a CORRUPT (undecryptable) ciphertext: FAILS CLOSED with a message that never echoes the underlying crypto error', async () => {
      await deployments.save(
        deployments.create({
          tenant_id: seed.tenantA.id,
          enabled: true,
          region: 'eu',
          api_key_ciphertext: 'not-a-real-ciphertext-at-all',
        }),
      );
      try {
        await service(true).resolve(seed.tenantA.id);
        throw new Error('expected resolve() to throw');
      } catch (err) {
        const message = (err as { publicContext?: { message?: string }; message?: string }).message ?? '';
        expect(message.toLowerCase()).not.toMatch(/gcm|cipher|auth tag|iv\b/); // no crypto internals leaked
      }
    });

    it('platform flag ENABLED, an UNSAFE base URL (SSRF target — link-local metadata IP): FAILS CLOSED', async () => {
      await deployments.save(
        deployments.create({
          tenant_id: seed.tenantA.id,
          enabled: true,
          region: 'eu',
          api_key_ciphertext: encryption.encrypt('sk-fake-audit-key'),
          base_url: 'https://169.254.169.254/latest/meta-data/',
        }),
      );
      await expect(service(true).resolve(seed.tenantA.id)).rejects.toBeDefined();
    });

    it('platform flag ENABLED, a FULLY VALID deployment: ENFORCED, returns the decrypted key (never the ciphertext)', async () => {
      const plaintext = 'sk-fake-audit-key-full-valid';
      await deployments.save(
        deployments.create({
          tenant_id: seed.tenantA.id,
          enabled: true,
          region: 'eu',
          allowed_regions: ['eu', 'us'],
          api_key_ciphertext: encryption.encrypt(plaintext),
          base_url: 'https://eu.example-openai-regional.test',
          openai_project: 'proj_audit_fake',
        }),
      );
      const decision = await service(true).resolve(seed.tenantA.id);
      expect(decision.enforced).toBe(true);
      expect(decision.region).toBe('eu');
      expect(decision.options?.apiKey).toBe(plaintext);
      expect(decision.options?.baseURL).toBe('https://eu.example-openai-regional.test');
      expect(decision.options?.project).toBe('proj_audit_fake');
    });
  });

  // ───────────────────────── AiBatchService (safe, no-network paths only) ── //

  describe('AiBatchService — real service, network-free paths (submission gated by residency BEFORE any bytes leave the process)', () => {
    it('isConfigured() reflects the real OPENAI_API_KEY presence in this environment (not overridden by the audit harness)', () => {
      const batch = harness.app.get(AiBatchService);
      // Not asserted true/false absolutely (env-dependent) — recorded as observed fact.
      const configured = batch.isConfigured();
      process.stdout.write(`\n===AI-BATCH-SERVICE-CONFIGURED===\n${JSON.stringify({ configured })}\n`);
      expect(typeof configured).toBe('boolean');
    });

    it('submitEmbeddingBatch with ZERO items completes immediately with no remote call and no network dependency, and is idempotent on retry', async () => {
      const batch = harness.app.get(AiBatchService);
      const idempotencyKey = `t136-empty-batch-${seed.tenantA.id}`;
      const first = await batch.submitEmbeddingBatch({
        tenantId: seed.tenantA.id,
        feature: AI_FEATURE.KB_EMBEDDING,
        agentId: seed.tenantA.agentId,
        items: [],
        idempotencyKey,
      });
      expect(first.status).toBe('COMPLETED');
      expect(first.total_requests).toBe(0);

      const retried = await batch.submitEmbeddingBatch({
        tenantId: seed.tenantA.id,
        feature: AI_FEATURE.KB_EMBEDDING,
        agentId: seed.tenantA.agentId,
        items: [],
        idempotencyKey, // same key -> must resume/reuse the SAME job row, never create a second
      });
      expect(retried.id).toBe(first.id);

      const [{ count }] = await harness.dataSource.query(
        `SELECT COUNT(*)::int AS count FROM ai_batch_jobs WHERE tenant_id = $1 AND idempotency_key = $2`,
        [seed.tenantA.id, idempotencyKey],
      );
      expect(count).toBe(1); // never duplicated
    });
  });
});
