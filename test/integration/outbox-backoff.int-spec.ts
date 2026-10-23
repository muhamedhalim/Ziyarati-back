/**
 * CR-09 - the transactional outbox keeps retrying through a Redis outage, and parked rows can be
 * seen and re-driven. Real PostgreSQL (the real claim SQL, the new `next_attempt_at` column from
 * the real migration chain), a fake queue that fails on demand.
 *
 * Runs against a throwaway DB created from DATABASE_URL. Skips cleanly if the DB is unreachable
 * locally, but FAILS under CI so a missing database can never read as a pass (CR-13).
 *
 * Run: npx jest --config test/jest-integration.json test/integration/outbox-backoff.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { OutboxJob } from '../../src/entities/Campaigns/OutboxJob';
import { OutboxStatus } from '../../src/entities/enums';
import { OutboxRelayService } from '../../src/worker/outbox-relay.service';
import { MonitoringService } from '../../src/modules/platform-monitoring/monitoring.service';

const TEST_DB = process.env.INTEGRATION_TEST_DB_OUTBOX ?? 'ziyarati_inttest_outbox';
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
    // Several migrations set `transaction = false` (CREATE INDEX CONCURRENTLY); see workflow-claim.
    migrationsTransactionMode: 'each' as const,
  });
  await ds.initialize();
  await ds.runMigrations();
}

beforeAll(async () => {
  if (!BASE) {
    if (process.env.CI) throw new Error('DATABASE_URL is required for the outbox integration test in CI');
    return;
  }
  try {
    await boot();
    available = true;
  } catch (e) {
    if (process.env.CI) throw e;
    console.warn('Outbox integration test skipped (no DB):', (e as Error).message);
  }
}, 120_000);

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (!available) return;
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await a.end();
}, 60_000);

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!available) return;
    await fn();
  }, 60_000);

function relay(queue: { publish: jest.Mock }) {
  const svc = new OutboxRelayService(ds as DataSource, {
    ...queue,
    hasEnqueueHeadroom: jest.fn().mockResolvedValue(true),
  } as never);
  return { drain: () => (svc as unknown as { drainBatch: () => Promise<void> }).drainBatch() };
}

async function insertRow(over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await (ds as DataSource).query(
    `INSERT INTO outbox_jobs (id, queue, job_name, dedupe_key, payload, status, publish_attempts)
     VALUES ($1, 'analytics', 'analytics.aggregate', $2, '{"tenantId":null}', $3, $4)`,
    [id, `dk-${id}`, over.status ?? 'PENDING', over.attempts ?? 0],
  );
  return id;
}

const rowOf = async (id: string) =>
  (await (ds as DataSource).getRepository(OutboxJob).findOneByOrFail({ id })) as OutboxJob;

describe('transactional outbox - backoff, exhaustion, re-drive (CR-09)', () => {
  maybe('the migration adds a nullable next_attempt_at column', async () => {
    const [col] = await (ds as DataSource).query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'outbox_jobs' AND column_name = 'next_attempt_at'`,
    );
    expect(col).toEqual({ is_nullable: 'YES', data_type: 'timestamp with time zone' });
  });

  maybe('a failed publish is NOT re-claimed until its backoff elapses, then succeeds', async () => {
    const id = await insertRow();
    const publish = jest.fn().mockRejectedValueOnce(new Error('redis failover')).mockResolvedValue({});
    const { drain } = relay({ publish });

    await drain(); // fails -> PENDING with a future next_attempt_at
    let row = await rowOf(id);
    expect(row.status).toBe(OutboxStatus.PENDING);
    expect(row.publish_attempts).toBe(1);
    expect(row.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());

    await drain(); // still inside the backoff: must not even try
    expect(publish).toHaveBeenCalledTimes(1);

    await (ds as DataSource).query(`UPDATE outbox_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
    await drain(); // due now
    expect(publish).toHaveBeenCalledTimes(2);
    row = await rowOf(id);
    expect(row.status).toBe(OutboxStatus.PUBLISHED);
    expect(row.next_attempt_at).toBeNull();
  });

  maybe('ten failures in a row no longer park a row; exhaustion does, and re-drive revives it', async () => {
    const id = await insertRow({ attempts: 9 });
    const publish = jest.fn().mockRejectedValue(new Error('redis down for a while'));
    const { drain } = relay({ publish });

    await drain(); // attempt 10: used to be FAILED, now still PENDING
    expect((await rowOf(id)).status).toBe(OutboxStatus.PENDING);

    await (ds as DataSource).query(
      `UPDATE outbox_jobs SET publish_attempts = 19, next_attempt_at = NULL WHERE id = $1`,
      [id],
    );
    await drain(); // attempt 20: exhausted
    let row = await rowOf(id);
    expect(row.status).toBe(OutboxStatus.FAILED);
    expect(row.next_attempt_at).toBeNull();

    const monitoring = new MonitoringService({} as never, {} as never, ds as never, {} as never, {} as never, {} as never, {} as never);
    const res = await monitoring.redriveFailedOutbox(10);
    expect(res.redriven).toBeGreaterThanOrEqual(1);
    row = await rowOf(id);
    expect(row.status).toBe(OutboxStatus.PENDING);
    expect(row.publish_attempts).toBe(0);
    expect(row.next_attempt_at).toBeNull();

    publish.mockReset().mockResolvedValue({});
    await drain();
    expect((await rowOf(id)).status).toBe(OutboxStatus.PUBLISHED);
  });
});
