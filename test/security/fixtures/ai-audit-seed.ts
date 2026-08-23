/**
 * Deterministic seed fixture for Feature 011 (AI security audit) — T015.
 *
 * Provisions the baseline DATA every W1–W8 audit spec needs, via DIRECT
 * TypeORM repository writes against the real e2e Postgres `DataSource`
 * (never HTTP, never a full business-logic service) — this fixture creates
 * test data, it does not exercise a creation API. Synthetic data only, no
 * production data.
 *
 * Reuses the EXACT setup shapes already proven in this repo rather than
 * inventing new ones:
 *  - tenant creation mirrors `test/ai-guest-isolation.e2e-spec.ts`'s
 *    `beforeAll` (`Tenant` repo `.create`/`.save` with a random-suffixed
 *    slug) and `test/utils/whatsapp-e2e-app.ts`'s `createOwnerFixture`;
 *  - the staff user + role assignment mirrors `createOwnerFixture`'s
 *    User/Role/UserRole pattern (no password hash — that fixture never sets
 *    one either, and nothing here authenticates via password login);
 *  - the appointment (customer/branch/staff/status/payment_status/currency/
 *    source shape) mirrors `test/staff-role-scoping.e2e-spec.ts`'s
 *    `beforeAll`, which is the one proven direct-repo appointment write in
 *    this test suite;
 *  - guest principal minting mirrors `test/ai-guest-isolation.e2e-spec.ts`'s
 *    `mintGuest()`: a REAL `POST /api/v1/public/guest/session` call, reading
 *    the `guest_token` cookie off the response, then verifying it through
 *    the REAL `WsAuthService.authenticate()` — the exact principal the
 *    gateway would derive, never a hand-built object.
 *
 * Idempotent across runs: every unique value (tenant slug/email, customer
 * phone/email, staff email) is suffixed with a fresh `randomUUID().slice(0,
 * 8)` per call, so repeat runs never collide with a previous run's leftovers
 * (and `teardownAiAuditSeed` cleans up its own run regardless).
 */
import { randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Socket } from 'socket.io';

import { Tenant } from '../../../src/entities/SaaS-Core/Tenant';
import { Branch } from '../../../src/entities/SaaS-Core/Branch';
import { Customer } from '../../../src/entities/CRM/Customer';
import { AiAgent } from '../../../src/entities/AI Agent/AiAgent';
import { AiKnowledgeBase } from '../../../src/entities/AI Agent/AiKnowledgeBase';
import { User } from '../../../src/entities/Auth&RBAC/User';
import { Role } from '../../../src/entities/Auth&RBAC/Role';
import { UserRole } from '../../../src/entities/Auth&RBAC/UserRole';
import { StaffProfile } from '../../../src/entities/Staff/StaffProfile';
import { Appointment } from '../../../src/entities/Calendar&Appointments/Appointment';
import {
  TenantApprovalStatus,
  AppointmentStatus,
  AppointmentPaymentStatus,
  AppointmentSource,
} from '../../../src/entities/enums';
import { ROLE } from '../../../src/rbac/rbac.constants';
import { GuestSessionService } from '../../../src/modules/guest-chat/guest-session.service';
import { WsAuthService } from '../../../src/modules/ai-realtime/ws-auth.service';
import type { AuthenticatedUser } from '../../../src/modules/auth/interfaces/authenticated-user.interface';

/** Per-run suffix so two runs of this fixture never collide (unique slugs/emails/phones). */
const RUN = `aud-${randomUUID().slice(0, 8)}`;

export interface AiAuditTenantSeed {
  id: string;
  slug: string;
  agentId: string;
  kbId: string;
  customerIds: string[];
  staffUserId: string;
  /** `StaffProfile.id` — the actual FK target of `Appointment.staff`. Not in the minimal
   *  requested shape but needed by any spec that must reference the staff row directly. */
  staffProfileId: string;
  branchId: string;
  appointmentId: string;
}

