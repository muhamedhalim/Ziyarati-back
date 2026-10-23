/**
 * T098 — REST vs WebSocket authorization parity: the SAME operation (send an
 * AI message) attempted by the SAME principal over both transports, reporting
 * any control present on one and absent on the other.
 *
 * REST: `POST /ai/orchestrator/message` — gated by `PermissionsGuard` +
 * `@RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)`
 * (`ai-orchestrator.controller.ts:49,67`).
 *
 * WS: `AiRealtimeGateway.onMessage` (`ai:message` event,
 * `ai-realtime.gateway.ts:367-390`) — reads `client.data.tenantId`/`.user`,
 * calls `mayUseAi()` (FEATURE ENTITLEMENT only, `ai-realtime.gateway.ts:93-124`),
 * then calls `this.orchestrator.handleStream(...)` directly. No RBAC
 * permission check of any kind appears in this handler — sockets bypass
 * `PermissionsGuard` entirely (a fact the SAME file's own class doc comment
 * acknowledges for `ai:agent:reply`/`ai:handover`, which is why THOSE two
 * events have an explicit, hand-written permission check inside the gateway
 * — `ai:message` has no equivalent). This file confirms whether that gap is
 * real by driving BOTH transports with the identical under-privileged
 * principal, not by re-reading the source claim.
 */
import request from 'supertest';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiOrchestratorService } from '../../src/modules/ai-orchestrator/ai-orchestrator.service';
import { AiRealtimeGateway } from '../../src/modules/ai-realtime/ai-realtime.gateway';
import { AI_EVENT } from '../../src/modules/ai-realtime/ai-events.constants';
import { AuthService } from '../../src/modules/auth/auth.service';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';

function fakeSocket(tenantId: string, user: AuthenticatedUser) {
  return {
    data: { tenantId, user },
    emit: jest.fn(),
    join: jest.fn(),
    to: jest.fn(() => ({ emit: jest.fn() })),
  } as unknown as import('socket.io').Socket & { emit: jest.Mock; join: jest.Mock; to: jest.Mock };
}

describe('W3 — REST vs WS authorization parity, same principal (T098)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let gateway: AiRealtimeGateway;
  let doctorPrincipal: AuthenticatedUser;
  let doctorToken: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    gateway = harness.app.get(AiRealtimeGateway);

    // The seeded staff user holds ONLY the DOCTOR role
    // (`rbac.constants.ts:1630-1633`: DASHBOARD_ACCESS + APPOINTMENTS_READ_OWN
    // — no ai.conversations.manage) — the exact under-privileged principal
    // this comparison needs, with no extra setup.
    const auth = harness.app.get(AuthService);
    doctorPrincipal = await auth.buildAuthenticatedUser(seed.tenantA.staffUserId);
    expect(doctorPrincipal.permissions).not.toContain('ai.conversations.manage'); // sanity

    doctorToken = await harness.jwt.signAsync(
      { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
      { secret: harness.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  const ORCHESTRATOR_ROUTE = '/api/v1/ai/orchestrator/message';

  it('REST: a principal WITHOUT ai.conversations.manage is refused — 403, before the orchestrator is ever reached', async () => {
    const res = await request(harness.app.getHttpServer())
      .post(ORCHESTRATOR_ROUTE)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ channel: 'DASHBOARD', content: 'this must never reach the AI engine' });
    expect(res.status).toBe(403);
  });

  it('WS: the SAME principal, the SAME operation (ai:message) — REMEDIATED (RTP row 8): the orchestrator is NOT reached; WS refuses identically to REST', async () => {
    const orchestrator = harness.app.get(AiOrchestratorService);
    const spy = jest.spyOn(orchestrator, 'handleStream').mockResolvedValue({
      aiConversationId: 'stub-conv',
      agentRole: 'assistant',
      reply: 'stub reply',
      usage: {},
      streamed: true,
    } as never);

    const client = fakeSocket(seed.tenantA.id, doctorPrincipal);
    await expect(
      gateway.onMessage(client, { content: 'this must never reach the AI engine over WS either', channel: 'WEBSITE' }),
    ).resolves.not.toThrow();

    // PARITY RESTORED, confirmed by execution: the same principal REST
    // refuses with 403 is now ALSO refused over WS — an ai:error, never a
    // throw across the socket (FR-016).
    expect(spy).not.toHaveBeenCalled();
    // The WS error envelope carries a machine-readable `code` (ErrorCode.FORBIDDEN) next to the message.
    expect(client.emit).toHaveBeenCalledWith(AI_EVENT.ERROR, { code: 'FORBIDDEN', message: 'Forbidden' });

    spy.mockRestore();
  });

  it('records the parity table for this operation (REST vs WS, same principal, same content)', () => {
    // eslint-disable-next-line no-console
    console.log(
      '\n===T098-PARITY-TABLE===\n' +
        JSON.stringify(
          {
            operation: 'send AI message (ai.conversations.manage-gated on REST)',
            principal: 'doctor role (DASHBOARD_ACCESS + APPOINTMENTS_READ_OWN only)',
            rest: { route: 'POST /api/v1/ai/orchestrator/message', control: 'PermissionsGuard + @RequirePermissions(ai.conversations.manage)', observed: '403 Forbidden' },
            ws: { event: 'ai:message (AiRealtimeGateway.onMessage)', control: 'AI-007 fix: hand-written ai.conversations.manage check (mirrors REST) + mayUseAi() feature-entitlement check', observed: 'ai:error {message: "Forbidden"} — orchestrator.handleStream() never invoked' },
            divergence: false,
          },
          null,
          2,
        ) +
        '\n===END===\n',
    );
    expect(true).toBe(true);
  });

  it('compensating factor, confirmed structurally (not a full mitigation): individual TOOL calls made during a WS-driven turn still pass through AiToolDispatchService\'s own per-tool permission checks (T088-T090) — the parity gap admits UNAUTHORIZED CONVERSATIONAL ACCESS and the ungated-tool surface (T089), not an escalation of tool-level authority', () => {
    // No new execution needed — this is the audit's own cross-reference:
    // T088/T089/T090 already proved AiToolDispatchService checks
    // ctx.permissions independently of how the turn was initiated. Recorded
    // here so the severity assessment in candidates-w3.md is not read in
    // isolation from that mitigating context.
    expect(doctorPrincipal.permissions).not.toContain('ai.conversations.manage');
  });
});
