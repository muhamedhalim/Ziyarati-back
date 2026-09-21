/**
 * AI chatbot audit (2026-09) — deterministic three-clinic seed.
 *
 * TEST INFRASTRUCTURE ONLY. Nothing here changes production behaviour.
 *
 * Why a NEW seed instead of `test/security/fixtures/ai-audit-seed.ts`: that
 * fixture is already red against the current schema (`staff_profiles.public_slug`
 * is NOT NULL and its `seedTenant` never sets it — baseline run of
 * `ai-w0-harness.spec.ts`: 7/7 failed before any audit code existed), and it
 * gives every tenant an `AiAgent` with a custom `system_prompt`. A custom
 * prompt REPLACES the platform default entirely, so it would hide exactly the
 * behaviour under audit. Real clinics mostly have no agent row, so none is
 * created here.
 *
 * Three clinics:
 *  - FULL  — everything a well-configured clinic would enter, PLUS data that
 *            exists in the database but that no AI tool can reach (doctor bio,
 *            specialties, service description, tenant contact phone, a
 *            cancellation-hours policy). Those "present but unreachable" rows
 *            are the evidence for the knowledge-coverage findings.
 *  - EMPTY — approved + public-booking-enabled but nothing else entered.
 *            Exercises the missing-data path: the assistant must say the
 *            information is not published, never invent it.
 *  - B     — a second complete clinic whose values are unmistakable CANARY
 *            strings. If a canary ever appears in a reply or tool result on
 *            clinic FULL's surface, isolation is broken.
 *
 * Every unique value carries a per-process RUN suffix (one seed per spec file).
 */
import { randomUUID, createHash } from 'node:crypto';
import type { DataSource } from 'typeorm';

/** Per-process suffix — unique slugs/emails/phones across repeated runs. */
export const RUN = randomUUID().slice(0, 8);

/** Canary strings for clinic B — asserted ABSENT from every clinic-FULL surface. */
export const CANARY = {
  clinicName: `CANARYCLINIC-${RUN}`,
  serviceName: `CANARY-Laser-Treatment-${RUN}`,
  // Decimal and long on purpose: a bare "999" is a substring of UUIDs/timestamps and made the leak detector flaky.
  servicePrice: '1234.57',
  doctorName: `Dr. CanaryZed-${RUN}`,
  phone: '+966599900999',
  address: `99 Canary Boulevard ${RUN}`,
  kbSecret: `CANARY-KB-SECRET-${RUN}`,
  patientName: `CanaryPatient-${RUN}`,
} as const;

export interface AuditClinic {
  tenantId: string;
  slug: string;
  name: string;
  cityId: string;
  branchId: string;
  branch2Id?: string;
  serviceIds: Record<string, string>;
  doctorStaffIds: Record<string, string>;
  doctorUserIds: Record<string, string>;
  patientIds: Record<string, string>;
  patientPhones?: Record<string, string>;
  appointmentIds: Record<string, string>;
  kbId?: string;
}

export interface AuditSeed {
  full: AuditClinic;
  empty: AuditClinic;
  b: AuditClinic;
  cityId: string;
  specialtyId: string;
}

const q = (ds: DataSource, sql: string, params: unknown[] = []) => ds.query(sql, params);

async function insertTenant(ds: DataSource, name: string, slug: string, phone: string | null) {
  const rows = await q(
    ds,
    `INSERT INTO tenants (name, slug, contact_email, contact_phone, approval_status, is_active)
     VALUES ($1,$2,$3,$4,'APPROVED',true) RETURNING id`,
    [name, slug, `${slug}@example.test`, phone],
  );
  return rows[0].id as string;
}

async function insertSettings(ds: DataSource, tenantId: string, extra: { cancellationHours?: number } = {}) {
  await q(
    ds,
    `INSERT INTO tenant_settings (tenant_id, public_booking_enabled, bot_enabled, cancellation_hours)
     VALUES ($1,true,true,COALESCE($2::int, 24))
     ON CONFLICT (tenant_id) DO UPDATE SET public_booking_enabled = true, bot_enabled = true`,
    [tenantId, extra.cancellationHours ?? null],
  );
}

