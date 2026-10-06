/**
 * REAL-DATABASE integration test — the retention engine (residency plan P12).
 *
 * Builds a throwaway database from the full migration chain and proves, against
 * PostgreSQL, that the retention statements:
 *  - remove ONLY rows older than the configured age, and only eligible ones
 *    (unprocessed webhooks, pending reminders and young rows survive);
 *  - scrub rather than delete where that is the declared action;
 *  - work across more than one batch;
 *  - do nothing at all when no setting is given, and nothing in a dry run;
 *  - never touch clinical, identity or financial tables;
 *  - leave evidence that names tables and counts only.
 *
 * Skips cleanly when no database is reachable. Run:
 *   DATABASE_URL=postgres://... npx jest --config test/jest-integration.json test/integration/retention.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { DeletionEvidence } from '../../src/entities/Governance/DeletionEvidence';
import {
  PLATFORM_TENANT_ID,
  RETENTION_BATCH_SIZE,
  RetentionService,
} from '../../src/modules/data-governance/retention.service';
import { PgFactory, type World } from './support/pg-factory';

const TEST_DB =
  process.env.INTEGRATION_TEST_DB_RETENTION ?? 'ziyarati_inttest_retention';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

let ds: DataSource | null = null;
let available = false;
let factory: PgFactory;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

const count = async (
  table: string,
  where = 'true',
  ...p: unknown[]
): Promise<number> =>
  Number(
    (
      await ds!.query(
        `SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`,
        p,
      )
    )[0].n,
  );

async function boot() {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  ds = new DataSource({
    type: 'postgres',
    url: testUrl,
    entities: [DeletionEvidence],
    migrations: [join(process.cwd(), 'src', 'migrations', '!(*.spec).{ts,js}')],
    migrationsTransactionMode: 'each',
    synchronize: false,
    logging: false,
  });
  await ds.initialize();
  await ds.runMigrations();
  factory = new PgFactory(ds);
  await factory.load();
}

beforeAll(async () => {
  if (!BASE) return;
  try {
    await boot();
    available = true;
  } catch (e) {
    console.warn(
      'Retention integration test skipped (no DB):',
      (e as Error).message,
    );
  }
}, 300_000);

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (!available) return;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.end();
}, 60_000);

const runIf = (name: string, fn: () => Promise<void>, timeout = 180_000) =>
  it(
    name,
    async () => {
      if (!available) return;
      await fn();
    },
    timeout,
  );

const svc = (settings: Record<string, string>) =>
  new RetentionService(ds!, new ConfigService(settings));

interface Seed {
  w: World;
  tenant: string;
  /** Rows that must survive any run, so a sweep that over-reaches is caught. */
  protectedBefore: Record<string, number>;
}

