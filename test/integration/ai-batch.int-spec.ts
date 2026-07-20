/**
 * OFFLINE integration test — real PostgreSQL, real repositories, real cost ledger,
 * a MOCK OpenAI batch provider (no network, no OpenAI). Proves the batch state
 * machine, submission idempotency + concurrency lease, reconciliation, result
 * idempotency, lease-based polling concurrency, tenant isolation, cost-ledger
 * persistence, and data-residency fail-closed against a real database.
 *
 * Runs against a throwaway DB created from DATABASE_URL. Skips cleanly if the DB
 * is unreachable. NEVER contacts OpenAI. pgvector is not required (embedding
 * writes are stubbed — pgvector is absent in CI and is covered by unit tests).
 *
 * Run: npx jest --config test/jest-integration.json
 */
import 'dotenv/config';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { DataSource, Repository } from 'typeorm';

import { AiBatchJob } from '../../src/entities/AI Agent/AiBatchJob';
import { AiBatchItem } from '../../src/entities/AI Agent/AiBatchItem';
import { TenantAiDeployment } from '../../src/entities/AI Agent/TenantAiDeployment';
import { AiBatchService } from '../../src/modules/ai/batch/ai-batch.service';
import { AiCostLedgerService } from '../../src/modules/ai/cost/ai-cost-ledger.service';
import { AiPriceCatalogService } from '../../src/modules/ai/cost/ai-price-catalog.service';
import { AiDataResidencyService } from '../../src/modules/ai/execution/ai-data-residency.service';
import { EncryptionService } from '../../src/common/crypto/encryption.service';
import {
  AI_BATCH_STATUS,
  AI_FEATURE,
} from '../../src/modules/ai/execution/ai-execution.constants';

const TEST_DB = process.env.INTEGRATION_TEST_DB ?? 'ziyarati_inttest';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

let ds: DataSource | null = null;
let available = false;

async function boot() {
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await a.query(`CREATE DATABASE ${TEST_DB}`);
  await a.end();
  ds = new DataSource({
    type: 'postgres',
    url: testUrl,
    entities: [
      join(process.cwd(), 'src', 'entities', '**', '!(*.spec).{ts,js}'),
    ],
    migrations: [join(process.cwd(), 'src', 'migrations', '!(*.spec).{ts,js}')],
    synchronize: false,
  });
  await ds.initialize();
  await ds.runMigrations();
}

beforeAll(async () => {
  if (!BASE) return;
  try {
    await boot();
    available = true;
  } catch (e) {
    console.warn(
      'AI batch integration test skipped (no DB):',
      (e as Error).message,
    );
  }
});

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (!available) return;
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await a.end();
});

// 32-byte key so EncryptionService is active for the residency test.
const ENC_KEY = Buffer.alloc(32, 7).toString('base64');

function mkService(
  overrides: {
    provider?: Partial<Record<string, jest.Mock>>;
    ingestion?: Partial<Record<string, jest.Mock>>;
    residencyEnforced?: boolean;
  } = {},
) {
  const jobs = ds!.getRepository(AiBatchJob);
  const items = ds!.getRepository(AiBatchItem);
  const config = new ConfigService({ AI_BATCH_SUBMIT_LEASE_SECONDS: 120 });
  const costs = new AiCostLedgerService(
    ds!,
    new AiPriceCatalogService(new ConfigService()),
  );
  const provider = {
    isConfigured: jest.fn().mockReturnValue(true),
    uploadInputFile: jest
      .fn()
      .mockResolvedValue({ inputFileId: 'file-remote' }),
    createBatch: jest.fn().mockResolvedValue({
      externalId: 'batch-ext',
      status: AI_BATCH_STATUS.SUBMITTED,
      inputFileId: 'file-remote',
      counts: { total: 2, completed: 0, failed: 0 },
    }),
    poll: jest.fn(),
    cancel: jest.fn(),
    findByCorrelation: jest.fn().mockResolvedValue(null),
    fetchResults: jest.fn(),
    submit: jest.fn(),
    ...overrides.provider,
  };
  const ingestion = {
    currentEmbeddingModel: jest.fn().mockReturnValue('text-embedding-3-small'),
    contentsByIds: jest.fn(
      async (_t: string, ids: string[]) =>
        new Map(ids.map((id) => [id, `content ${id}`])),
    ),
    unembeddedChunkIds: jest.fn().mockResolvedValue([]),
    saveEmbedding: jest.fn().mockResolvedValue(undefined), // pgvector stubbed
    ...overrides.ingestion,
  };
  const residency = {
    resolve: jest.fn().mockResolvedValue({
      enforced: !!overrides.residencyEnforced,
      region: null,
      deploymentId: null,
      options: null,
    }),
    isEnabled: jest.fn().mockReturnValue(false),
  };
  const emitter = { emit: jest.fn() };
  const service = new AiBatchService(
    jobs as never,
    items as never,
    provider as never,
    ingestion as never,
    residency as never,
    costs as never,
    ds! as never,
    config as never,
    emitter as never,
  );
  return { service, jobs, items, provider, ingestion, emitter, config };
}