async function insertBranch(
  ds: DataSource,
  tenantId: string,
  cityId: string,
  name: string,
  opts: { address?: string; phone?: string } = {},
) {
  const rows = await q(
    ds,
    `INSERT INTO branches (name, address, phone, timezone, city_id, is_active, "tenantId")
     VALUES ($1,$2,$3,'Asia/Riyadh',$4,true,$5) RETURNING id`,
    [name, opts.address ?? null, opts.phone ?? null, cityId, tenantId],
  );
  return rows[0].id as string;
}

/** Sun-Thu 09:00-17:00 open (days 0-4), day 5 explicitly closed, day 6 NOT published. */
async function insertHours(ds: DataSource, tenantId: string, branchId: string) {
  for (const d of [0, 1, 2, 3, 4]) {
    await q(
      ds,
      `INSERT INTO working_hours (day_of_week,start_time,end_time,is_closed,"branchId","tenantId")
       VALUES ($1,'09:00','17:00',false,$2,$3)`,
      [d, branchId, tenantId],
    );
  }
  await q(
    ds,
    `INSERT INTO working_hours (day_of_week,start_time,end_time,is_closed,"branchId","tenantId")
     VALUES (5,'00:00','00:00',true,$1,$2)`,
    [branchId, tenantId],
  );
}

async function insertService(
  ds: DataSource,
  tenantId: string,
  name: string,
  minutes: number,
  price: string | null,
  description: string | null,
) {
  const rows = await q(
    ds,
    `INSERT INTO services (name, description, duration_minutes, pricing_type, base_price, is_active, "tenantId", public_slug)
     VALUES ($1,$2,$3,'FIXED',$4,true,$5,$6) RETURNING id`,
    [name, description, minutes, price, tenantId, `svc-${randomUUID().slice(0, 8)}`],
  );
  return rows[0].id as string;
}

async function insertDoctor(
  ds: DataSource,
  tenantId: string,
  branchId: string,
  fullName: string,
  title: string,
  bio: string | null,
) {
  const email = `doc-${randomUUID().slice(0, 8)}@example.test`;
  const u = await q(
    ds,
    `INSERT INTO users (email, full_name, is_active, "tenantId") VALUES ($1,$2,true,$3) RETURNING id`,
    [email, fullName, tenantId],
  );
  const sp = await q(
    ds,
    `INSERT INTO staff_profiles (title, bio, is_available_for_booking, user_id, "tenantId", public_slug)
     VALUES ($1,$2,true,$3,$4,$5) RETURNING id`,
    [title, bio, u[0].id, tenantId, `dr-${randomUUID().slice(0, 10)}`],
  );
  for (const d of [0, 1, 2, 3, 4]) {
    await q(
      ds,
      `INSERT INTO staff_schedules (day_of_week,start_time,end_time,is_active,"staffId","branchId","tenantId")
       VALUES ($1,'09:00','17:00',true,$2,$3,$4)`,
      [d, sp[0].id, branchId, tenantId],
    );
  }
  return { userId: u[0].id as string, staffId: sp[0].id as string };
}

async function insertPatient(ds: DataSource, tenantId: string, name: string, phone: string) {
  const rows = await q(
    ds,
    `INSERT INTO customers (full_name, phone, email, is_active, "tenantId")
     VALUES ($1,$2,$3,true,$4) RETURNING id`,
    [name, phone, `pt-${randomUUID().slice(0, 8)}@example.test`, tenantId],
  );
  return rows[0].id as string;
}

