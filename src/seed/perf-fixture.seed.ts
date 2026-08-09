import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { SeedDataSource } from './data-source';
import { logger } from './seed.logger';

/**
 * Performance-audit data-volume fixture (specs/006-platform-performance-audit,
 * T019). Produces tier T1 ("today-like") or T2 ("growth") per the target row
 * counts and rationale recorded in
 * specs/006-platform-performance-audit/reports/data-tiers.md.
 *
 * NOT the RTL fixture (`rtl-fixture.seed.ts`) — that file is never imported
 * or modified by this one, and this seed never runs against the RTL suite's
 * database. Every seeded row derives its tenant from a tenant THIS seed
 * itself creates; no tenantId is ever read from config or CLI input
 * (Standing Rule 8).
 *
 * Uses raw bulk INSERT (DataSource.query with multi-row VALUES, chunked) —
 * not TypeORM repository.save() per row — because T2's row counts (millions
 * of rows on the largest tables) would take unacceptably long through the
 * ORM's per-entity change-tracking path. All ids are generated client-side
 * (crypto.randomUUID()) so the full relational graph can be built in memory
 * before any INSERT runs, with zero read-back round trips.
 *
 * Run:
 *   npm run seed:perf -- --tier=T1
 *   npm run seed:perf -- --tier=T2
 */

type Tier = 'T1' | 'T2';

interface TierConfig {
  tenants: number;
  branchesPerTenant: number; // average; alternates +/-1 for variety
  staffPerBranch: number;
  customersPerTenant: number;
  appointmentsPerTenant: number;
  invoicesPerTenant: number;
  conversationsPerTenant: number;
  messagesPerConversation: number; // average; alternates
}

// Targets per reports/data-tiers.md T018. Per-tenant figures are derived
// from the table-level targets there (e.g. T1 customers: 15,000 / 50 tenants
// = 300/tenant).
const TIER_CONFIG: Record<Tier, TierConfig> = {
  T1: {
    tenants: 50,
    branchesPerTenant: 2,
    staffPerBranch: 3,
    customersPerTenant: 300,
    appointmentsPerTenant: 1200,
    invoicesPerTenant: 800,
    conversationsPerTenant: 400,
    messagesPerConversation: 8,
  },
  T2: {
    tenants: 500,
    branchesPerTenant: 3,
    staffPerBranch: 2,
    customersPerTenant: 400,
    appointmentsPerTenant: 1800,
    invoicesPerTenant: 1200,
    conversationsPerTenant: 600,
    messagesPerConversation: 8,
  },
};

/** Fixed system role ids, read once from the already-seeded `roles` table
 * (base `npm run seed` must have run first — same dependency rtl-fixture.seed.ts
 * declares). Never hardcoded as literal UUIDs — always resolved live. */
interface RoleIds {
  owner: string;
  manager: string;
  receptionist: string;
  doctor: string;
}

const BCRYPT_ROUNDS = 12;
/** One shared hash for every bulk-filler user (never intended to be logged
 * into) — computed once, not per row, since bcrypt at 12 rounds is
 * deliberately slow and re-hashing per user would dominate seed time for no
 * benefit. Primary per-tenant logins (see PRIMARY_TENANT_COUNT below) get
 * their own distinct, documented credentials instead. */
let SHARED_FILLER_HASH: string;

/** The first N tenants per tier get real, documented login credentials
 * (owner/receptionist/doctor) for A4/A5/A11's scripted journeys to
 * authenticate against. The remaining tenants exist purely for volume. */
const PRIMARY_TENANT_COUNT = 5;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Builds and executes a parameterized multi-row INSERT, chunked to stay
 * well under Postgres's 65535-parameter limit per statement. */