async function seed(): Promise<Seed> {
  await ds!.query(`TRUNCATE "tenants" CASCADE`);
  await ds!.query(`TRUNCATE "deletion_evidence"`);
  const w = factory.world();
  const tenant = await w.make('tenants');
  const t = { tenantId: tenant };

  // email_logs: old and young
  await w.make('email_logs', {
    tenant_id: tenant,
    to_address: 'old@example.com',
    created_at: ago(100),
  });
  await w.make('email_logs', {
    tenant_id: tenant,
    to_address: 'old2@example.com',
    created_at: ago(40),
  });
  await w.make('email_logs', {
    tenant_id: tenant,
    to_address: 'young@example.com',
    created_at: ago(2),
  });

  // whatsapp_webhooks: old processed (eligible), old UNprocessed (never), young processed
  await w.make('whatsapp_webhooks', {
    ...t,
    processed: true,
    created_at: ago(60),
    payload: { from: '966501234567' },
  });
  await w.make('whatsapp_webhooks', {
    ...t,
    processed: false,
    created_at: ago(60),
    payload: { from: '966501111111' },
  });
  await w.make('whatsapp_webhooks', {
    ...t,
    processed: true,
    created_at: ago(1),
    payload: { from: '966502222222' },
  });

  // scheduled_notifications: old terminal (scrub), old pending (keep), young terminal (keep)
  await w.make('scheduled_notifications', {
    ...t,
    status: 'SENT',
    created_at: ago(60),
    variables: { name: 'Sara' },
    failure_reason: 'x',
  });
  await w.make('scheduled_notifications', {
    ...t,
    status: 'PENDING',
    created_at: ago(60),
    variables: { name: 'Omar' },
  });
  await w.make('scheduled_notifications', {
    ...t,
    status: 'SENT',
    created_at: ago(1),
    variables: { name: 'Hana' },
  });

  // ai_messages: old and young
  const aiConv = await w.make('ai_conversations', { ...t });
  await w.make('ai_messages', {
    ...t,
    ai_conversation_id: aiConv,
    content: 'old transcript',
    created_at: ago(200),
  });
  await w.make('ai_messages', {
    ...t,
    ai_conversation_id: aiConv,
    content: 'young transcript',
    created_at: ago(1),
  });

  // Protected: clinical, identity, financial, audit — all ancient.
  const customer = await w.make('customers', { ...t, created_at: ago(5000) });
  const c = { customerId: customer, tenantId: tenant };
  await w.make('clinical_entries', {
    ...c,
    data: { dx: 'x' },
    created_at: ago(5000),
  });
  await w.make('customer_profiles', {
    customer_id: customer,
    tenantId: tenant,
    medical_history: 'asthma',
  });
  await w.make('invoices', { ...c, total_amount: 10, created_at: ago(5000) });
  await w.make('payments', { ...c, amount: 10, created_at: ago(5000) });
  await w.make('clinical_access_logs', {
    ...c,
    scope: 'timeline',
    created_at: ago(5000),
  });

  const protectedBefore: Record<string, number> = {};
  for (const table of [
    'customers',
    'clinical_entries',
    'customer_profiles',
    'invoices',
    'payments',
    'clinical_access_logs',
  ]) {
    protectedBefore[table] = await count(table);
  }
  return { w, tenant, protectedBefore };
}

const ALL = {
  RETENTION_EMAIL_LOGS_DAYS: '30',
  RETENTION_WHATSAPP_WEBHOOKS_DAYS: '30',
  RETENTION_SCHEDULED_NOTIFICATION_VARIABLES_DAYS: '30',
  RETENTION_AI_TRANSCRIPTS_DAYS: '30',
};

