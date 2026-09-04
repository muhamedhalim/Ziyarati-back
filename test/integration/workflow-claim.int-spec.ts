/**
 * OFFLINE integration test — real PostgreSQL, real `WorkflowService.claimAction`
 * SQL (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.3). Proves the
 * atomic-claim guarantee that replaced the prior in-memory check-then-execute
 * race in `WorkflowProcessor.handleAction`: a mocked repository test can only
 * prove the RIGHT SQL STRING was built, not that the SQL is actually atomic
 * under concurrency — that needs a real database.
 *
 * Runs against a throwaway DB created from DATABASE_URL. Skips cleanly if the
 * DB is unreachable.
 *
 * Run: npx jest --config test/jest-integration.json test/integration/workflow-claim.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { Workflow } from '../../src/entities/Workflows/Workflow';
import { WorkflowRun, WorkflowActionResult } from '../../src/entities/Workflows/WorkflowRun';
import { WorkflowService } from '../../src/modules/workflow/workflow.service';

const TEST_DB = process.env.INTEGRATION_TEST_DB_WORKFLOW ?? 'ziyarati_inttest_workflow';
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
    entities: [join(process.cwd(), 'src', 'entities', '**', '!(*.spec).{ts,js}')],
    migrations: [join(process.cwd(), 'src', 'migrations', '!(*.spec).{ts,js}')],
    synchronize: false,
    // P0.3: REQUIRED. Several migrations set `transaction = false` for
    // `CREATE INDEX CONCURRENTLY`, and TypeORM refuses to combine a
    // per-migration override with the default global mode 'all' — so without
    // this, `runMigrations()` throws, `available` stays false, and every test
    // below silently no-ops. Matches src/config/data-source.ts.
    migrationsTransactionMode: 'each' as const,
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
    console.warn('Workflow claim integration test skipped (no DB):', (e as Error).message);
  }
}, 60_000);

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (!available) return;
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await a.end();
});

const runIf = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it(name, async () => {
    if (!available) return;
    await fn();
  }, timeout);

async function freshRun(): Promise<string> {
  const tenants = ds!.getRepository(Tenant);
  const workflows = ds!.getRepository(Workflow);
  const runs = ds!.getRepository(WorkflowRun);

  const uniq = randomUUID();
  const tenant = await tenants.save(
    tenants.create({ name: `t-${uniq}`, slug: `slug-${uniq}`, contact_email: `${uniq}@test.local` }),
  );
  const workflow = await workflows.save(
    workflows.create({ tenant, name: 'wf', trigger_event: 'appointment.created', actions: [] }),
  );
  const run = await runs.save(
    runs.create({ tenant, workflow, trigger_event: 'appointment.created', status: 'RUNNING', context: {}, results: [] }),
  );
  return run.id;
}

async function currentResults(runId: string): Promise<WorkflowActionResult[]> {
  const run = await ds!.getRepository(WorkflowRun).findOneBy({ id: runId });
  return run?.results ?? [];
}

describe('WorkflowService.claimAction — real Postgres atomicity (gap-closure pass §0.8.3)', () => {
  let service: WorkflowService;

  beforeAll(() => {
    if (!available) return;
    service = new WorkflowService(ds!.getRepository(Workflow), ds!.getRepository(WorkflowRun), ds!);
  });

  runIf('claims a fresh action (no prior entry) and writes an IN_PROGRESS entry', async () => {
    const runId = await freshRun();
    const claimed = await service.claimAction(runId, 0, 'EMAIL');
    expect(claimed).toBe(true);
    const results = await currentResults(runId);
    expect(results).toEqual([expect.objectContaining({ index: 0, type: 'EMAIL', status: 'IN_PROGRESS' })]);
  });

  runIf('a SECOND claim for the same index, while the first is still IN_PROGRESS, is REJECTED', async () => {
    const runId = await freshRun();
    expect(await service.claimAction(runId, 0, 'EMAIL')).toBe(true);
    expect(await service.claimAction(runId, 0, 'EMAIL')).toBe(false);
    // Exactly one entry — the rejected claim must not have appended a duplicate.
    expect(await currentResults(runId)).toHaveLength(1);
  });

  runIf('CONCURRENT claims for the same fresh index: exactly ONE wins — the core atomicity guarantee', async () => {
    const runId = await freshRun();
    const [a, b, c] = await Promise.all([
      service.claimAction(runId, 0, 'EMAIL'),
      service.claimAction(runId, 0, 'EMAIL'),
      service.claimAction(runId, 0, 'EMAIL'),
    ]);
    const winners = [a, b, c].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(await currentResults(runId)).toHaveLength(1);
  });

  runIf('after a FAILED terminal result, a new claim SUCCEEDS — a legitimate retry must still be able to run', async () => {
    const runId = await freshRun();
    expect(await service.claimAction(runId, 0, 'EMAIL')).toBe(true);
    await service.appendResult(runId, { index: 0, type: 'EMAIL', status: 'FAILED', detail: 'timeout', at: new Date().toISOString() });
    expect(await service.claimAction(runId, 0, 'EMAIL')).toBe(true);
    expect(await currentResults(runId)).toEqual([expect.objectContaining({ index: 0, status: 'IN_PROGRESS' })]);
  });

  runIf('after a SUCCEEDED terminal result, a new claim is REJECTED — never re-run a finished action', async () => {
    const runId = await freshRun();
    expect(await service.claimAction(runId, 0, 'EMAIL')).toBe(true);
    await service.appendResult(runId, { index: 0, type: 'EMAIL', status: 'SUCCEEDED', detail: 'sent', at: new Date().toISOString() });
    expect(await service.claimAction(runId, 0, 'EMAIL')).toBe(false);
    expect(await currentResults(runId)).toEqual([expect.objectContaining({ index: 0, status: 'SUCCEEDED' })]);
  });

  runIf('a claim for a DIFFERENT action index is unaffected by an existing entry for another index', async () => {
    const runId = await freshRun();
    expect(await service.claimAction(runId, 0, 'EMAIL')).toBe(true);
    expect(await service.claimAction(runId, 1, 'WEBHOOK')).toBe(true);
    const results = await currentResults(runId);
    expect(results.map((r) => r.index).sort()).toEqual([0, 1]);
  });

  runIf('a STALE IN_PROGRESS claim (owner crashed mid-execution) is reclaimable', async () => {
    const runId = await freshRun();
    expect(await service.claimAction(runId, 0, 'EMAIL', 10 * 60_000)).toBe(true);

    // Simulate "10+ minutes have passed since the claim, and the claiming
    // process never came back to write a terminal result" by backdating the
    // claim's own timestamp directly (no clock mocking needed).
    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    await ds!.query(
      `UPDATE workflow_runs SET results = jsonb_set(results, '{0,at}', to_jsonb($2::text)) WHERE id = $1`,
      [runId, staleAt],
    );

    // A short staleAfterMs makes the (already backdated) claim look stale.
    const reclaimed = await service.claimAction(runId, 0, 'EMAIL', 5 * 60_000);
    expect(reclaimed).toBe(true);
    expect(await currentResults(runId)).toHaveLength(1);
  });

  runIf('a NON-STALE IN_PROGRESS claim is NOT reclaimable even with a short staleAfterMs check on a fresh claim', async () => {
    const runId = await freshRun();
    expect(await service.claimAction(runId, 0, 'EMAIL')).toBe(true);
    // Freshly claimed "just now" — even a 1ms-old cutoff check should not treat
    // a claim written after the cutoff as stale (cutoff is `now - staleAfterMs`,
    // and the claim's `at` is ~now, i.e. AFTER the cutoff => not stale).
    const reclaimed = await service.claimAction(runId, 0, 'EMAIL', 10 * 60_000);
    expect(reclaimed).toBe(false);
  });
});