async function newTenant(): Promise<string> {
  const s = randomUUID().slice(0, 8);
  const [t] = (await ds!.query(
    `INSERT INTO tenants (name, slug, contact_email) VALUES ('IntTest',$1,$2) RETURNING id`,
    [`int-${s}`, `int-${s}@example.com`],
  )) as Array<{ id: string }>;
  return t.id;
}

// Availability is only known after beforeAll, so gate at RUN time (not at
// registration). A missing DB makes the first test fail loudly; the rest no-op.
const runIf = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!available) return;
    await fn();
  });
const gate = () => runIf;

it('integration DB is available', () => {
  if (!BASE) return; // no DATABASE_URL configured at all → environment opt-out
  expect(available).toBe(true);
});

describe('AI batch — real Postgres integration (mock OpenAI)', () => {
  gate()('runs migrations and exposes the batch tables', async () => {
    const [{ x }] = (await ds!.query(
      `SELECT to_regclass('public.ai_batch_jobs') IS NOT NULL AS x`,
    )) as [{ x: boolean }];
    expect(x).toBe(true);
  });

  gate()(
    'persists a job + items (opaque custom_id, chunk_index) and is submit-idempotent',
    async () => {
      const tenant = await newTenant();
      const { service, jobs, items, provider } = mkService();
      const input = {
        tenantId: tenant,
        feature: AI_FEATURE.FILE_INDEXING,
        agentId: randomUUID(),
        items: [{ targetRef: 'kb-b' }, { targetRef: 'kb-a' }],
        idempotencyKey: `int-${randomUUID()}`,
        sourceType: 'training_file',
        sourceId: 'file-1',
      };
      const job = await service.submitEmbeddingBatch(input);
      expect(job.status).toBe(AI_BATCH_STATUS.SUBMITTED);
      expect(job.external_batch_id).toBe('batch-ext');

      const rows = await items.find({
        where: { batch_job_id: job.id },
        order: { chunk_index: 'ASC' },
      });
      expect(rows).toHaveLength(2);
      // Opaque custom_id (a uuid, not the kb id); chunk_index assigned by sorted order.
      expect(rows[0].custom_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0].custom_id).not.toBe(rows[0].target_ref);
      expect(rows.map((r) => r.target_ref)).toEqual(['kb-a', 'kb-b']); // sorted
      expect(rows.map((r) => r.chunk_index)).toEqual([0, 1]);

      // Re-submit with the SAME idempotency key → no duplicate remote batch.
      await service.submitEmbeddingBatch(input);
      expect(provider.createBatch).toHaveBeenCalledTimes(1);
      expect(
        await jobs.count({ where: { idempotency_key: input.idempotencyKey } }),
      ).toBe(1);
    },
  );

  gate()(
    'SUBMISSION_UNKNOWN is reconciled by correlation id (never recreated)',
    async () => {
      const tenant = await newTenant();
      const ambiguous = Object.assign(new Error('socket hang up'), {
        name: 'APIConnectionTimeoutError',
      });
      const { service, jobs, provider } = mkService({
        provider: {
          createBatch: jest.fn().mockRejectedValue(ambiguous),
          findByCorrelation: jest.fn().mockResolvedValue({
            externalId: 'batch-found',
            status: AI_BATCH_STATUS.IN_PROGRESS,
            counts: { total: 2, completed: 0, failed: 0 },
          }),
        },
      });
      const key = `int-${randomUUID()}`;
      await expect(
        service.submitEmbeddingBatch({
          tenantId: tenant,
          feature: AI_FEATURE.FILE_INDEXING,
          agentId: randomUUID(),
          items: [{ targetRef: 'kb-1' }],
          idempotencyKey: key,
          sourceType: 'training_file',
          sourceId: 'file-x',
        }),
      ).rejects.toThrow();

      let job = await jobs.findOneByOrFail({ idempotency_key: key });
      expect(job.status).toBe(AI_BATCH_STATUS.SUBMISSION_UNKNOWN);
      expect(job.external_batch_id).toBeNull();

      // Make it eligible for reconcile (past grace + lease) and run the reconciler.
      await ds!.query(
        `UPDATE ai_batch_jobs SET updated_at = now() - interval '1 hour', next_poll_at = now() - interval '1 hour' WHERE id=$1`,
        [job.id],
      );
      await service.reconcileSubmissions();

      job = await jobs.findOneByOrFail({ id: job.id });
      expect(job.external_batch_id).toBe('batch-found'); // adopted
      expect(provider.createBatch).toHaveBeenCalledTimes(1); // the failed one only — never a second create
    },
  );

  gate()(
    'processes terminal results idempotently and writes exactly one BATCH cost entry',
    async () => {
      const tenant = await newTenant();
      const agent = randomUUID();
      const { service, jobs, items, ingestion } = mkService({
        provider: {
          poll: jest.fn().mockResolvedValue({
            externalId: 'batch-ext',
            status: AI_BATCH_STATUS.COMPLETED,
            outputFileId: 'out',
            errorFileId: 'err',
            counts: { total: 2, completed: 1, failed: 1 },
          }),
          fetchResults: jest.fn().mockResolvedValue({
            // out of order + one failure
            outputs: [
              {
                customId: 'PLACEHOLDER',
                statusCode: 200,
                body: {
                  data: [{ embedding: [0.1] }],
                  usage: { total_tokens: 5 },
                },
                error: null,
              },
            ],
            errors: [
              {
                customId: 'PLACEHOLDER2',
                statusCode: null,
                body: null,
                error: { code: 'too_long' },
              },
            ],
          }),
        },
      });
      // Seed a submitted job with two items.
      const key = `int-${randomUUID()}`;
      const job = await service.submitEmbeddingBatch({
        tenantId: tenant,
        feature: AI_FEATURE.FILE_INDEXING,
        agentId: agent,
        items: [{ targetRef: 'kb-1' }, { targetRef: 'kb-2' }],
        idempotencyKey: key,
        sourceType: 'training_file',
        sourceId: 'file-y',
      });
      await jobs.update(
        { id: job.id },
        { status: AI_BATCH_STATUS.IN_PROGRESS },
      );
      const rows = await items.find({
        where: { batch_job_id: job.id },
        order: { chunk_index: 'ASC' },
      });
      // Bind the mocked results to the real (opaque) custom_ids.
      (
        service as unknown as { provider: { fetchResults: jest.Mock } }
      ).provider.fetchResults.mockResolvedValue({
        outputs: [
          {
            customId: rows[1].custom_id,
            statusCode: 200,
            body: { data: [{ embedding: [0.1] }], usage: { total_tokens: 5 } },
            error: null,
          },
        ],
        errors: [
          {
            customId: rows[0].custom_id,
            statusCode: null,
            body: null,
            error: { code: 'too_long' },
          },
        ],
      });

      expect(await service.pollJob(job.id)).toBe(true);
      // Second poll is a no-op (job already terminal).
      expect(await service.pollJob(job.id)).toBe(false);

      const finalItems = await items.find({
        where: { batch_job_id: job.id },
        order: { chunk_index: 'ASC' },
      });
      expect(finalItems.map((i) => i.status).sort()).toEqual([
        'COMPLETED',
        'FAILED',
      ]);
      expect(ingestion.saveEmbedding).toHaveBeenCalledTimes(1); // only the successful item

      const [{ n }] = (await ds!.query(
        `SELECT count(*)::int n FROM ai_cost_entries WHERE batch_job_id=$1`,
        [job.id],
      )) as [{ n: number }];
      expect(n).toBe(1); // exactly one BATCH cost entry, even after two polls
      const [{ mode }] = (await ds!.query(
        `SELECT execution_mode mode FROM ai_cost_entries WHERE batch_job_id=$1`,
        [job.id],
      )) as [{ mode: string }];
      expect(mode).toBe('BATCH');
    },
  );

  gate()(
    'lease-based polling never hands the same job to two workers',
    async () => {
      const tenant = await newTenant();
      const { service } = mkService();
      // Isolate from other tests' rows — the poll sweep is global (not tenant-scoped).
      await ds!.query(`DELETE FROM ai_batch_items`);
      await ds!.query(`DELETE FROM ai_batch_jobs`);
      const ids: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const [row] = (await ds!.query(
          `INSERT INTO ai_batch_jobs (tenant_id, feature, endpoint, model, idempotency_key, status, external_batch_id, next_poll_at)
         VALUES ($1,'file_indexing','/v1/embeddings','m',$2,'SUBMITTED','ext', now() - interval '1 minute') RETURNING id`,
          [tenant, `lease-${randomUUID()}`],
        )) as Array<{ id: string }>;
        ids.push(row.id);
      }
      const lease = (
        service as unknown as {
          leasePollableJobs: (n: number) => Promise<string[]>;
        }
      ).leasePollableJobs.bind(service);
      const first = await lease(10);
      const second = await lease(10); // immediately after — all are leased forward
      expect(first.sort()).toEqual([...ids].sort()); // exactly the two due jobs
      expect(second).toHaveLength(0); // none re-leased while the lease holds
    },
  );

  gate()('enforces tenant isolation on job rows', async () => {
    const a = await newTenant();
    const b = await newTenant();
    const { service, jobs } = mkService();
    const job = await service.submitEmbeddingBatch({
      tenantId: a,
      feature: AI_FEATURE.FILE_INDEXING,
      agentId: randomUUID(),
      items: [{ targetRef: 'kb-1' }],
      idempotencyKey: `iso-${randomUUID()}`,
      sourceType: 'training_file',
      sourceId: 'file-iso',
    });
    expect(await jobs.findOneBy({ id: job.id, tenant_id: b })).toBeNull();
    expect(await jobs.findOneBy({ id: job.id, tenant_id: a })).not.toBeNull();
  });
});

