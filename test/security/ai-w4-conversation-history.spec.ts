/**
 * T056 — cross-tenant conversation-history access (FR-021), against
 * `AiConversationAccessService` (service-level) and `ai-conversation.controller.ts`
 * (REST, via supertest against `harness.app.getHttpServer()`), by conversation
 * id and by message id.
 *
 * Mints a real, fully-permissioned tenant-A OWNER (the seed fixture's own
 * staff user is a DOCTOR role with only 2 permissions — insufficient to reach
 * `ai.conversations.read`/`ai.conversations.manage`, so a positive control
 * against tenant A's OWN conversation would be meaningless without a
 * permission-bearing principal) and asserts every cross-tenant attempt is
 * refused with the SAME HTTP status / `AppError` a legitimate resource would
 * get if it simply didn't exist (never an existence oracle).
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiConversationAccessService } from '../../src/modules/ai/ai-conversation-access.service';
import { AiMessage } from '../../src/entities/AI Agent/AiMessage';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { User } from '../../src/entities/Auth&RBAC/User';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { ROLE } from '../../src/rbac/rbac.constants';
import type { AiConversation } from '../../src/entities/AI Agent/AiConversation';

describe('AI-W4 conversation-history cross-tenant reproduction (T056)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let access: AiConversationAccessService;

  let tenantAOwnerToken: string;
  let convA: AiConversation;
  let convB: AiConversation;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    access = harness.app.get(AiConversationAccessService);

    // Mint a real, fully-permissioned tenant-A staff principal (OWNER role
    // holds ai.conversations.read/manage; the seed fixture's DOCTOR does not).
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
        email: `w4-owner-${suffix}@example.test`,
        full_name: `W4 Owner ${suffix}`,
        is_active: true,
      }),
    );
    createdUserIds.push(owner.id);
    await userRoles.save(userRoles.create({ user: { id: owner.id } as User, role: { id: ownerRole.id } as Role }));
    tenantAOwnerToken = await harness.jwt.signAsync(
      { sub: owner.id, tenantId: seed.tenantA.id, type: 'access' },
      { secret: harness.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );

    convA = await conversations.start(seed.tenantA.id, {});
    convB = await conversations.start(seed.tenantB.id, {});
    const messages = harness.dataSource.getRepository(AiMessage);
    await messages.save(
      messages.create({
        ai_conversation_id: convB.id,
        tenant: { id: seed.tenantB.id } as Tenant,
        role: 'user' as never,
        content: 'TENANT-B-SECRET-MESSAGE-CONTENT',
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = ANY($1)`, [[convA.id, convB.id]]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = ANY($1)`, [[convA.id, convB.id]]).catch(() => undefined);
    if (createdUserIds.length) {
      await harness.dataSource.query(`DELETE FROM user_roles WHERE "userId" = ANY($1)`, [createdUserIds]).catch(() => undefined);
      await harness.dataSource.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]).catch(() => undefined);
    }
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  // ── Service-level (AiConversationAccessService) ──────────────────────────

  describe('service level — AiConversationAccessService.assertAccess', () => {
    it('control: tenant A may access its own conversation', async () => {
      await expect(access.assertAccess(seed.tenantA.id, convA.id, null)).resolves.toMatchObject({ id: convA.id });
    });

    it('refuses tenant A reading tenant B\'s conversation id, even supplying tenant A as the scoping tenant', async () => {
      await expect(access.assertAccess(seed.tenantA.id, convB.id, null)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('is not an existence oracle: unknown id and foreign-tenant id produce byte-identical errors', async () => {
      const unknown = await access.assertAccess(seed.tenantA.id, randomUUID(), null).catch((e) => e);
      const foreign = await access.assertAccess(seed.tenantA.id, convB.id, null).catch((e) => e);
      expect(foreign.message).toBe(unknown.message);
      expect(foreign.statusCode).toBe(unknown.statusCode);
    });
  });

  // ── REST — by conversation id ─────────────────────────────────────────────

  describe('REST — GET /ai/conversations/:id (by conversation id)', () => {
    it('control: tenant-A owner reads their own conversation (200)', async () => {
      await request(harness.app.getHttpServer())
        .get(`/api/v1/ai/conversations/${convA.id}`)
        .set('Authorization', `Bearer ${tenantAOwnerToken}`)
        .expect(200);
    });

    it('refuses tenant-A owner reading tenant B\'s conversation id (404, not tenant-B data)', async () => {
      const res = await request(harness.app.getHttpServer())
        .get(`/api/v1/ai/conversations/${convB.id}`)
        .set('Authorization', `Bearer ${tenantAOwnerToken}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(seed.tenantB.id);
    });
  });

  // ── REST — by message id / conversation history ───────────────────────────

  describe('REST — GET /ai/conversations/:id/messages (conversation history, by message id via conversation id)', () => {
    it('control: tenant-A owner reads their own (empty) history (200)', async () => {
      const res = await request(harness.app.getHttpServer())
        .get(`/api/v1/ai/conversations/${convA.id}/messages`)
        .set('Authorization', `Bearer ${tenantAOwnerToken}`)
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('refuses tenant-A owner reading tenant B\'s conversation history — zero tenant-B message content in the payload', async () => {
      const res = await request(harness.app.getHttpServer())
        .get(`/api/v1/ai/conversations/${convB.id}/messages`)
        .set('Authorization', `Bearer ${tenantAOwnerToken}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('TENANT-B-SECRET-MESSAGE-CONTENT');
    });

    it('unauthenticated caller is refused entirely (401), before any tenant scoping is even reached', async () => {
      await request(harness.app.getHttpServer())
        .get(`/api/v1/ai/conversations/${convB.id}/messages`)
        .expect(401);
    });
  });
});
