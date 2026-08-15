/**
 * T092 — entitlement-absent invocation: disable the `AI_ASSISTANT` feature for
 * one tenant and drive BOTH the REST orchestrator route and the `/ai`
 * WebSocket `ai:message` event, asserting both fail closed.
 *
 * How the feature is disabled: `AccessControlService`'s own doc comment
 * (`access-control.service.ts:80-95`) names ADMINISTRATIVE SUSPENSION as the
 * ONLY precedence level that outranks `PLATFORM_FREE_MODE` — this environment
 * is in free mode (HARNESS_GUIDE gotcha #1), so merely NOT granting a
 * subscription/override does nothing (free mode already admits every
 * capability). `FeatureFlagService.setSuspension(tenantId, AI_ASSISTANT, true, ...)`
 * writes the `feature_flags.is_suspended` row that `AccessControlService.decide()`
 * checks FIRST, before even looking at free mode — the real "incident
 * kill-switch" mechanism, not a workaround.
 *
 * REST: `AiOrchestratorController` carries `@RequireFeature(FeatureKey.AI_ASSISTANT)`,
 * enforced by the GLOBAL `FeatureGuard` (`app.module.ts` `APP_GUARD` list) —
 * this harness boots the real `AppModule`, so the real global guard chain is
 * in effect.
 *
 * WS: `AiRealtimeGateway.mayUseAi` (`ai-realtime.gateway.ts:93-124`) is the
 * gate for the SAME capability on the `ai:message` socket event — called
 * directly here (a fake `Socket`-shaped object, mirroring
 * `ai-w2-auth-boundary.spec.ts`'s `fakeHandshake()` pattern) rather than
 * standing up a real Socket.IO client, since the class method IS the real
 * production code path (`AiRealtimeGateway.onMessage`).
 *
 * The seeded staff user only holds the DOCTOR role (deliberately minimal —
 * no `ai.conversations.manage`), which would 403 at the PERMISSION layer
 * regardless of entitlement and confound this test. An OWNER role is granted
 * to the SAME seeded user (mirrors `ai-audit-seed.ts`'s own role-lookup
 * pattern) so the only variable under test is the entitlement gate.
 */
import request from 'supertest';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiOrchestratorService } from '../../src/modules/ai-orchestrator/ai-orchestrator.service';
import { AiRealtimeGateway } from '../../src/modules/ai-realtime/ai-realtime.gateway';
import { AI_EVENT } from '../../src/modules/ai-realtime/ai-events.constants';
import { AccessControlService } from '../../src/modules/subscription-billing/access-control.service';
import { FeatureFlagService } from '../../src/modules/subscription-billing/feature-flag.service';
import { FeatureKey } from '../../src/modules/subscription-billing/feature-registry';
import { AuthService } from '../../src/modules/auth/auth.service';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { User } from '../../src/entities/Auth&RBAC/User';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { ROLE } from '../../src/rbac/rbac.constants';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';

function fakeSocket(tenantId: string, user: AuthenticatedUser) {
  return {
    data: { tenantId, user },
    emit: jest.fn(),
    join: jest.fn(),
    to: jest.fn(() => ({ emit: jest.fn() })),
  } as unknown as import('socket.io').Socket & { emit: jest.Mock; join: jest.Mock; to: jest.Mock };
}