describe('RetentionService against real PostgreSQL', () => {
  runIf('with no setting nothing is touched, even on a real run', async () => {
    await seed();
    const before = [
      await count('email_logs'),
      await count('whatsapp_webhooks'),
      await count('ai_messages'),
    ];
    const r = await svc({}).run({ dryRun: false });
    expect(r.targets.every((t) => t.skipped === 'no_setting')).toBe(true);
    expect([
      await count('email_logs'),
      await count('whatsapp_webhooks'),
      await count('ai_messages'),
    ]).toEqual(before);
    expect(await count('deletion_evidence')).toBe(0);
  });

  runIf('a dry run reports exact counts and changes nothing', async () => {
    await seed();
    const r = await svc(ALL).run({ dryRun: true });
    const by = (id: string) => r.targets.find((t) => t.id === id)!.affected;
    expect(by('EMAIL_LOGS')).toBe(2);
    expect(by('WHATSAPP_WEBHOOKS')).toBe(1); // the unprocessed one is not eligible
    expect(by('SCHEDULED_NOTIFICATION_VARIABLES')).toBe(1); // pending and young are not
    expect(by('AI_TRANSCRIPTS')).toBe(1);
    expect(await count('email_logs')).toBe(3);
    expect(await count('whatsapp_webhooks')).toBe(3);
    expect(await count('ai_messages')).toBe(2);
    expect(await count('deletion_evidence')).toBe(0);
  });

  runIf(
    'a real run removes only aged, eligible rows and leaves protected data alone',
    async () => {
      const s = await seed();
      const r = await svc(ALL).run({ dryRun: false });

      // email_logs: both old rows gone, the young one stays.
      expect(
        (await ds!.query(`SELECT "to_address" FROM "email_logs"`)).map(
          (x: { to_address: string }) => x.to_address,
        ),
      ).toEqual(['young@example.com']);
      // webhooks: old+processed gone; old+unprocessed and young stay.
      expect(await count('whatsapp_webhooks')).toBe(2);
      expect(
        await count(
          'whatsapp_webhooks',
          `"processed" = false AND "created_at" < now() - interval '30 days'`,
        ),
      ).toBe(1);
      // scheduled: the old SENT row is SCRUBBED (row kept), pending and young untouched.
      expect(await count('scheduled_notifications')).toBe(3);
      const rows = await ds!.query(
        `SELECT "status", "variables", "failure_reason" FROM "scheduled_notifications" ORDER BY "created_at"`,
      );
      expect(rows[0]).toEqual({
        status: 'SENT',
        variables: {},
        failure_reason: null,
      });
      expect(rows[1].variables).toEqual({ name: 'Omar' }); // PENDING, old — must still be sendable
      expect(rows[2].variables).toEqual({ name: 'Hana' });
      // transcripts
      expect(
        (await ds!.query(`SELECT "content" FROM "ai_messages"`)).map(
          (x: { content: string }) => x.content,
        ),
      ).toEqual(['young transcript']);

      // Nothing clinical, identity, financial or audit was touched.
      for (const [table, n] of Object.entries(s.protectedBefore))
        expect(await count(table)).toBe(n);
      expect(
        (
          await ds!.query(`SELECT "medical_history" FROM "customer_profiles"`)
        )[0].medical_history,
      ).toBe('asthma');
      expect(
        (await ds!.query(`SELECT "data" FROM "clinical_entries"`))[0].data,
      ).toEqual({ dx: 'x' });

      // Evidence: platform-scoped, tables and counts only.
      const [ev] = await ds!.query(
        `SELECT * FROM "deletion_evidence" WHERE "id" = $1`,
        [r.evidenceId],
      );
      expect(ev.scope).toBe('RETENTION');
      expect(ev.tenant_id).toBe(PLATFORM_TENANT_ID);
      expect(ev.subject_id).toBeNull();
      const text = JSON.stringify(ev);
      for (const secret of [
        'old@example.com',
        '966501234567',
        'Sara',
        'old transcript',
      ])
        expect(text).not.toContain(secret);
      expect(
        (ev.report.stores as Array<{ target: string; affected: number }>).map(
          (x) => [x.target, x.affected],
        ),
      ).toEqual(
        expect.arrayContaining([
          ['email_logs', 2],
          ['whatsapp_webhooks', 1],
          ['scheduled_notifications', 1],
          ['ai_messages', 1],
        ]),
      );
    },
  );

  runIf(
    'is idempotent — a second run finds nothing more and writes no new evidence',
    async () => {
      await seed();
      await svc(ALL).run({ dryRun: false });
      const evidenceBefore = await count('deletion_evidence');
      const again = await svc(ALL).run({ dryRun: false });
      expect(again.targets.every((t) => t.affected === 0)).toBe(true);
      expect(again.evidenceId).toBeUndefined();
      expect(await count('deletion_evidence')).toBe(evidenceBefore);
    },
  );

  runIf('works across more than one batch', async () => {
    const s = await seed();
    const extra = RETENTION_BATCH_SIZE + 250;
    // A real bulk load in one statement, so the batch loop runs more than once.
    await ds!.query(
      `INSERT INTO "email_logs" ("id", "to_address", "tenant_id", "created_at", "status", "provider", "template", "attempts")
         SELECT gen_random_uuid(), 'bulk' || g || '@example.com', $1, now() - interval '90 days', 'SENT', 'resend', 'x', 1
           FROM generate_series(1, $2) g`,
      [s.tenant, extra],
    );
    const r = await svc({ RETENTION_EMAIL_LOGS_DAYS: '30' }).run({
      dryRun: false,
    });
    expect(r.targets.find((t) => t.id === 'EMAIL_LOGS')?.affected).toBe(
      extra + 2,
    );
    expect(await count('email_logs')).toBe(1);
  });
});