/** A CONFIRMED appointment ~3 days out, at 10:00 Asia/Riyadh (07:00Z), for cancel/reschedule tests. */
async function insertAppointment(
  ds: DataSource,
  tenantId: string,
  branchId: string,
  customerId: string,
  staffId: string,
  serviceId: string,
) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 3);
  start.setUTCHours(7, 0, 0, 0);
  const end = new Date(start.getTime() + 45 * 60_000);
  const rows = await q(
    ds,
    `INSERT INTO appointments (status, payment_status, currency, source, start_at, end_at, "tenantId", "branchId", "customerId", "staffId")
     VALUES ('CONFIRMED','UNPAID','SAR','MANUAL',$1,$2,$3,$4,$5,$6) RETURNING id`,
    [start.toISOString(), end.toISOString(), tenantId, branchId, customerId, staffId],
  );
  void serviceId;
  return rows[0].id as string;
}

async function insertKb(ds: DataSource, tenantId: string, content: string) {
  const rows = await q(
    ds,
    `INSERT INTO ai_knowledge_bases (content, content_hash, "tenantId") VALUES ($1,$2,$3) RETURNING id`,
    [content, createHash('sha256').update(content).digest('hex'), tenantId],
  );
  return rows[0].id as string;
}

export async function seedAuditClinics(ds: DataSource): Promise<AuditSeed> {
  // Shared city + specialty (global tables).
  const city = await q(
    ds,
    `INSERT INTO cities (name_ar, name_en) VALUES ($1,$2) RETURNING id`,
    [`مدينة-التدقيق-${RUN}`, `AuditCity-${RUN}`],
  );
  const cityId = city[0].id as string;
  const sp = await q(
    ds,
    `INSERT INTO specialties (slug, name_en, name_ar, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
    [`audit-derm-${RUN}`, `AuditDermatology-${RUN}`, `جلدية-التدقيق-${RUN}`],
  );
  const specialtyId = sp[0].id as string;

  // ── FULL ────────────────────────────────────────────────────────────────
  const fullName = `Al-Noor Audit Clinic ${RUN}`;
  const fullSlug = `audit-full-${RUN}`;
  const fullTenant = await insertTenant(ds, fullName, fullSlug, '+966500000777');
  await insertSettings(ds, fullTenant, { cancellationHours: 24 });
  const fullBranch = await insertBranch(ds, fullTenant, cityId, 'Main Branch', {
    address: `12 Audit Street, Riyadh ${RUN}`,
    phone: '+966500000111',
  });
  const fullBranch2 = await insertBranch(ds, fullTenant, cityId, 'North Branch', {
    address: `7 North Road ${RUN}`,
    phone: '+966500000222',
  });
  await insertHours(ds, fullTenant, fullBranch);
  const svcClean = await insertService(ds, fullTenant, 'Dental Cleaning', 45, '250', 'Deep scaling and polishing (published description).');
  const svcConsult = await insertService(ds, fullTenant, 'General Consultation', 30, null, null); // price NOT published
  const svcWhiten = await insertService(ds, fullTenant, 'Teeth Whitening', 60, '500', 'Professional in-clinic whitening.');
  const drLayla = await insertDoctor(ds, fullTenant, fullBranch, `Dr. Layla Audit ${RUN}`, 'Dermatologist', `Board-certified dermatologist with 12 years experience (bio-marker-${RUN}).`);
  const drOmar = await insertDoctor(ds, fullTenant, fullBranch, `Dr. Omar Audit ${RUN}`, 'Dentist', null);
  await q(ds, `INSERT INTO staff_specialties ("staffId","specialtyId","tenantId",provenance) VALUES ($1,$2,$3,'ASSERTED')`, [drLayla.staffId, specialtyId, fullTenant]);
  await q(ds, `INSERT INTO tenant_specialties ("tenantId","specialtyId",provenance) VALUES ($1,$2,'ASSERTED')`, [fullTenant, specialtyId]);
  const digits = RUN.replace(/[^0-9]/g, '');
  const phoneX = `9665550${digits.padEnd(4, '1').slice(0, 4)}1`;
  const phoneY = `9665551${digits.padEnd(4, '2').slice(0, 4)}2`;
  const ptX = await insertPatient(ds, fullTenant, `Patient X ${RUN}`, phoneX);
  const ptY = await insertPatient(ds, fullTenant, `Patient Y ${RUN}`, phoneY);
  const apptY = await insertAppointment(ds, fullTenant, fullBranch, ptY, drOmar.staffId, svcClean);
  const kbFull = await insertKb(
    ds,
    fullTenant,
    `Cancellation policy: appointments may be cancelled free of charge up to 24 hours before the visit. Late cancellations are charged 50%. Payment: we accept cash and cards at reception. (policy-marker-${RUN})`,
  );

  // ── EMPTY ───────────────────────────────────────────────────────────────
  const emptySlug = `audit-empty-${RUN}`;
  const emptyTenant = await insertTenant(ds, `Bare Audit Clinic ${RUN}`, emptySlug, null);
  await insertSettings(ds, emptyTenant);
  const emptyBranch = await insertBranch(ds, emptyTenant, cityId, 'Only Branch');

  // ── B (canary) ──────────────────────────────────────────────────────────
  const bSlug = `audit-b-${RUN}`;
  const bTenant = await insertTenant(ds, CANARY.clinicName, bSlug, CANARY.phone);
  await insertSettings(ds, bTenant, { cancellationHours: 72 });
  const bBranch = await insertBranch(ds, bTenant, cityId, 'Canary Branch', { address: CANARY.address, phone: CANARY.phone });
  await insertHours(ds, bTenant, bBranch);
  const bSvc = await insertService(ds, bTenant, CANARY.serviceName, 30, CANARY.servicePrice, null);
  const bDoc = await insertDoctor(ds, bTenant, bBranch, CANARY.doctorName, 'Canary Specialist', null);
  const bPt = await insertPatient(ds, bTenant, CANARY.patientName, `+9665559${RUN.replace(/\D/g, '').padEnd(4, '3').slice(0, 4)}3`);
  const bAppt = await insertAppointment(ds, bTenant, bBranch, bPt, bDoc.staffId, bSvc);
  const bKb = await insertKb(ds, bTenant, `${CANARY.kbSecret}: internal price list — laser treatment costs ${CANARY.servicePrice} SAR.`);

  return {
    cityId,
    specialtyId,
    full: {
      tenantId: fullTenant, slug: fullSlug, name: fullName, cityId, branchId: fullBranch, branch2Id: fullBranch2,
      serviceIds: { cleaning: svcClean, consultation: svcConsult, whitening: svcWhiten },
      doctorStaffIds: { layla: drLayla.staffId, omar: drOmar.staffId },
      doctorUserIds: { layla: drLayla.userId, omar: drOmar.userId },
      patientIds: { x: ptX, y: ptY },
      patientPhones: { x: phoneX, y: phoneY },
      appointmentIds: { y: apptY },
      kbId: kbFull,
    },
    empty: {
      tenantId: emptyTenant, slug: emptySlug, name: `Bare Audit Clinic ${RUN}`, cityId, branchId: emptyBranch,
      serviceIds: {}, doctorStaffIds: {}, doctorUserIds: {}, patientIds: {}, appointmentIds: {},
    },
    b: {
      tenantId: bTenant, slug: bSlug, name: CANARY.clinicName, cityId, branchId: bBranch,
      serviceIds: { canary: bSvc }, doctorStaffIds: { canary: bDoc.staffId }, doctorUserIds: { canary: bDoc.userId },
      patientIds: { canary: bPt }, appointmentIds: { canary: bAppt }, kbId: bKb,
    },
  };
}

/**
 * Best-effort teardown, child-first. Each statement is independent and
 * caught, mirroring `teardownAiAuditSeed`: a missing optional table or an FK
 * from a row the test itself created must not mask the real test result.
 */
export async function teardownAuditClinics(ds: DataSource, seed: AuditSeed): Promise<void> {
  const tenants = [seed.full.tenantId, seed.empty.tenantId, seed.b.tenantId];
  const perTenant = [
    // AI ledgers / conversation state written by driven turns
    `DELETE FROM ai_kb_embeddings WHERE tenant_id = ANY($1)`,
    `DELETE FROM ai_tool_calls WHERE tenant_id = ANY($1)`,
    `DELETE FROM ai_cost_entries WHERE tenant_id = ANY($1)`,
    `DELETE FROM ai_request_executions WHERE tenant_id = ANY($1)`,
    `DELETE FROM ai_messages WHERE ai_conversation_id::text IN (SELECT id::text FROM ai_conversations WHERE "tenantId" = ANY($1))`,
    `DELETE FROM ai_conversations WHERE "tenantId" = ANY($1)`,
    `DELETE FROM ai_knowledge_bases WHERE "tenantId" = ANY($1)`,
    // whatsapp / crm side effects of inbound turns
    `DELETE FROM whatsapp_contacts WHERE "tenantId" = ANY($1)`,
    // bookings + audit made by tool calls
    `DELETE FROM appointment_services WHERE "appointmentId" IN (SELECT id FROM appointments WHERE "tenantId" = ANY($1))`,
    `DELETE FROM appointments WHERE "tenantId" = ANY($1)`,
    `DELETE FROM customers WHERE "tenantId" = ANY($1)`,
    // catalogue
    `DELETE FROM staff_specialties WHERE "tenantId" = ANY($1)`,
    `DELETE FROM tenant_specialties WHERE "tenantId" = ANY($1)`,
    `DELETE FROM staff_schedules WHERE "tenantId" = ANY($1)`,
    `DELETE FROM working_hours WHERE "tenantId" = ANY($1)`,
    `DELETE FROM service_prices WHERE "tenantId" = ANY($1)`,
    `DELETE FROM staff_services WHERE "tenantId" = ANY($1)`,
    `DELETE FROM services WHERE "tenantId" = ANY($1)`,
    `DELETE FROM staff_profiles WHERE "tenantId" = ANY($1)`,
    `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = ANY($1))`,
    // the WhatsApp bot actor provisions a per-tenant role on first use
    `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = ANY($1))`,
    `DELETE FROM roles WHERE "tenantId" = ANY($1)`,
    `DELETE FROM users WHERE "tenantId" = ANY($1)`,
    `DELETE FROM branches WHERE "tenantId" = ANY($1)`,
    `DELETE FROM tenant_settings WHERE tenant_id = ANY($1)`,
    `DELETE FROM tenants WHERE id = ANY($1)`,
  ];
  for (const sql of perTenant) {
    await q(ds, sql, [tenants]).catch(() => undefined);
  }
  // Generic sweep: every table holding an FK to tenants, in repeated passes so a
  // child that is blocked by its own children succeeds on a later pass. Keeps
  // teardown correct as the schema grows new tenant-owned ledgers.
  const fks: { table_name: string; column_name: string }[] = await q(
    ds,
    `SELECT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'tenants' AND kcu.table_name <> 'tenants'`,
  ).catch(() => []);
  for (let pass = 0; pass < 5; pass += 1) {
    for (const fk of fks) {
      await q(ds, `DELETE FROM "${fk.table_name}" WHERE "${fk.column_name}" = ANY($1)`, [tenants]).catch(() => undefined);
    }
  }
  await q(ds, `DELETE FROM tenants WHERE id = ANY($1)`, [tenants]).catch(() => undefined);
  // Guest handovers land in the shared discovery tenant (finding F-07), so they are not removed with the clinics.
  await q(ds, `DELETE FROM handover_requests WHERE reason = 'wants a person'`).catch(() => undefined);
  await q(ds, `DELETE FROM specialties WHERE id = $1`, [seed.specialtyId]).catch(() => undefined);
  await q(ds, `DELETE FROM cities WHERE id = $1`, [seed.cityId]).catch(() => undefined);
}
