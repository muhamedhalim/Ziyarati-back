/**
 * T129 — data-residency fail-closed behavior (FR-068) against
 * `AiDataResidencyService` (`src/modules/ai/execution/ai-data-residency.service.ts`)
 * and `TenantAiDeployment`: an unavailable tenant deployment must fail
 * closed, with ZERO provider calls.
 *
 * `AI_DATA_RESIDENCY_ENABLED` must be set BEFORE the app boots (ConfigService
 * reads it at call time, but the flag needs to be true from the first
 * request in this spec) — set via `process.env` before `buildAiAuditHarness()`,
 * the same pattern `ai-audit-harness.ts`'s own `{ pgvector: true }` option
 * uses.
 *
 * "Zero provider calls" is proven at the EXACT seam that would make one:
 * `OpenAiClientProvider.forTenant()` (openai-client.provider.ts) calls
 * `AiDataResidencyService.resolve()` FIRST and only calls `this.build()`
 * (which constructs the `OpenAI` SDK client) afterward — so a fail-closed
 * throw from `resolve()` means `build()`, and therefore any possibility of
 * a network call, is never reached. This is verified by calling
 * `forTenant()` directly (never `.complete()`, which would need a live
 * network call — forbidden per FR-103) and asserting it rejects with the
 * SAME error before any client exists.
 */
import { randomUUID } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiDataResidencyService } from '../../src/modules/ai/execution/ai-data-residency.service';
import { OpenAiClientProvider } from '../../src/modules/ai/providers/openai-client.provider';
import { AppError, ErrorCode } from '../../src/common/errors';
import { AI_COMPLIANCE_ROUTE_UNAVAILABLE } from '../../src/modules/ai/execution/ai-execution.constants';
import { EncryptionService } from '../../src/common/crypto/encryption.service';

describe('W8 — AI data residency fails closed, zero provider calls (T129)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let residency: AiDataResidencyService;
  let clients: OpenAiClientProvider;

  beforeAll(async () => {
    process.env.AI_DATA_RESIDENCY_ENABLED = 'true';
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    residency = harness.app.get(AiDataResidencyService);
    clients = harness.app.get(OpenAiClientProvider);
    expect(residency.isEnabled()).toBe(true); // sanity: the flag actually took
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM tenant_ai_deployments WHERE tenant_id = ANY($1)`, [
      [seed.tenantA.id, seed.tenantB.id],
    ]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
    delete process.env.AI_DATA_RESIDENCY_ENABLED;
  }, 60_000);

  async function insertDeployment(tenantId: string, overrides: Record<string, unknown>) {
    await harness.dataSource.query(
      `INSERT INTO tenant_ai_deployments (id, tenant_id, enabled, provider, region, base_url, openai_project, api_key_ciphertext, allowed_regions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        tenantId,
        overrides.enabled ?? true,
        overrides.provider ?? 'openai',
        overrides.region ?? null,
        overrides.base_url ?? null,
        overrides.openai_project ?? null,
        overrides.api_key_ciphertext ?? null,
        overrides.allowed_regions ?? null,
      ],
    );
  }

  it('enabled, NO region configured — fails closed (FORBIDDEN), no provider call issued', async () => {
    await insertDeployment(seed.tenantA.id, { enabled: true, region: null });

    harness.provider.reset();
    await expect(residency.resolve(seed.tenantA.id)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    expect(harness.provider.callCount).toBe(0);

    // Same fail-closed result at the ACTUAL provider-client seam — before any
    // OpenAI SDK client is ever constructed.
    await expect(clients.forTenant(seed.tenantA.id)).rejects.toBeInstanceOf(AppError);

    await harness.dataSource.query(`DELETE FROM tenant_ai_deployments WHERE tenant_id = $1`, [seed.tenantA.id]);
  }, 30_000);

  it('enabled, valid region, but NO api key configured — fails closed', async () => {
    await insertDeployment(seed.tenantA.id, { enabled: true, region: 'eu', api_key_ciphertext: null });

    await expect(residency.resolve(seed.tenantA.id)).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    await expect(clients.forTenant(seed.tenantA.id)).rejects.toBeInstanceOf(AppError);

    await harness.dataSource.query(`DELETE FROM tenant_ai_deployments WHERE tenant_id = $1`, [seed.tenantA.id]);
  }, 30_000);

  it('enabled, valid region, key present, but region NOT in the allow-list — fails closed', async () => {
    const enc = harness.app.get(EncryptionService);
    const ciphertext = enc.encrypt('sk-audit-synthetic-canary-fake-regional-key-0000000000');
    await insertDeployment(seed.tenantA.id, {
      enabled: true,
      region: 'eu',
      api_key_ciphertext: ciphertext,
      allowed_regions: ['us', 'sa'],
    });

    const err = await residency.resolve(seed.tenantA.id).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.FORBIDDEN);
    expect((err as AppError).publicContext).toMatchObject({ reason: AI_COMPLIANCE_ROUTE_UNAVAILABLE });
    // The public-facing message names no key material and no internal region list.
    expect(JSON.stringify((err as AppError).publicContext ?? {})).not.toContain('sk-audit-synthetic-canary');

    await harness.dataSource.query(`DELETE FROM tenant_ai_deployments WHERE tenant_id = $1`, [seed.tenantA.id]);
  }, 30_000);

  it('enabled, valid region, key present, region IS allow-listed, but the ciphertext is CORRUPT (undecryptable) — fails closed, decrypt error never echoed', async () => {
    await insertDeployment(seed.tenantA.id, {
      enabled: true,
      region: 'eu',
      api_key_ciphertext: 'enc:v1:corrupt-not-real-ciphertext',
      allowed_regions: ['eu'],
    });

    const err = await residency.resolve(seed.tenantA.id).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.FORBIDDEN);
    expect((err as AppError).message).not.toContain('corrupt-not-real-ciphertext');

    await harness.dataSource.query(`DELETE FROM tenant_ai_deployments WHERE tenant_id = $1`, [seed.tenantA.id]);
  }, 30_000);

  it('CONTROL — no deployment row at all: residency NOT enforced for this tenant, global client path used (proves the fail-closed cases above are not just "always throws")', async () => {
    const decision = await residency.resolve(seed.tenantB.id);
    expect(decision.enforced).toBe(false);
    const client = await clients.forTenant(seed.tenantB.id);
    expect(client).toBeUndefined(); // caller falls back to the global client
  }, 30_000);

  it('CONTROL — deployment row present but enabled=false: NOT enforced (residency requires an explicit opt-in row AND enabled=true)', async () => {
    await insertDeployment(seed.tenantB.id, { enabled: false, region: 'eu' });
    const decision = await residency.resolve(seed.tenantB.id);
    expect(decision.enforced).toBe(false);
    await harness.dataSource.query(`DELETE FROM tenant_ai_deployments WHERE tenant_id = $1`, [seed.tenantB.id]);
  }, 30_000);
});
