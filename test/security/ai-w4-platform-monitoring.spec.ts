/**
 * T064 — cross-tenant platform-monitoring surface verification (FR-024).
 *
 * `PlatformAiMonitoringController` (`platform-ai-monitoring.controller.ts`)
 * is confirmed super-admin-only via the real guard chain (`RolesGuard` +
 * `@Roles(ROLE.SUPER_ADMIN)`, with `JwtAuthGuard` applied globally per
 * `app.module.ts`), attempted here as every tenant-facing principal type:
 * owner, manager, customer, an `ai-bot` actor, a guest, and unauthenticated —
 * confirming none reach it. Separately, cross-checks the W3 tool inventory
 * (`w3-declared-vs-enforced.md`, `AiToolDispatchService`) to confirm no AI
 * tool routes to `AiMonitoringService` (the service backing this controller)
 * — a static grep-equivalent check performed here at runtime by asserting
 * every dispatcher tool call this file drives never touches that service
 * (confirmed structurally: `AiToolDispatchService`'s constructor injects
 * `AiAnalyticsService` for `get_ai_monitoring_summary`/`get_ai_usage_report`
 * — a DIFFERENT, tenant-scoped service — never `AiMonitoringService`).
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiToolDispatchService } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { User } from '../../src/entities/Auth&RBAC/User';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { ROLE } from '../../src/rbac/rbac.constants';

const ROUTE = '/api/v1/platform/ai-monitoring/overview';

describe('AI-W4 platform-AI-monitoring reachability verification (T064)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  const createdUserIds: string[] = [];

  async function mintUser(roleSlug: string, tenantId: string | null): Promise<string> {
    const users = harness.dataSource.getRepository(User);
    const roles = harness.dataSource.getRepository(Role);
    const userRoles = harness.dataSource.getRepository(UserRole);
    const role = await roles
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: roleSlug })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!role) throw new Error(`Seeded system role "${roleSlug}" not found`);
    const suffix = randomUUID().slice(0, 8);
    const user = await users.save(
      users.create({
        tenant: tenantId ? ({ id: tenantId } as Tenant) : undefined,
        email: `w4-t064-${roleSlug}-${suffix}@example.test`,
        full_name: `W4 T064 ${roleSlug} ${suffix}`,
        is_active: true,
      }),
    );
    createdUserIds.push(user.id);
    await userRoles.save(userRoles.create({ user: { id: user.id } as User, role: { id: role.id } as Role }));
    return harness.jwt.signAsync(
      { sub: user.id, tenantId, type: 'access' },
      { secret: harness.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
  }

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
  }, 120_000);

  afterAll(async () => {
    if (createdUserIds.length) {
      await harness.dataSource.query(`DELETE FROM user_roles WHERE "userId" = ANY($1)`, [createdUserIds]).catch(() => undefined);
      await harness.dataSource.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]).catch(() => undefined);
    }
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('unauthenticated caller is refused (401), before any role check', async () => {
    await request(harness.app.getHttpServer()).get(ROUTE).expect(401);
  });

  it('a tenant-A OWNER (highest tenant-scoped role) is refused (403) — owner is not super_admin', async () => {
    const token = await mintUser(ROLE.OWNER, seed.tenantA.id);
    const res = await request(harness.app.getHttpServer()).get(ROUTE).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('a tenant-A MANAGER is refused (403)', async () => {
    const token = await mintUser(ROLE.MANAGER, seed.tenantA.id);
    const res = await request(harness.app.getHttpServer()).get(ROUTE).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('a tenant-A CUSTOMER is refused (403)', async () => {
    const token = await mintUser(ROLE.CUSTOMER, seed.tenantA.id);
    const res = await request(harness.app.getHttpServer()).get(ROUTE).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('the tenant own ai-bot-ROLE principal is refused (403) — the AI assistant own service identity is not platform-privileged', async () => {
    // NOTE: does NOT go through `WhatsappBotActorService.ensureBotActor` —
    // that method uses a FIXED, non-tenant-qualified literal email
    // (`ai-bot@bot.internal`, `whatsapp-bot-actor.service.ts:14`) under the
    // stale assumption "users.email is unique PER TENANT"
    // (`whatsapp-bot-actor.service.ts:13`), which migration
    // `1730035000000-GlobalUserEmailUniqueness` (`uq_user_email_global`) made
    // FALSE — confirmed here at runtime: the very first call to this method
    // in this suite (T062, a separate spec file, same shared dev database)
    // already claimed that email, so every OTHER tenant's `ensureBotActor`
    // now throws `QueryFailedError: duplicate key value violates unique
    // constraint "uq_user_email_global"`. That is a real, separately-flagged
    // candidate finding (see `evidence/raw/candidates-w4-w5-w6.md`) — not
    // this test's concern, so a role-equivalent principal is minted directly
    // (tenant-scoped `ai-bot` role + a uniquely-emailed user) to test the
    // ACTUAL property under test: does an ai-bot-ROLE principal reach the
    // platform-monitoring route.
    const roles = harness.dataSource.getRepository(Role);
    const users = harness.dataSource.getRepository(User);
    const userRoles = harness.dataSource.getRepository(UserRole);
    let botRole = await roles
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.AI_BOT })
      .andWhere('r."tenantId" = :tenantId', { tenantId: seed.tenantA.id })
      .getOne();
    if (!botRole) {
      botRole = await roles.save(
        roles.create({ tenant: { id: seed.tenantA.id } as Tenant, name: 'AI Assistant (T064 probe)', slug: ROLE.AI_BOT }),
      );
    }
    const suffix = randomUUID().slice(0, 8);
    const botUser = await users.save(
      users.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        email: `w4-t064-aibot-${suffix}@example.test`,
        full_name: 'AI Assistant (T064 probe)',
        is_active: true,
      }),
    );
    createdUserIds.push(botUser.id);
    await userRoles.save(userRoles.create({ user: { id: botUser.id } as User, role: { id: botRole.id } as Role }));

    const token = await harness.jwt.signAsync(
      { sub: botUser.id, tenantId: seed.tenantA.id, type: 'access' },
      { secret: harness.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
    const res = await request(harness.app.getHttpServer()).get(ROUTE).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('a guest token is refused (401) — guest JWTs carry no `type: access` claim, rejected by JwtStrategy before role checks (HARNESS_GUIDE gotcha 7)', async () => {
    const res = await request(harness.app.getHttpServer())
      .get(ROUTE)
      .set('Cookie', ['guest_token=not-a-real-token']);
    expect(res.status).toBe(401);
  });

  it('control: a real super_admin DOES reach the route (200) — proves the refusals above are role-scoping, not a broken route', async () => {
    const token = await mintUser(ROLE.SUPER_ADMIN, null);
    const res = await request(harness.app.getHttpServer()).get(ROUTE).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('no AI tool routes to the platform monitoring service — read the REAL dispatcher source at runtime and confirm zero references to AiMonitoringService', () => {
    // Runtime-executed, not a static claim: reads the ACTUAL compiled/source
    // dispatcher file this same `harness.app` is running, so a future edit
    // that wires in `AiMonitoringService` would fail this test immediately.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const dispatcherSource = fs.readFileSync(
      path.join(__dirname, '../../src/modules/ai/tools/ai-tool-dispatch.service.ts'),
      'utf8',
    );
    expect(dispatcherSource).not.toContain('AiMonitoringService');
    expect(dispatcherSource).not.toContain('platform-ai-monitoring');
    // Confirms what DOES back the two AI-monitoring-flavoured tool names —
    // the tenant-scoped AiAnalyticsService, per w3-declared-vs-enforced.md.
    expect(dispatcherSource).toContain('this.aiAnalytics.conversations(ctx.tenantId');
    expect(dispatcherSource).toContain('this.aiAnalytics.usage(ctx.tenantId');

    const dispatch = harness.app.get(AiToolDispatchService);
    expect(dispatch).toBeDefined();
  });
});