describe('Data residency — real Postgres, fail-closed (no OpenAI)', () => {
  gate()(
    'fails closed with AI_COMPLIANCE_ROUTE_UNAVAILABLE for an SSRF base URL',
    async () => {
      const tenant = await newTenant();
      const enc = new EncryptionService(
        new ConfigService({ CREDENTIALS_ENCRYPTION_KEY: ENC_KEY }),
      );
      enc.onModuleInit();
      const deployments: Repository<TenantAiDeployment> =
        ds!.getRepository(TenantAiDeployment);
      await deployments.save(
        deployments.create({
          tenant_id: tenant,
          enabled: true,
          region: 'eu',
          allowed_regions: ['eu'],
          base_url: 'https://169.254.169.254/latest',
          api_key_ciphertext: enc.encrypt('sk-secret')!,
        }),
      );
      const svc = new AiDataResidencyService(
        new ConfigService({ AI_DATA_RESIDENCY_ENABLED: 'true' }) as never,
        enc as never,
        deployments as never,
      );
      await expect(svc.resolve(tenant)).rejects.toMatchObject({
        context: { reason: 'AI_COMPLIANCE_ROUTE_UNAVAILABLE' },
      });
    },
  );

  gate()('is not enforced when residency is disabled (default)', async () => {
    const tenant = await newTenant();
    const enc = new EncryptionService(
      new ConfigService({ CREDENTIALS_ENCRYPTION_KEY: ENC_KEY }),
    );
    const svc = new AiDataResidencyService(
      new ConfigService({}) as never, // AI_DATA_RESIDENCY_ENABLED unset → false
      enc as never,
      ds!.getRepository(TenantAiDeployment) as never,
    );
    expect((await svc.resolve(tenant)).enforced).toBe(false);
  });
});
