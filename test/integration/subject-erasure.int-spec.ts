/**
 * REAL-DATABASE integration test — patient erasure (residency plan P11 / P13).
 *
 * Builds a throwaway database by running the full migration chain from empty,
 * seeds one patient across every table the erasure plan names (plus control
 * patients in the same tenant and in another tenant), and proves — against
 * PostgreSQL itself — that:
 *
 *  - every statement in the plan executes;
 *  - the patient is anonymised, and only that patient, only in that tenant;
 *  - `clinical: 'retain'` keeps health content and `'erase'` removes it;
 *  - a dry run reports exact counts and changes nothing;
 *  - a failure part-way rolls the WHOLE transaction back;
 *  - the evidence record holds no personal data;
 *  - an erased patient's email / national id can be registered again.
 *
 * Mocks hid real-database bugs repeatedly in this codebase; this test exists
 * because the SQL here is destructive.
 *
 * Skips cleanly if no database is reachable. Run:
 *   DATABASE_URL=postgres://... npx jest --config test/jest-integration.json test/integration/subject-erasure.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { DeletionEvidence } from '../../src/entities/Governance/DeletionEvidence';
import { SubjectErasureService } from '../../src/modules/data-governance/subject-erasure.service';
import {
  ERASURE_STEPS,
  type ErasureStep,
} from '../../src/modules/data-governance/subject-erasure.registry';
import { PgFactory, type World } from './support/pg-factory';

const TEST_DB =
  process.env.INTEGRATION_TEST_DB_ERASURE ?? 'ziyarati_inttest_erasure';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

const NAME = 'Sara Alharbi';
const PHONE = '0501234567';
const WA_ID = '966501234567';
const EMAIL = 'sara.alharbi@example.com';
const NATIONAL_ID = '1012345678';

let ds: DataSource | null = null;
let available = false;
let factory: PgFactory;

const purged: string[] = [];
const storageFake = {
  purgeObject: jest.fn(async (key: string) => {
    purged.push(key);
    return { versionsRemoved: 2 };
  }),
};

interface Seeded {
  tenantA: string;
  tenantB: string;
  target: string;
  controlSame: string;
  controlOther: string;
  fileKey: string;
}

/** Tables holding rows for a patient, and the column that points at them. */
const SNAPSHOT: Array<[table: string, where: string]> = [
  ['customers', `"id" = $1`],
  ['customer_addresses', `"customerId" = $1`],
  ['customer_profiles', `"customer_id" = $1`],
  ['customer_notes', `"customerId" = $1`],
  ['customer_files', `"customerId" = $1`],
  ['appointments', `"customerId" = $1`],
  ['clinical_entries', `"customerId" = $1`],
  ['conversations', `"customerId" = $1`],
  ['whatsapp_contacts', `"customerId" = $1`],
  ['ai_memories', `"customer_id" = $1`],
  ['invoices', `"customerId" = $1`],
  ['payments', `"customerId" = $1`],
];

async function digest(customerId: string): Promise<string> {
  const parts: string[] = [];
  for (const [table, where] of SNAPSHOT) {
    const r = await ds!.query(
      `SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t."id"::text)), '-') AS d FROM "${table}" t WHERE ${where}`,
      [customerId],
    );
    parts.push(`${table}:${r[0].d}`);
  }
  return parts.join(',');
}