export interface AiAuditSeed {
  tenantA: AiAuditTenantSeed;
  tenantB: AiAuditTenantSeed;
  discoveryTenantId: string;
  guestA: AuthenticatedUser;
  guestB: AuthenticatedUser;
}

function randomDigits(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 10);
  return out;
}

/**
 * Mints a real guest session and returns the principal `WsAuthService` derives —
 * identical approach to `ai-guest-isolation.e2e-spec.ts`'s `mintGuest()`: POST the
 * real public route, read the `guest_token` cookie off `Set-Cookie`, then verify it
 * exactly as the gateway would (never a hand-built `AuthenticatedUser`).
 */
async function mintGuest(app: INestApplication): Promise<AuthenticatedUser> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/public/guest/session')
    .send({})
    .expect(200);

  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const guestCookie = cookies?.find((c) => c.startsWith('guest_token='));
  if (!guestCookie) {
    throw new Error(
      'seedAiAudit: guest_token cookie was not issued by POST /api/v1/public/guest/session',
    );
  }

  const wsAuth = app.get(WsAuthService);
  return wsAuth.authenticate({
    handshake: { auth: {}, headers: { cookie: guestCookie.split(';')[0] }, query: {} },
  } as unknown as Socket);
}

/** Provisions one full tenant (agent, KB row, 2 customers, 1 staff+role, 1 appointment). */
async function seedTenant(dataSource: DataSource, label: 'a' | 'b'): Promise<AiAuditTenantSeed> {
  const suffix = `${RUN}-${label}`;

  const tenants = dataSource.getRepository(Tenant);
  const tenant = await tenants.save(
    tenants.create({
      name: `AI Audit Tenant ${suffix}`,
      slug: `ai-audit-${suffix}`,
      contact_email: `ai-audit-${suffix}@example.test`,
      approval_status: TenantApprovalStatus.APPROVED,
      is_active: true,
    }),
  );

  const branches = dataSource.getRepository(Branch);
  const branch = await branches.save(
    branches.create({ tenant: { id: tenant.id } as Tenant, name: `AI Audit Branch ${suffix}` }),
  );

  const agents = dataSource.getRepository(AiAgent);
  const agent = await agents.save(
    agents.create({
      tenant: { id: tenant.id } as Tenant,
      name: `AI Audit Agent ${suffix}`,
      system_prompt: `You are the AI receptionist for synthetic AI-audit tenant ${suffix}. This is fixture data — no real patient information.`,
      is_active: true,
    }),
  );

  const knowledgeBases = dataSource.getRepository(AiKnowledgeBase);
  const content = `Synthetic knowledge-base entry for AI-audit tenant ${suffix}. Clinic hours: 9am-5pm. No real patient data.`;
  const contentHash = createHash('sha256').update(content).digest('hex');
  const kb = await knowledgeBases.save(
    knowledgeBases.create({
      tenant: { id: tenant.id } as Tenant,
      agent: { id: agent.id } as AiAgent,
      content,
      content_hash: contentHash,
    }),
  );

  const customers = dataSource.getRepository(Customer);
  const customerRows = await customers.save([
    customers.create({
      tenant: { id: tenant.id } as Tenant,
      full_name: `Synthetic Customer 1 (${suffix})`,
      phone: `+1555${randomDigits(7)}`,
      email: `customer-${suffix}-1@example.test`,
    }),
    customers.create({
      tenant: { id: tenant.id } as Tenant,
      full_name: `Synthetic Customer 2 (${suffix})`,
      phone: `+1555${randomDigits(7)}`,
      email: `customer-${suffix}-2@example.test`,
    }),
  ]);

  // Staff member with a real (seeded system) role — mirrors
  // `createOwnerFixture` in `test/utils/whatsapp-e2e-app.ts`: a plain User row
  // (no password hash — that proven fixture never sets one) + a UserRole
  // pointing at a pre-seeded SYSTEM role (`tenant IS NULL`). `doctor` is used
  // here (rather than `owner`) because this is specifically a *staff* member,
  // and is the exact role `staff-role-scoping.e2e-spec.ts` provisions doctors
  // under.
  const users = dataSource.getRepository(User);
  const roles = dataSource.getRepository(Role);
  const userRoles = dataSource.getRepository(UserRole);
  const staffProfiles = dataSource.getRepository(StaffProfile);

  const staffUser = await users.save(
    users.create({
      tenant: { id: tenant.id } as Tenant,
      email: `staff-${suffix}@example.test`,
      full_name: `Dr Synthetic Staff (${suffix})`,
      is_active: true,
    }),
  );

  const doctorRole = await roles
    .createQueryBuilder('r')
    .where('r.slug = :slug', { slug: ROLE.DOCTOR })
    .andWhere('r."tenantId" IS NULL')
    .getOne();
  if (!doctorRole) {
    throw new Error(
      `seedAiAudit: seeded system role "${ROLE.DOCTOR}" not found — run the RBAC seed (src/seed) against the test database first.`,
    );
  }
  await userRoles.save(
    userRoles.create({ user: { id: staffUser.id } as User, role: { id: doctorRole.id } as Role }),
  );

  const staffProfile = await staffProfiles.save(
    staffProfiles.create({
      user: { id: staffUser.id } as User,
      tenant: { id: tenant.id } as Tenant,
      title: 'Synthetic Practitioner',
    }),
  );

  // Appointment — field shape (status/payment_status/currency/source, no slot,
  // no total_amount) copied verbatim from `staff-role-scoping.e2e-spec.ts`'s
  // `beforeAll`, the one proven direct-repo appointment write in this suite.
  const appointments = dataSource.getRepository(Appointment);
  const appointment = await appointments.save(
    appointments.create({
      tenant: { id: tenant.id } as Tenant,
      branch: { id: branch.id } as Branch,
      customer: { id: customerRows[0].id } as Customer,
      staff: { id: staffProfile.id } as StaffProfile,
      status: AppointmentStatus.CONFIRMED,
      payment_status: AppointmentPaymentStatus.UNPAID,
      currency: 'SAR',
      source: AppointmentSource.MANUAL,
      start_at: new Date('2027-01-01T10:00:00Z'),
      end_at: new Date('2027-01-01T10:30:00Z'),
    }),
  );

  return {
    id: tenant.id,
    slug: tenant.slug,
    agentId: agent.id,
    kbId: kb.id,
    customerIds: customerRows.map((c) => c.id),
    staffUserId: staffUser.id,
    staffProfileId: staffProfile.id,
    branchId: branch.id,
    appointmentId: appointment.id,
  };
}