async function bulkInsert(
  ds: DataSource,
  table: string,
  columns: string[],
  rows: unknown[][],
  chunkSize = 1000,
): Promise<void> {
  if (rows.length === 0) return;
  for (const batch of chunk(rows, chunkSize)) {
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const row of batch) {
      const placeholders = row.map(() => `$${p++}`);
      valuesSql.push(`(${placeholders.join(',')})`);
      params.push(...row);
    }
    const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES ${valuesSql.join(',')}`;
    await ds.query(sql, params);
  }
}

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length];
}

async function resolveRoleIds(ds: DataSource): Promise<RoleIds> {
  const rows: { id: string; slug: string }[] = await ds.query(
    `SELECT id, slug FROM roles WHERE "tenantId" IS NULL AND slug IN ('owner','manager','receptionist','doctor')`,
  );
  const byslug = new Map(rows.map((r) => [r.slug, r.id]));
  const owner = byslug.get('owner');
  const manager = byslug.get('manager');
  const receptionist = byslug.get('receptionist');
  const doctor = byslug.get('doctor');
  if (!owner || !manager || !receptionist || !doctor) {
    throw new Error(
      'One or more system roles (owner/manager/receptionist/doctor) not found — run "npm run seed" before "npm run seed:perf".',
    );
  }
  return { owner, manager, receptionist, doctor };
}

async function alreadySeeded(ds: DataSource, tier: Tier): Promise<boolean> {
  const rows: { count: string }[] = await ds.query(
    `SELECT count(*)::text AS count FROM tenants WHERE slug LIKE $1`,
    [`perf-${tier.toLowerCase()}-tenant-%`],
  );
  return Number(rows[0].count) > 0;
}

const APPT_STATUSES = ['CONFIRMED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const; // weighted toward COMPLETED, matching a real clinic's history
const APPT_PAYMENT_STATUSES = ['UNPAID', 'PAID', 'PAID', 'DEPOSIT_PAID'] as const;
const INVOICE_STATUSES = ['DRAFT', 'OPEN', 'PAID', 'PAID', 'VOID'] as const;
const PAYMENT_STATUSES = ['PENDING', 'PAID', 'PAID', 'FAILED', 'REFUNDED'] as const;
const CONV_STATUSES = ['BOT', 'AI', 'HUMAN', 'RESOLVED'] as const;
const SENDER_TYPES = ['CUSTOMER', 'AGENT', 'BOT', 'SYSTEM'] as const;

export async function seedPerfFixture(ds: DataSource, tier: Tier): Promise<void> {
  const cfg = TIER_CONFIG[tier];
  const started = Date.now();

  if (await alreadySeeded(ds, tier)) {
    logger.info(`Perf fixture tier ${tier} already seeded (tenants matching "perf-${tier.toLowerCase()}-tenant-%" exist) — skipping. Drop the tier's database to re-seed.`);
    return;
  }

  const roleIds = await resolveRoleIds(ds);
  SHARED_FILLER_HASH = await bcrypt.hash('PerfFixtureFillerNotForLogin!', BCRYPT_ROUNDS);
  const primaryHash = await bcrypt.hash(`Perf${tier}Primary123!`, BCRYPT_ROUNDS);

  logger.step(`Seeding perf fixture tier ${tier}: ${cfg.tenants} tenants target`);

  // ---------------------------------------------------------------- tenants
  const tenantIds: string[] = [];
  const tenantRows: unknown[][] = [];
  const now = new Date();
  for (let i = 0; i < cfg.tenants; i++) {
    const id = randomUUID();
    tenantIds.push(id);
    tenantRows.push([
      id,
      `Perf Fixture Clinic ${tier} #${i}`,
      `perf-${tier.toLowerCase()}-tenant-${i}`,
      `perf.${tier.toLowerCase()}.tenant${i}@example.test`,
      'SAR',
      'Asia/Riyadh',
      'APPROVED',
      true,
      now,
      now,
    ]);
  }
  await bulkInsert(ds, 'tenants', ['id', 'name', 'slug', 'contact_email', 'default_currency', 'default_timezone', 'approval_status', 'is_active', 'created_at', 'updated_at'], tenantRows);
  logger.success(`tenants: ${tenantIds.length}`);

  // --------------------------------------------------------------- branches
  const branchIdsByTenant: string[][] = [];
  const branchRows: unknown[][] = [];
  for (let t = 0; t < cfg.tenants; t++) {
    const n = cfg.branchesPerTenant + (t % 2 === 0 ? 0 : 1); // alternates for variety, matches T2's fractional average
    const ids: string[] = [];
    for (let b = 0; b < n; b++) {
      const id = randomUUID();
      ids.push(id);
      branchRows.push([id, `Branch ${b + 1}`, 'Asia/Riyadh', true, now, now, tenantIds[t]]);
    }
    branchIdsByTenant.push(ids);
  }
  await bulkInsert(ds, 'branches', ['id', 'name', 'timezone', 'is_active', 'created_at', 'updated_at', 'tenantId'], branchRows);
  const totalBranches = branchRows.length;
  logger.success(`branches: ${totalBranches}`);

  // ------------------------------------------------------- users + staff
  const userIdsByTenant: string[][] = [];
  const staffIdsByTenant: string[][] = [];
  const userRows: unknown[][] = [];
  const staffRows: unknown[][] = [];
  const userRoleRows: unknown[][] = [];
  const branchUserRows: unknown[][] = [];
  let globalUserSeq = 0;

  for (let t = 0; t < cfg.tenants; t++) {
    const isPrimary = t < PRIMARY_TENANT_COUNT;
    const branches = branchIdsByTenant[t];
    const uIds: string[] = [];
    const sIds: string[] = [];
    const staffPerTenant = cfg.staffPerBranch * branches.length;

    for (let s = 0; s < staffPerTenant; s++) {
      const userId = randomUUID();
      globalUserSeq++;
      const roleIndex = s % 3; // owner, manager, receptionist rotate; first user of tenant is always owner
      const roleId = s === 0 ? roleIds.owner : [roleIds.manager, roleIds.receptionist, roleIds.doctor][roleIndex];
      let email: string;
      let passwordHash: string;
      if (isPrimary && s === 0) {
        email = `perf.owner.t${t}@${tier.toLowerCase()}.local.test`;
        passwordHash = primaryHash;
      } else if (isPrimary && s === 1) {
        email = `perf.receptionist.t${t}@${tier.toLowerCase()}.local.test`;
        passwordHash = primaryHash;
      } else if (isPrimary && s === 2) {
        email = `perf.doctor.t${t}@${tier.toLowerCase()}.local.test`;
        passwordHash = primaryHash;
      } else {
        email = `perf.${tier.toLowerCase()}.user${globalUserSeq}@example.test`;
        passwordHash = SHARED_FILLER_HASH;
      }
      uIds.push(userId);
      userRows.push([userId, email, `Perf Staff ${s + 1}`, passwordHash, true, now, now, tenantIds[t]]);

      const staffId = randomUUID();
      sIds.push(staffId);
      staffRows.push([staffId, 'Staff', 0, true, now, now, userId, tenantIds[t]]);

      userRoleRows.push([randomUUID(), now, userId, s === 0 ? roleIds.owner : roleId]);

      const branch = pick(branches, s);
      branchUserRows.push([randomUUID(), s === 0, now, tenantIds[t], branch, userId]);
    }
    userIdsByTenant.push(uIds);
    staffIdsByTenant.push(sIds);
  }
  await bulkInsert(ds, 'users', ['id', 'email', 'full_name', 'password_hash', 'is_active', 'created_at', 'updated_at', 'tenantId'], userRows);
  await bulkInsert(ds, 'staff_profiles', ['id', 'title', 'booking_buffer_minutes', 'is_available_for_booking', 'created_at', 'updated_at', 'user_id', 'tenantId'], staffRows);
  await bulkInsert(ds, 'user_roles', ['id', 'assigned_at', 'userId', 'roleId'], userRoleRows);
  await bulkInsert(ds, 'branch_users', ['id', 'is_primary', 'created_at', 'tenantId', 'branchId', 'userId'], branchUserRows);
  logger.success(`users: ${userRows.length}, staff_profiles: ${staffRows.length}`);

  // ------------------------------------------------------------- customers
  const customerIdsByTenant: string[][] = [];
  const customerRows: unknown[][] = [];
  for (let t = 0; t < cfg.tenants; t++) {
    const ids: string[] = [];
    for (let c = 0; c < cfg.customersPerTenant; c++) {
      const id = randomUUID();
      ids.push(id);
      customerRows.push([
        id,
        `Perf Customer ${t}-${c}`,
        `+9665${String(10000000 + t * 100000 + c).slice(-8)}`,
        `perf.${tier.toLowerCase()}.customer.${t}.${c}@example.test`,
        true,
        now,
        now,
        tenantIds[t],
      ]);
    }
    customerIdsByTenant.push(ids);
  }
  await bulkInsert(ds, 'customers', ['id', 'full_name', 'phone', 'email', 'is_active', 'created_at', 'updated_at', 'tenantId'], customerRows);
  logger.success(`customers: ${customerRows.length}`);

  // ----------------------------------------------------------- appointments
  // Non-overlapping [start_at, end_at) per staffId is enforced by a gist
  // EXCLUDE constraint (appointments_no_overlap) for any non-CANCELLED/
  // NO_SHOW row. Sequential 45-minute slots per staff member guarantee this
  // by construction — no randomness in timing.
  const appointmentIdsByTenant: string[][] = [];
  const appointmentRows: unknown[][] = [];
  const SLOT_MINUTES = 45;
  const baseDate = Date.UTC(2025, 0, 1, 8, 0, 0); // 2025-01-01 08:00 UTC

  for (let t = 0; t < cfg.tenants; t++) {
    const staff = staffIdsByTenant[t];
    const customers = customerIdsByTenant[t];
    const branches = branchIdsByTenant[t];
    const nextSlotByStaff = new Map<string, number>(staff.map((s) => [s, 0]));
    const ids: string[] = [];

    for (let a = 0; a < cfg.appointmentsPerTenant; a++) {
      const staffId = pick(staff, a);
      const slotIndex = nextSlotByStaff.get(staffId)!;
      nextSlotByStaff.set(staffId, slotIndex + 1);
      const startMs = baseDate + slotIndex * SLOT_MINUTES * 60 * 1000;
      const start = new Date(startMs);
      const end = new Date(startMs + SLOT_MINUTES * 60 * 1000);

      const id = randomUUID();
      ids.push(id);
      appointmentRows.push([
        id,
        start,
        end,
        pick(APPT_STATUSES, a),
        150 + (a % 20) * 10,
        'SAR',
        pick(APPT_SOURCE, a),
        now,
        now,
        tenantIds[t],
        pick(branches, a),
        pick(customers, a),
        staffId,
        pick(APPT_PAYMENT_STATUSES, a),
      ]);
    }
    appointmentIdsByTenant.push(ids);
  }
  await bulkInsert(
    ds,
    'appointments',
    ['id', 'start_at', 'end_at', 'status', 'total_amount', 'currency', 'source', 'created_at', 'updated_at', 'tenantId', 'branchId', 'customerId', 'staffId', 'payment_status'],
    appointmentRows,
  );
  logger.success(`appointments: ${appointmentRows.length}`);

  // --------------------------------------------------------- invoices/payments
  const invoiceRows: unknown[][] = [];
  const paymentRows: unknown[][] = [];
  for (let t = 0; t < cfg.tenants; t++) {
    const appointments = appointmentIdsByTenant[t];
    const customers = customerIdsByTenant[t];
    const branches = branchIdsByTenant[t];
    for (let i = 0; i < cfg.invoicesPerTenant; i++) {
      const invoiceId = randomUUID();
      const appt = pick(appointments, i);
      const cust = pick(customers, i);
      const amount = 200 + (i % 30) * 15;
      invoiceRows.push([invoiceId, `PERF-${tier}-${t}-${String(i + 1).padStart(6, '0')}`, amount, pick(INVOICE_STATUSES, i), now, tenantIds[t], appt, cust]);

      paymentRows.push([
        randomUUID(),
        amount,
        'SAR',
        pick(PAYMENT_STATUSES, i),
        'UNSETTLED',
        now,
        now,
        tenantIds[t],
        pick(branches, i),
        appt,
        cust,
        0,
        0,
      ]);
    }
  }
  await bulkInsert(ds, 'invoices', ['id', 'invoice_number', 'total_amount', 'status', 'created_at', 'tenantId', 'appointmentId', 'customerId'], invoiceRows);
  await bulkInsert(
    ds,
    'payments',
    ['id', 'amount', 'currency', 'status', 'settlement_status', 'created_at', 'updated_at', 'tenantId', 'branchId', 'appointmentId', 'customerId', 'gateway_fee', 'platform_fee'],
    paymentRows,
  );
  logger.success(`invoices: ${invoiceRows.length}, payments: ${paymentRows.length}`);

  // ------------------------------------------------------- conversations/messages
  const conversationRows: unknown[][] = [];
  const messageRows: unknown[][] = [];
  for (let t = 0; t < cfg.tenants; t++) {
    const customers = customerIdsByTenant[t];
    const branches = branchIdsByTenant[t];
    for (let c = 0; c < cfg.conversationsPerTenant; c++) {
      const convId = randomUUID();
      conversationRows.push([convId, pick(CONV_STATUSES, c), 'whatsapp', now, now, tenantIds[t], pick(branches, c), pick(customers, c), 'AI']);

      const nMsgs = cfg.messagesPerConversation + (c % 2 === 0 ? -1 : 1);
      for (let m = 0; m < nMsgs; m++) {
        messageRows.push([randomUUID(), pick(SENDER_TYPES, m), `Perf fixture message ${m + 1} in conversation ${c}`, 'text', now, convId, tenantIds[t]]);
      }
    }
  }
  await bulkInsert(ds, 'conversations', ['id', 'status', 'type', 'last_message_at', 'created_at', 'tenantId', 'branchId', 'customerId', 'owner_type'], conversationRows);
  await bulkInsert(ds, 'messages', ['id', 'sender_type', 'content', 'message_type', 'created_at', 'conversationId', 'tenantId'], messageRows, 2000);
  logger.success(`conversations: ${conversationRows.length}, messages: ${messageRows.length}`);

  // Deliberately NOT seeded here (scope decision, recorded in data-tiers.md):
  // campaigns/campaign_recipients (require CampaignRun + WhatsApp account
  // wiring; campaign THROUGHPUT is measured via the existing ephemeral
  // bench.* queue pattern instead, not via DB-seeded recipient volume) and
  // every ledger/operational table (api_logs, analytics_events,
  // notifications, webhook_deliveries, audit_logs) — those accumulate from
  // real traffic driven against this seeded state in A4-A11, not from
  // direct seeding, since they represent a record of activity, not platform
  // state.

  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  logger.step(`Perf fixture tier ${tier} seeded in ${seconds}s`);
  logger.info(`Primary tenant logins (documented, for scripted journeys): perf.owner.t0@${tier.toLowerCase()}.local.test .. perf.owner.t${PRIMARY_TENANT_COUNT - 1}@${tier.toLowerCase()}.local.test, password Perf${tier}Primary123!`);
}

const APPT_SOURCE = ['PLATFORM', 'WHATSAPP_BOT', 'MANUAL'] as const;

function parseTierArg(): Tier {
  const arg = process.argv.find((a) => a.startsWith('--tier='));
  const value = arg?.split('=')[1]?.toUpperCase();
  if (value !== 'T1' && value !== 'T2') {
    throw new Error(`--tier=T1|T2 is required (got "${value ?? 'undefined'}")`);
  }
  return value;
}

async function main(): Promise<void> {
  const tier = parseTierArg();
  logger.step(`Connecting to database for perf fixture (tier ${tier})`);
  await SeedDataSource.initialize();
  logger.success(`connected to "${SeedDataSource.options.database}"`);
  try {
    await seedPerfFixture(SeedDataSource, tier);
  } finally {
    await SeedDataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Perf fixture seed failed — database left partially seeded; drop and retry', err);
    if (SeedDataSource.isInitialized) {
      void SeedDataSource.destroy();
    }
    process.exit(1);
  });
}
