/**
 * T063 — indirect disclosure reproduction (FR-022, boundary 13).
 *
 * Counts, existence signals, and error text must never let a tenant-A
 * principal distinguish "this resource exists, but belongs to tenant B" from
 * "this resource does not exist anywhere". Every pair below is asserted
 * BYTE-IDENTICAL (`JSON.stringify` equality, not merely "both are 404-ish")
 * across four distinct surfaces: the tool-dispatch result, the repository
 * exception, the REST conversation-access response body, and the
 * conversation-access service's own error object.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiConversationAccessService } from '../../src/modules/ai/ai-conversation-access.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { CustomerService } from '../../src/modules/crm/customer.service';
import { AppointmentsService } from '../../src/modules/appointment/appointment.service';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { User } from '../../src/entities/Auth&RBAC/User';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { ROLE } from '../../src/rbac/rbac.constants';
import type { AiConversation } from '../../src/entities/AI Agent/AiConversation';

describe('AI-W4 indirect-disclosure reproduction (T063)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let access: AiConversationAccessService;
  let dispatch: AiToolDispatchService;
  let customers: CustomerService;
  let appointments: AppointmentsService;
  let tenantAOwnerToken: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    access = harness.app.get(AiConversationAccessService);
    dispatch = harness.app.get(AiToolDispatchService);
    customers = harness.app.get(CustomerService);
    appointments = harness.app.get(AppointmentsService);

    const users = harness.dataSource.getRepository(User);
    const roles = harness.dataSource.getRepository(Role);
    const userRoles = harness.dataSource.getRepository(UserRole);
    const ownerRole = await roles
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.OWNER })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!ownerRole) throw new Error('Seeded system role "owner" not found');
    const suffix = randomUUID().slice(0, 8);
    const owner = await users.save(
      users.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        email: `w4-t063-owner-${suffix}@example.test`,
        full_name: `W4 T063 Owner ${suffix}`,
        is_active: true,
      }),
    );
    createdUserIds.push(owner.id);
    await userRoles.save(userRoles.create({ user: { id: owner.id } as User, role: { id: ownerRole.id } as Role }));
    tenantAOwnerToken = await harness.jwt.signAsync(
      { sub: owner.id, tenantId: seed.tenantA.id, type: 'access' },
      { secret: harness.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
  }, 120_000);

  afterAll(async () => {
    if (createdUserIds.length) {
      await harness.dataSource.query(`DELETE FROM user_roles WHERE "userId" = ANY($1)`, [createdUserIds]).catch(() => undefined);
      await harness.dataSource.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]).catch(() => undefined);
    }
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('AiConversationAccessService.assertAccess: real-foreign-tenant conversation id vs a random unknown id — byte-identical error', async () => {
    const conv = await conversations.start(seed.tenantB.id, {});
    const foreign = await access.assertAccess(seed.tenantA.id, conv.id, null).catch((e) => e);
    const unknown = await access.assertAccess(seed.tenantA.id, randomUUID(), null).catch((e) => e);
    expect(JSON.stringify({ message: foreign.message, statusCode: foreign.statusCode, errorCode: foreign.errorCode })).toBe(
      JSON.stringify({ message: unknown.message, statusCode: unknown.statusCode, errorCode: unknown.errorCode }),
    );
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  it('CustomerService.findOneOrThrow: a real tenant-B customer id vs a random unknown id — byte-identical error', async () => {
    const foreign = await customers.findOneOrThrow(seed.tenantA.id, seed.tenantB.customerIds[0]).catch((e) => e);
    const unknown = await customers.findOneOrThrow(seed.tenantA.id, randomUUID()).catch((e) => e);
    expect(JSON.stringify({ message: foreign.message, statusCode: foreign.statusCode })).toBe(
      JSON.stringify({ message: unknown.message, statusCode: unknown.statusCode }),
    );
  });

  it('AppointmentsService.cancel: a real tenant-B appointment id vs a random unknown id — byte-identical refusal', async () => {
    const foreign = await appointments
      .cancel(seed.tenantA.id, seed.tenantA.staffUserId, seed.tenantB.appointmentId, {})
      .catch((e) => e);
    const unknown = await appointments
      .cancel(seed.tenantA.id, seed.tenantA.staffUserId, randomUUID(), {})
      .catch((e) => e);
    expect(JSON.stringify({ message: foreign.message, statusCode: foreign.statusCode })).toBe(
      JSON.stringify({ message: unknown.message, statusCode: unknown.statusCode }),
    );
  });

  it('dispatcher tool result (get_customer_insurance_status): real-foreign-tenant id vs random unknown id — byte-identical tool payload', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id, permissions: [] };

    const foreign = await dispatch.execute(ctx, {
      id: 'i1',
      name: AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
      arguments: JSON.stringify({ customerId: seed.tenantB.customerIds[0] }),
    });
    const unknown = await dispatch.execute(ctx, {
      id: 'i2',
      name: AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
      arguments: JSON.stringify({ customerId: randomUUID() }),
    });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(unknown));
  });

  it('REST GET /ai/conversations/:id: real-foreign-tenant id vs random unknown id — byte-identical response body', async () => {
    const convB = await conversations.start(seed.tenantB.id, {});
    const resForeign = await request(harness.app.getHttpServer())
      .get(`/api/v1/ai/conversations/${convB.id}`)
      .set('Authorization', `Bearer ${tenantAOwnerToken}`);
    const resUnknown = await request(harness.app.getHttpServer())
      .get(`/api/v1/ai/conversations/${randomUUID()}`)
      .set('Authorization', `Bearer ${tenantAOwnerToken}`);

    expect(resForeign.status).toBe(resUnknown.status);
    // Compare only the fields that could carry a disclosure signal —
    // requestId/timestamp are per-request by design, `path` necessarily
    // echoes the REQUESTED id back (expected, not a leak about the
    // resource's tenant), and the debug `context.stack` is a dev-only trace
    // of the SAME code path either way (asserted separately below).
    const strip = (b: Record<string, unknown>) =>
      JSON.stringify({ statusCode: b.statusCode, error: b.error, message: b.message, code: b.code });
    expect(strip(resForeign.body)).toBe(strip(resUnknown.body));
    // The debug stack trace (if present) must point at the SAME source
    // location for both — proving even the diagnostic-only field carries no
    // tenant-B-specific information, just "which code path threw".
    const stackHead = (b: Record<string, unknown>) => {
      const ctx = b.context as { stack?: string[] } | undefined;
      return ctx?.stack?.[1]; // first frame after the error message line
    };
    expect(stackHead(resForeign.body)).toBe(stackHead(resUnknown.body));

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convB.id]);
  });

  it('aggregate count (get_appointment_overview) reveals no existence signal: a tenant-A-scoped count is identical whether or not a matching tenant-B row exists', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [PERMISSION.APPOINTMENTS_READ],
    };
    const result = await dispatch.execute(ctx, {
      id: 'i3',
      name: 'get_appointment_overview',
      arguments: JSON.stringify({}),
    });
    // Tenant A has exactly 1 appointment; tenant B's independently-seeded
    // appointment (which DOES exist in the database) contributes nothing —
    // the count carries no signal about tenant B's data at all.
    expect((result as { totalAppointments?: number }).totalAppointments).toBe(1);
  });
});
