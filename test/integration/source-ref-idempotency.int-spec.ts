/**
 * OFFLINE integration test — real PostgreSQL (gap-closure pass — see
 * docs/CACHING_QUEUES_AUDIT.md §0.11). Proves the partial-unique-index
 * guarantee added by migration `WorkflowActionSourceRef1730016000000`: a
 * mocked-repository unit test can only prove "the code catches an error
 * shaped like 23505", not that Postgres actually SERIALIZES two concurrent
 * inserts of the same `source_ref` into exactly one winner — that needs a
 * real database, same lesson as `workflow-claim.int-spec.ts` (which caught a
 * genuine TypeORM API-usage bug that every mock had missed).
 *
 * Covers the two NEW call sites that rely on this constraint:
 *   - WhatsappExecutionService.claimBySourceRef  (workflow WHATSAPP action)
 *   - NotificationSchedulerService.schedule      (workflow NOTIFICATION action)
 *
 * Runs against a throwaway DB created from DATABASE_URL. Skips cleanly if the
 * DB is unreachable.
 *
 * Run: npx jest --config test/jest-integration.json test/integration/source-ref-idempotency.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { NotificationLog } from '../../src/entities/Notifications/NotificationLog';
import { ScheduledNotification } from '../../src/entities/Notifications/ScheduledNotification';
import { WhatsappContact } from '../../src/entities/WhatsApp/WhatsappContact';
import { Customer } from '../../src/entities/CRM/Customer';
import { NotificationTemplate } from '../../src/entities/Notifications/NotificationTemplate';
import { Appointment } from '../../src/entities/Calendar&Appointments/Appointment';
import { WhatsappExecutionService } from '../../src/modules/whatsapp/whatsapp-execution.service';
import { NotificationSchedulerService } from '../../src/modules/notifications/notification-scheduler.service';
import { WHATSAPP_CHANNEL } from '../../src/modules/whatsapp/whatsapp.constants';
import { NOTIFICATION_STATUS } from '../../src/modules/notifications/notification.constants';

const TEST_DB = process.env.INTEGRATION_TEST_DB_SOURCE_REF ?? 'ziyarati_inttest_source_ref';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

let ds: DataSource | null = null;
let available = false;
let tenantId = '';

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
  });
  await ds.initialize();
  await ds.runMigrations();

  const uniq = randomUUID();
  const tenant = await ds.getRepository(Tenant).save(
    ds.getRepository(Tenant).create({ name: `t-${uniq}`, slug: `slug-${uniq}`, contact_email: `${uniq}@test.local` }),
  );
  tenantId = tenant.id;
}

beforeAll(async () => {
  if (!BASE) return;
  try {
    await boot();
    available = true;
  } catch (e) {
    console.warn('source_ref idempotency integration test skipped (no DB):', (e as Error).message);
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

describe('NotificationLog.source_ref — real Postgres partial-unique-index atomicity (gap-closure pass §0.11)', () => {
  let service: WhatsappExecutionService;

  beforeAll(() => {
    if (!available) return;
    service = new WhatsappExecutionService(
      ds!.getRepository(NotificationLog),
      ds!.getRepository(WhatsappContact),
      ds!.getRepository(Customer),
      undefined as never, // router — not exercised by claimBySourceRef/finalizeBySourceRef
      undefined as never, // templates
      undefined as never, // messaging
      undefined as never, // queue
      undefined as never, // usage
      undefined as never, // ctx
    );
  });

  runIf('claims a fresh sourceRef by inserting a SENDING row', async () => {
    const ref = `workflow-action:${randomUUID()}:0`;
    const res = await service.claimBySourceRef(tenantId, WHATSAPP_CHANNEL, ref);
    expect(res.claimed).toBe(true);
    expect(res.log.status).toBe('SENDING');
  });

  runIf('a SECOND claim for the SAME sourceRef is rejected and returns the EXISTING row, not a new one', async () => {
    const ref = `workflow-action:${randomUUID()}:0`;
    const first = await service.claimBySourceRef(tenantId, WHATSAPP_CHANNEL, ref);
    const second = await service.claimBySourceRef(tenantId, WHATSAPP_CHANNEL, ref);

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.log.id).toBe(first.log.id);

    const count = await ds!.getRepository(NotificationLog).count({ where: { source_ref: ref } });
    expect(count).toBe(1); // never two rows for the same business key
  });

  runIf('CONCURRENT claims for the SAME fresh sourceRef: exactly ONE wins — the core atomicity guarantee', async () => {
    const ref = `workflow-action:${randomUUID()}:0`;
    const results = await Promise.all([
      service.claimBySourceRef(tenantId, WHATSAPP_CHANNEL, ref),
      service.claimBySourceRef(tenantId, WHATSAPP_CHANNEL, ref),
      service.claimBySourceRef(tenantId, WHATSAPP_CHANNEL, ref),
    ]);
    const winners = results.filter((r) => r.claimed);
    expect(winners).toHaveLength(1);

    const count = await ds!.getRepository(NotificationLog).count({ where: { source_ref: ref } });
    expect(count).toBe(1);
  });

  runIf('finalizeBySourceRef updates the SAME claimed row in place (no second row)', async () => {
    const ref = `workflow-action:${randomUUID()}:0`;
    const claim = await service.claimBySourceRef(tenantId, WHATSAPP_CHANNEL, ref);
    await service.finalizeBySourceRef(claim.log.id, 'SENT', { providerRef: 'wamid.xyz', sentAt: new Date() });

    const row = await ds!.getRepository(NotificationLog).findOneBy({ id: claim.log.id });
    expect(row?.status).toBe('SENT');
    expect(row?.provider_ref).toBe('wamid.xyz');
    const count = await ds!.getRepository(NotificationLog).count({ where: { source_ref: ref } });
    expect(count).toBe(1);
  });

  runIf('two DIFFERENT sourceRefs never collide with each other', async () => {
    const refA = `workflow-action:${randomUUID()}:0`;
    const refB = `workflow-action:${randomUUID()}:1`;
    const a = await service.claimBySourceRef(tenantId, WHATSAPP_CHANNEL, refA);
    const b = await service.claimBySourceRef(tenantId, WHATSAPP_CHANNEL, refB);
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
    expect(a.log.id).not.toBe(b.log.id);
  });
});

describe('ScheduledNotification.source_ref — real Postgres partial-unique-index atomicity (gap-closure pass §0.11)', () => {
  let service: NotificationSchedulerService;
  let queue: { enqueueNotificationDispatch: jest.Mock };

  beforeAll(() => {
    if (!available) return;
    queue = { enqueueNotificationDispatch: jest.fn().mockResolvedValue(undefined) };
    service = new NotificationSchedulerService(
      ds!.getRepository(ScheduledNotification),
      ds!.getRepository(NotificationTemplate),
      ds!.getRepository(Appointment),
      undefined as never, // dispatch — not exercised by schedule()
      queue as never,
    );
  });

  const dto = () => ({
    recipientType: 'CUSTOMER',
    recipientId: randomUUID(),
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
  });

  runIf('creates exactly one row and enqueues exactly one dispatch job for a fresh sourceRef', async () => {
    const ref = `workflow-action:${randomUUID()}:2`;
    queue.enqueueNotificationDispatch.mockClear();

    const row = await service.schedule(tenantId, dto() as never, ref);

    expect(row.source_ref).toBe(ref);
    expect(queue.enqueueNotificationDispatch).toHaveBeenCalledTimes(1);
    const count = await ds!.getRepository(ScheduledNotification).count({ where: { source_ref: ref } });
    expect(count).toBe(1);
  });

  runIf('a SECOND schedule() call for the SAME sourceRef returns the EXISTING row and enqueues NO second dispatch job', async () => {
    const ref = `workflow-action:${randomUUID()}:2`;
    queue.enqueueNotificationDispatch.mockClear();

    const first = await service.schedule(tenantId, dto() as never, ref);
    const second = await service.schedule(tenantId, dto() as never, ref);

    expect(second.id).toBe(first.id);
    expect(queue.enqueueNotificationDispatch).toHaveBeenCalledTimes(1); // only the FIRST call enqueued
    const count = await ds!.getRepository(ScheduledNotification).count({ where: { source_ref: ref } });
    expect(count).toBe(1); // never two independently-dispatched rows for the same action
  });

  runIf('CONCURRENT schedule() calls for the SAME fresh sourceRef: exactly ONE row is ever created', async () => {
    const ref = `workflow-action:${randomUUID()}:3`;
    queue.enqueueNotificationDispatch.mockClear();

    await Promise.all([
      service.schedule(tenantId, dto() as never, ref),
      service.schedule(tenantId, dto() as never, ref),
      service.schedule(tenantId, dto() as never, ref),
    ]);

    const count = await ds!.getRepository(ScheduledNotification).count({ where: { source_ref: ref } });
    expect(count).toBe(1);
  });

  runIf('a schedule() call with NO sourceRef (the public HTTP endpoint) is entirely unaffected — always creates its own row', async () => {
    const before = await ds!.getRepository(ScheduledNotification).count();
    await service.schedule(tenantId, dto() as never); // no sourceRef
    await service.schedule(tenantId, dto() as never); // no sourceRef
    const after = await ds!.getRepository(ScheduledNotification).count();
    expect(after - before).toBe(2); // two independent rows, no collision (source_ref is NULL for both)
  });
});