describe('W3 — AI_ASSISTANT entitlement disabled, REST + WS parity (T092)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let access: AccessControlService;
  let featureFlags: FeatureFlagService;
  let ownerToken: string;
  let ownerPrincipal: AuthenticatedUser;
  let gateway: AiRealtimeGateway;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    access = harness.app.get(AccessControlService);
    featureFlags = harness.app.get(FeatureFlagService);
    gateway = harness.app.get(AiRealtimeGateway);

    // Elevate the seeded staff user to OWNER (in addition to their existing
    // DOCTOR role) so `ai.conversations.manage` is held — isolates the
    // entitlement gate as the only variable under test.
    const roles = harness.dataSource.getRepository(Role);
    const userRoles = harness.dataSource.getRepository(UserRole);
    const ownerRole = await roles.createQueryBuilder('r').where('r.slug = :slug', { slug: ROLE.OWNER }).andWhere('r."tenantId" IS NULL').getOne();
    if (!ownerRole) throw new Error('seeded system role "owner" not found — run the RBAC seed against the test database first.');
    await userRoles.save(userRoles.create({ user: { id: seed.tenantA.staffUserId } as User, role: { id: ownerRole.id } as Role }));

    const auth = harness.app.get(AuthService);
    ownerPrincipal = await auth.buildAuthenticatedUser(seed.tenantA.staffUserId);
    expect(ownerPrincipal.permissions).toContain('ai.conversations.manage'); // sanity: the elevation actually worked

    ownerToken = await harness.jwt.signAsync(
      { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
      { secret: harness.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
  }, 120_000);

  afterAll(async () => {
    // Clear the suspension so it never leaks into a later spec file sharing
    // this tenant id space (defensive — each spec seeds its own tenant, but
    // the flag write is real DB state).
    await featureFlags.setSuspension(seed.tenantA.id, FeatureKey.AI_ASSISTANT, false, { reason: 'T092 cleanup' }).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  const ORCHESTRATOR_ROUTE = '/api/v1/ai/orchestrator/message';

  it('BASELINE (control case): before suspension, the REST route is NOT blocked by entitlement (platform free mode grants it)', async () => {
    const decision = await access.resolve(seed.tenantA.id, FeatureKey.AI_ASSISTANT);
    expect(decision.allowed).toBe(true);

    const res = await request(harness.app.getHttpServer())
      .post(ORCHESTRATOR_ROUTE)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channel: 'DASHBOARD', content: 'baseline probe before suspension' });
    // Whatever downstream happens (a real provider isn't wired in this
    // harness's default AppModule boot — no scripted override here — so the
    // actual AI call may itself fail), the key baseline fact is it is NOT a
    // 403 sourced from the entitlement gate.
    expect(res.status).not.toBe(403);
  });

  it('BASELINE (control case): before suspension, the WS mayUseAi gate allows the event through to the orchestrator', async () => {
    const orchestrator = harness.app.get(AiOrchestratorService);
    const spy = jest.spyOn(orchestrator, 'handleStream').mockResolvedValue({
      aiConversationId: 'stub-conv',
      agentRole: 'assistant',
      reply: 'stub reply',
      usage: {},
      streamed: true,
    } as never);

    const client = fakeSocket(seed.tenantA.id, ownerPrincipal);
    await gateway.onMessage(client, { content: 'baseline probe', channel: 'WEBSITE' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(client.emit).not.toHaveBeenCalledWith(AI_EVENT.ERROR, expect.anything());
    spy.mockRestore();
  });

  it('suspends AI_ASSISTANT for tenant A (the administrative kill-switch, NOT a subscription change)', async () => {
    await featureFlags.setSuspension(seed.tenantA.id, FeatureKey.AI_ASSISTANT, true, { reason: 'T092 audit probe' });
    const decision = await access.resolve(seed.tenantA.id, FeatureKey.AI_ASSISTANT);
    expect(decision.allowed).toBe(false);
  });

  it('REST: POST /ai/orchestrator/message now fails closed — 403, before the orchestrator/execution layer is ever reached', async () => {
    const res = await request(harness.app.getHttpServer())
      .post(ORCHESTRATOR_ROUTE)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channel: 'DASHBOARD', content: 'this must never reach the AI engine' });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/AI_ASSISTANT|feature|subscription/i);
  });

  it('WS: the ai:message event now fails closed — mayUseAi refuses, orchestrator.handleStream is NEVER called, client receives ai:error', async () => {
    const orchestrator = harness.app.get(AiOrchestratorService);
    const spy = jest.spyOn(orchestrator, 'handleStream');

    const client = fakeSocket(seed.tenantA.id, ownerPrincipal);
    await gateway.onMessage(client, { content: 'this must never reach the AI engine', channel: 'WEBSITE' });

    expect(spy).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith(AI_EVENT.ERROR, expect.objectContaining({ message: expect.stringContaining('not available') }));
    spy.mockRestore();
  });

  it('both transports converge on the SAME entitlement decision (equivalent server-side artifact: HTTP 403 vs socket ai:error, both sourced from the identical AccessControlService.resolve() denial)', async () => {
    const decision = await access.resolve(seed.tenantA.id, FeatureKey.AI_ASSISTANT);
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBeDefined();
    // Documented, not glossed over: the two transports do NOT return
    // byte-identical artifacts (REST: HTTP 403 + AppError JSON body; WS: a
    // socket "ai:error" emission with no HTTP status at all — sockets have
    // none). What IS equivalent, and is what this task's Verify clause
    // requires, is that BOTH fail closed from the SAME underlying decision,
    // confirmed above by driving both transports against the identical
    // suspended tenant and observing neither reaches the execution layer.
  });
});