/**
 * Seeds two full tenants (A, B) plus two distinct guest principals sharing the
 * same `__guest_discovery__` system tenant. Throws if the harness itself is
 * broken (guests not landing in the discovery tenant, or minting the same
 * `sub` twice) — that would invalidate every isolation assertion built on top
 * of this fixture.
 */
export async function seedAiAudit(
  app: INestApplication,
  dataSource: DataSource,
): Promise<AiAuditSeed> {
  const tenantA = await seedTenant(dataSource, 'a');
  const tenantB = await seedTenant(dataSource, 'b');

  const discoveryTenantId = await app.get(GuestSessionService).ensureDiscoveryTenant();

  const guestA = await mintGuest(app);
  const guestB = await mintGuest(app);

  if (guestA.tenantId !== discoveryTenantId || guestB.tenantId !== discoveryTenantId) {
    throw new Error(
      'seedAiAudit: minted guest principal(s) did not land in the discovery tenant — harness is broken',
    );
  }
  if (guestA.id === guestB.id) {
    throw new Error(
      'seedAiAudit: guest A and guest B minted the SAME sub on the same tenant — harness is broken',
    );
  }

  return { tenantA, tenantB, discoveryTenantId, guestA, guestB };
}

/**
 * FK-safe teardown, in reverse dependency order (children before parents).
 * Each statement is caught-and-continued individually — mirrors
 * `whatsapp-e2e-app.ts`'s `cleanupTenant` — so one unexpected failure (e.g. a
 * row a spec created outside this fixture) never hides the cleanup of
 * everything after it.
 *
 * The two guest principals and the shared `__guest_discovery__` tenant are
 * NOT touched here: `GuestSessionService.resolveSession()` only signs a JWT
 * (no DB row per guest), and the discovery tenant is a memoized singleton
 * shared across every suite in the process — deleting it would break
 * concurrently running specs.
 */