const count = async (
  table: string,
  where: string,
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

async function seedPatient(
  w: World,
  tenant: string,
  identity: {
    name: string;
    phone: string;
    waId: string;
    email: string;
    nationalId: string | null;
  },
  at: number,
): Promise<{ id: string; fileKey: string }> {
  const customer = await w.make('customers', {
    tenantId: tenant,
    full_name: identity.name,
    phone: identity.phone,
    whatsapp_id: identity.waId,
    whatsapp_name: identity.name,
    email: identity.email,
    national_id: identity.nationalId,
    date_of_birth: '1990-01-01',
    gender: 'F',
    source: 'walk-in',
    marketing_opt_in: true,
    chronic_diseases: 'diabetes',
    has_chronic_diseases: true,
    has_health_insurance: true,
    preferred_locale: 'ar',
  });
  const c = { customerId: customer, tenantId: tenant };

  await w.make('customer_addresses', { ...c, address_line: '12 Palm Street' });
  await w.make('whatsapp_contacts', {
    ...c,
    wa_id: identity.waId,
    display_name: identity.name,
  });
  await w.make('customer_profiles', {
    customer_id: customer,
    tenantId: tenant,
    medical_history: 'asthma',
    allergies: 'penicillin',
    blood_type: 'O+',
    emergency_contact_name: 'Ali',
    emergency_contact_phone: '0555555555',
    notes: 'prefers mornings',
  });
  await w.make('customer_notes', { ...c, content: 'patient reports asthma' });
  const fileKey = `${tenant}/patient_documents/${customer}.pdf`;
  await w.make('customer_files', {
    ...c,
    file_name: 'xray.pdf',
    storage_key: fileKey,
    file_url: fileKey,
    file_type: 'application/pdf',
  });
  await w.make('customer_tag_relations', { customerId: customer });

  const start = new Date(Date.UTC(2026, 10, 1 + at, 9, 0));
  const end = new Date(Date.UTC(2026, 10, 1 + at, 9, 30));
  const appointment = await w.make('appointments', {
    ...c,
    start_at: start,
    end_at: end,
    notes: 'follow up on diabetes',
  });
  await w.make('appointment_notes', {
    appointmentId: appointment,
    tenantId: tenant,
    content: 'asthma check',
  });
  await w.make('appointment_cancellations', {
    appointmentId: appointment,
    tenantId: tenant,
    reason: 'ill with flu',
  });
  await w.make('appointment_history', {
    appointmentId: appointment,
    tenantId: tenant,
    new_status: 'CONFIRMED',
    note: 'called patient',
  });
  await w.make('patient_action_links', {
    appointmentId: appointment,
    tenantId: tenant,
  });
  await w.make('clinical_entries', {
    ...c,
    data: { diagnosis: 'type 2 diabetes' },
  });
  await w.make('clinical_encounters', { ...c, summary: 'diabetes review' });
  await w.make('clinical_access_logs', { ...c, scope: 'timeline' });
  await w.make('customer_reviews', {
    ...c,
    appointment_id: appointment,
    rating: 5,
    comment: 'great doctor',
    reply: 'thanks',
  });
  await w.make('staff_ratings', {
    ...c,
    appointmentId: appointment,
    rating: 5,
    comment: 'kind',
  });
  await w.make('invoices', { ...c, total_amount: 100 });
  await w.make('payments', { ...c, amount: 100 });

  const conversation = await w.make('conversations', {
    ...c,
    handover_notes: 'asks about asthma meds',
    handover_reason: 'clinical question',
  });
  const message = await w.make('messages', {
    conversationId: conversation,
    tenantId: tenant,
    content: 'my asthma is worse',
    sender_type: 'CUSTOMER',
  });
  await w.make('message_attachments', {
    messageId: message,
    tenantId: tenant,
    file_url: 'https://media.example/x.jpg',
    file_name: 'x.jpg',
    file_type: 'image/jpeg',
    provider_media_id: 'media-1',
  });
  await w.make('handover_requests', {
    conversationId: conversation,
    tenantId: tenant,
    reason: 'wants a doctor',
    notes: 'urgent asthma',
  });
  const aiConv = await w.make('ai_conversations', {
    conversationId: conversation,
    tenantId: tenant,
    session: { name: identity.name },
  });
  await w.make('ai_messages', {
    tenantId: tenant,
    ai_conversation_id: aiConv,
    content: `${identity.name} ${identity.phone}`,
  });
  await w.make('ai_memories', {
    customer_id: customer,
    tenantId: tenant,
    content: 'prefers morning visits',
  });

  await w.make('email_logs', {
    tenant_id: tenant,
    to_address: identity.email.toUpperCase(),
    subject: 'Your appointment',
    metadata: { doctor: 'Dr Hana' },
    error: `bounced ${identity.email}`,
  });
  await w.make('notification_logs', {
    tenantId: tenant,
    recipient_id: customer,
    error_message: `invalid number ${identity.phone}`,
  });
  await w.make('scheduled_notifications', {
    tenantId: tenant,
    recipient_id: customer,
    status: 'PENDING',
    variables: { name: identity.name },
    failure_reason: 'x',
  });
  await w.make('whatsapp_webhooks', {
    tenantId: tenant,
    payload: { messages: [{ from: identity.waId, text: 'hello' }] },
  });
  await w.make('workflow_runs', {
    tenantId: tenant,
    context: { customerId: customer, name: identity.name },
    results: { sent: true },
  });
  const campaign = await w.make('campaigns', { tenantId: tenant });
  await w.make('campaign_recipients', {
    customerId: customer,
    campaignId: campaign,
    email: identity.email,
    failure_reason: 'x',
  });
  return { id: customer, fileKey };
}

async function boot() {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  ds = new DataSource({
    type: 'postgres',
    url: testUrl,
    // Only what the service itself persists through the ORM; everything else is raw SQL.
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

async function seed(): Promise<Seeded> {
  const wa = factory.world();
  const tenantA = await wa.make('tenants');
  const wb = factory.world();
  const tenantB = await wb.make('tenants');

  const t = await seedPatient(
    wa,
    tenantA,
    {
      name: NAME,
      phone: PHONE,
      waId: WA_ID,
      email: EMAIL,
      nationalId: NATIONAL_ID,
    },
    0,
  );
  const controlSame = await seedPatient(
    wa,
    tenantA,
    {
      name: 'Omar Control',
      phone: '0509999999',
      waId: '966509999999',
      email: 'omar@example.com',
      nationalId: '2012345678',
    },
    1,
  );
  // Same person details in ANOTHER clinic: it is a different record and must survive.
  const controlOther = await seedPatient(
    wb,
    tenantB,
    {
      name: NAME,
      phone: PHONE,
      waId: WA_ID,
      email: EMAIL,
      nationalId: NATIONAL_ID,
    },
    0,
  );
  return {
    tenantA,
    tenantB,
    target: t.id,
    controlSame: controlSame.id,
    controlOther: controlOther.id,
    fileKey: t.fileKey,
  };
}

beforeAll(async () => {
  if (!BASE) return;
  try {
    await boot();
    available = true;
  } catch (e) {
    console.warn(
      'Subject-erasure integration test skipped (no DB):',
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

const runIf = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(
    name,
    async () => {
      if (!available) return;
      await fn();
    },
    timeout,
  );

const service = () => new SubjectErasureService(ds!, storageFake as never);

beforeEach(() => {
  purged.length = 0;
  storageFake.purgeObject.mockClear();
});

describe('SubjectErasureService against real PostgreSQL', () => {
  runIf(
    'the plan executes end to end and anonymises only the target (clinical: retain)',
    async () => {
      const s = await seed();
      const beforeSame = await digest(s.controlSame);
      const beforeOther = await digest(s.controlOther);
      const ownProfile = await ds!.query(
        `SELECT "medical_history" FROM "customer_profiles" WHERE "customer_id" = $1`,
        [s.target],
      );

      const result = await service().erase(s.tenantA, s.target, {
        clinical: 'retain',
      });

      expect(result.status).toBe('COMPLETED');
      expect(result.evidenceId).toBeTruthy();

      // Identity: gone.
      const [c] = await ds!.query(`SELECT * FROM "customers" WHERE "id" = $1`, [
        s.target,
      ]);
      expect(c.full_name).toBe('Erased patient');
      expect(c.phone).toBe('ERASED');
      expect(c.email).toBe(`erased-${s.target}@erased.invalid`);
      for (const f of [
        'whatsapp_id',
        'whatsapp_name',
        'gender',
        'date_of_birth',
        'national_id',
        'source',
        'preferred_locale',
      ]) {
        expect(c[f]).toBeNull();
      }
      expect(c.marketing_opt_in).toBe(false);
      expect(c.is_active).toBe(false);
      expect(c.deleted_at).not.toBeNull();
      expect(c.opt_out_source).toBe('erasure');

      expect(
        await count('customer_addresses', `"customerId" = $1`, s.target),
      ).toBe(0);
      expect(
        await count('whatsapp_contacts', `"customerId" = $1`, s.target),
      ).toBe(0);
      expect(
        await count('customer_tag_relations', `"customerId" = $1`, s.target),
      ).toBe(0);
      expect(await count('ai_memories', `"customer_id" = $1`, s.target)).toBe(
        0,
      );
      expect(
        await count('patient_action_links', `"tenantId" = $1`, s.tenantA),
      ).toBe(1); // the control's only

      // Derived / log data scrubbed.
      const [log] = await ds!.query(
        `SELECT * FROM "email_logs" WHERE "tenant_id" = $1 AND "to_address" = 'erased@erased.invalid'`,
        [s.tenantA],
      );
      expect(log.subject).toBeNull();
      expect(log.metadata).toBeNull();
      expect(log.error).toBeNull();
      const [sched] = await ds!.query(
        `SELECT * FROM "scheduled_notifications" WHERE "recipient_id" = $1`,
        [s.target],
      );
      expect(sched.status).toBe('CANCELLED');
      expect(sched.variables).toEqual({});
      expect(
        (
          await ds!.query(
            `SELECT "error_message" FROM "notification_logs" WHERE "recipient_id" = $1`,
            [s.target],
          )
        )[0].error_message,
      ).toBeNull();
      expect(
        await count(
          'whatsapp_webhooks',
          `"tenantId" = $1 AND "payload" IS NULL`,
          s.tenantA,
        ),
      ).toBe(1);
      expect(
        await count(
          'workflow_runs',
          `"tenantId" = $1 AND "context" IS NULL`,
          s.tenantA,
        ),
      ).toBe(1);
      const [cr] = await ds!.query(
        `SELECT * FROM "campaign_recipients" WHERE "customerId" = $1`,
        [s.target],
      );
      expect(cr.email).toBeNull();

      // Clinical content RETAINED by choice, still linked to the anonymised row.
      expect(
        (
          await ds!.query(
            `SELECT "medical_history" FROM "customer_profiles" WHERE "customer_id" = $1`,
            [s.target],
          )
        )[0],
      ).toEqual(ownProfile[0]);
      expect(await count('customer_notes', `"customerId" = $1`, s.target)).toBe(
        1,
      );
      expect(
        await count(
          'clinical_entries',
          `"customerId" = $1 AND "data" <> '{}'::jsonb`,
          s.target,
        ),
      ).toBe(1);
      expect(
        (
          await ds!.query(
            `SELECT "chronic_diseases" FROM "customers" WHERE "id" = $1`,
            [s.target],
          )
        )[0].chronic_diseases,
      ).toBe('diabetes');
      expect(
        await count(
          'messages',
          `"tenantId" = $1 AND "content" IS NOT NULL AND "conversationId" IN (SELECT "id" FROM "conversations" WHERE "customerId" = $2)`,
          s.tenantA,
          s.target,
        ),
      ).toBe(1);
      expect(purged).toEqual([]); // files are clinical: retained, so not purged

      // Financial / audit rows retained.
      expect(await count('invoices', `"customerId" = $1`, s.target)).toBe(1);
      expect(await count('payments', `"customerId" = $1`, s.target)).toBe(1);
      expect(
        await count('clinical_access_logs', `"customerId" = $1`, s.target),
      ).toBe(1);

      // No other patient was touched — same tenant or another.
      expect(await digest(s.controlSame)).toBe(beforeSame);
      expect(await digest(s.controlOther)).toBe(beforeOther);
      // The other clinic's email log for the same address is a different record.
      expect(
        await count(
          'email_logs',
          `"tenant_id" = $1 AND lower("to_address") = $2`,
          s.tenantB,
          EMAIL,
        ),
      ).toBe(1);
    },
  );

  runIf(
    'clinical: erase also removes health content and every version of the stored files',
    async () => {
      const s = await seed();
      const beforeSame = await digest(s.controlSame);
      const beforeOther = await digest(s.controlOther);

      const result = await service().erase(s.tenantA, s.target, {
        clinical: 'erase',
      });
      expect(result.status).toBe('COMPLETED');

      expect(await count('customer_notes', `"customerId" = $1`, s.target)).toBe(
        0,
      );
      expect(await count('customer_files', `"customerId" = $1`, s.target)).toBe(
        0,
      );
      const [p] = await ds!.query(
        `SELECT * FROM "customer_profiles" WHERE "customer_id" = $1`,
        [s.target],
      );
      for (const f of [
        'medical_history',
        'allergies',
        'blood_type',
        'emergency_contact_name',
        'emergency_contact_phone',
        'notes',
      ]) {
        expect(p[f]).toBeNull();
      }
      const [e] = await ds!.query(
        `SELECT * FROM "clinical_entries" WHERE "customerId" = $1`,
        [s.target],
      );
      expect(e.data).toEqual({});
      expect(e.deleted_at).not.toBeNull();
      expect(
        (
          await ds!.query(
            `SELECT "summary" FROM "clinical_encounters" WHERE "customerId" = $1`,
            [s.target],
          )
        )[0].summary,
      ).toBeNull();
      const [cust] = await ds!.query(
        `SELECT * FROM "customers" WHERE "id" = $1`,
        [s.target],
      );
      expect(cust.chronic_diseases).toBeNull();
      expect(cust.has_chronic_diseases).toBe(false);
      expect(cust.has_health_insurance).toBeNull();
      expect(
        (
          await ds!.query(
            `SELECT "notes" FROM "appointments" WHERE "customerId" = $1`,
            [s.target],
          )
        )[0].notes,
      ).toBeNull();
      expect(
        await count(
          'appointment_notes',
          `"appointmentId" IN (SELECT "id" FROM "appointments" WHERE "customerId" = $1)`,
          s.target,
        ),
      ).toBe(0);
      expect(
        (
          await ds!.query(
            `SELECT "reason" FROM "appointment_cancellations" WHERE "tenantId" = $1 AND "appointmentId" IN (SELECT "id" FROM "appointments" WHERE "customerId" = $2)`,
            [s.tenantA, s.target],
          )
        )[0].reason,
      ).toBeNull();
      const [rev] = await ds!.query(
        `SELECT "comment", "reply" FROM "customer_reviews" WHERE "customerId" = $1`,
        [s.target],
      );
      expect(rev).toEqual({ comment: null, reply: null });
      expect(
        (
          await ds!.query(
            `SELECT "comment" FROM "staff_ratings" WHERE "customerId" = $1`,
            [s.target],
          )
        )[0].comment,
      ).toBeNull();
      const [conv] = await ds!.query(
        `SELECT * FROM "conversations" WHERE "customerId" = $1`,
        [s.target],
      );
      expect(conv.handover_notes).toBeNull();
      expect(
        await count(
          'messages',
          `"conversationId" = $1 AND "content" IS NOT NULL`,
          conv.id,
        ),
      ).toBe(0);
      expect(
        await count(
          'message_attachments',
          `"tenantId" = $1 AND "provider_media_id" IS NOT NULL AND "messageId" IN (SELECT "id" FROM "messages" WHERE "conversationId" = $2)`,
          s.tenantA,
          conv.id,
        ),
      ).toBe(0);
      expect(
        await count(
          'ai_messages',
          `"tenantId" = $1 AND "content" LIKE $2`,
          s.tenantA,
          `%${NAME}%`,
        ),
      ).toBe(0);
      expect(
        (
          await ds!.query(
            `SELECT "session" FROM "ai_conversations" WHERE "conversationId" = $1`,
            [conv.id],
          )
        )[0].session,
      ).toBeNull();

      // The stored object was purged (all versions), once, under this tenant.
      expect(purged).toEqual([s.fileKey]);
      expect(
        result.report.stores.find(
          (x) => x.store === 'storage' && x.action === 'deleted',
        )?.affected,
      ).toBe(2);

      // Controls untouched, including the one in the same clinic.
      expect(await digest(s.controlSame)).toBe(beforeSame);
      expect(await digest(s.controlOther)).toBe(beforeOther);
      // Audit + accounting still retained.
      expect(
        await count('clinical_access_logs', `"customerId" = $1`, s.target),
      ).toBe(1);
      expect(await count('invoices', `"customerId" = $1`, s.target)).toBe(1);
    },
  );

  runIf('a dry run reports exact counts and changes nothing', async () => {
    const s = await seed();
    const before = await digest(s.target);
    const r = await service().erase(s.tenantA, s.target, {
      clinical: 'erase',
      dryRun: true,
    });

    expect(r.dryRun).toBe(true);
    expect(r.evidenceId).toBeUndefined();
    expect(await digest(s.target)).toBe(before);
    expect(purged).toEqual([]);
    expect(
      await count('deletion_evidence', `"subject_id" = $1`, s.target),
    ).toBe(0);

    const by = (id: string) => r.report.stores.find((x) => x.target === id);
    expect(by('customers')).toMatchObject({
      action: 'anonymised',
      affected: 1,
    });
    expect(by('customer_addresses')).toMatchObject({
      action: 'deleted',
      affected: 1,
    });
    expect(by('clinical_entries')).toMatchObject({
      action: 'scrubbed',
      affected: 1,
    });
    expect(by('invoices')).toMatchObject({ action: 'retained', affected: 1 });
  });

  runIf('rolls the WHOLE transaction back when any step fails', async () => {
    const s = await seed();
    const before = await digest(s.target);
    const broken: ErasureStep = {
      id: 'broken',
      table: 'customers',
      group: 'identity',
      action: 'scrub',
      set: `"no_such_column" = NULL`,
      where: `"id" = :customer AND "tenantId" = :tenant`,
    };
    const svc = service();
    (svc as unknown as { steps: ErasureStep[] }).steps = [
      ...ERASURE_STEPS.filter((x) => x.id === 'customers'),
      broken,
    ];

    await expect(
      svc.erase(s.tenantA, s.target, { clinical: 'erase' }),
    ).rejects.toThrow();

    // The customers step ran first and succeeded — and must have been undone.
    expect(await digest(s.target)).toBe(before);
    expect(
      await count('deletion_evidence', `"subject_id" = $1`, s.target),
    ).toBe(0);
    expect(purged).toEqual([]);
  });

  runIf(
    'refuses a customer from another tenant and touches nothing',
    async () => {
      const s = await seed();
      const before = await digest(s.target);
      await expect(
        service().erase(s.tenantB, s.target, { clinical: 'erase' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('not found'),
      });
      expect(await digest(s.target)).toBe(before);
    },
  );

  runIf(
    'is idempotent — erasing an already-erased patient succeeds',
    async () => {
      const s = await seed();
      await service().erase(s.tenantA, s.target, { clinical: 'erase' });
      const again = await service().erase(s.tenantA, s.target, {
        clinical: 'erase',
      });
      expect(again.status).toBe('COMPLETED');
      expect(purged).toEqual([s.fileKey]); // the second run found no files to purge
    },
  );

  runIf(
    'writes evidence that names tables and counts but holds no personal data',
    async () => {
      const s = await seed();
      const r = await service().erase(s.tenantA, s.target, {
        clinical: 'retain',
        performedByUserId: undefined,
      });
      const [row] = await ds!.query(
        `SELECT * FROM "deletion_evidence" WHERE "id" = $1`,
        [r.evidenceId],
      );
      const text = JSON.stringify(row);

      for (const secret of [
        NAME,
        'Alharbi',
        PHONE,
        WA_ID,
        EMAIL,
        NATIONAL_ID,
        'asthma',
        'diabetes',
        'penicillin',
      ]) {
        expect(text).not.toContain(secret);
      }
      expect(row.scope).toBe('SUBJECT');
      expect(row.subject_id).toBe(s.target);
      expect(row.report.options).toEqual({ clinical: 'retain' });
      // The operator's choice and what was NOT reachable are both on the record.
      const actions = new Set(
        (row.report.stores as Array<{ action: string }>).map((x) => x.action),
      );
      expect(actions).toEqual(
        expect.objectContaining(
          new Set(['retained', 'not_covered', 'anonymised']),
        ),
      );
    },
  );

  runIf(
    "lets the erased patient's email and national id be registered again",
    async () => {
      const s = await seed();
      await service().erase(s.tenantA, s.target, { clinical: 'retain' });
      const w = factory.world();
      w.pin('tenants', s.tenantA);
      // Unique per (tenant, email) and per (tenant, national_id) among LIVE rows only.
      await expect(
        w.make('customers', {
          tenantId: s.tenantA,
          email: EMAIL,
          national_id: NATIONAL_ID,
          full_name: 'New patient',
          phone: '0500000000',
        }),
      ).resolves.toBeTruthy();
    },
  );

  runIf(
    'requires an explicit clinical choice — there is no default',
    async () => {
      const s = await seed();
      await expect(
        service().erase(s.tenantA, s.target, {} as never),
      ).rejects.toMatchObject({
        message: expect.stringContaining('no default'),
      });
    },
  );
});