export async function teardownAiAuditSeed(
  dataSource: DataSource,
  seed: AiAuditSeed,
): Promise<void> {
  const q = async (sql: string, params: unknown[]) => {
    try {
      await dataSource.query(sql, params);
    } catch {
      // catch-and-continue — see docstring above.
    }
  };

  for (const tenant of [seed.tenantA, seed.tenantB]) {
    // Children of ai_conversations first (FK), then everything else any spec
    // that actually drove a turn through this tenant may have created —
    // discovered the hard way: ai_cost_logs' FK to tenants blocked the
    // `DELETE FROM tenants` below the first time a smoke test drove a real
    // turn (T017). Every table here is tenant-scoped per its own entity
    // (`ManyToOne(() => Tenant)` in src/entities/AI Agent/*.ts) or, for
    // ai_tool_calls, the raw-SQL ledger migrated by
    // 1730000600000-AiToolCalls.ts (snake_case tenant_id, not the TypeORM
    // camelCase "tenantId" quoting the entity tables use).
    // ai_messages.ai_conversation_id is `character varying`; ai_conversations.id
    // is `uuid` — Postgres refuses to compare the two types directly (verified:
    // "operator does not exist: character varying = uuid"), so both sides are
    // cast to text.
    await q(
      `DELETE FROM ai_messages WHERE ai_conversation_id::text IN (SELECT id::text FROM ai_conversations WHERE "tenantId" = $1)`,
      [tenant.id],
    );
    await q(`DELETE FROM ai_tool_calls WHERE tenant_id = $1`, [tenant.id]);
    // Raw-SQL ledger table from migration 1730003800000-AiFinopsHardening.ts —
    // NOT the same as the ai_cost_logs TypeORM entity below; both are written
    // to and both FK to tenants (verified: teardown failed on
    // "ai_cost_entries_tenant_id_fkey" before this line was added).
    await q(`DELETE FROM ai_cost_entries WHERE tenant_id = $1`, [tenant.id]);
    await q(`DELETE FROM ai_request_executions WHERE tenant_id = $1`, [tenant.id]);
    await q(`DELETE FROM ai_batch_items WHERE tenant_id = $1`, [tenant.id]);
    await q(`DELETE FROM ai_batch_jobs WHERE tenant_id = $1`, [tenant.id]);
    await q(`DELETE FROM ai_conversations WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM ai_cost_logs WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM ai_usage_logs WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM ai_execution_metrics WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM ai_memories WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM ai_prompts WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM ai_training_files WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM handover_requests WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM ai_kb_embeddings WHERE tenant_id = $1`, [tenant.id]); // pgvector sidecar (only present in pgvector-mode boots)
    await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tenant.id]);
    await q(`DELETE FROM ai_knowledge_bases WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM ai_agents WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM appointments WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`, [tenant.id]);
    await q(
      `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
      [tenant.id],
    );
    await q(`DELETE FROM users WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM customers WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM branches WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM api_logs WHERE "tenantId" = $1`, [tenant.id]);
    await q(`DELETE FROM tenants WHERE id = $1`, [tenant.id]);
  }
}
