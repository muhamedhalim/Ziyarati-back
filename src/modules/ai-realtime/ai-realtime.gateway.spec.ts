import { Socket } from 'socket.io';

import { AiRealtimeGateway } from './ai-realtime.gateway';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { HandoverRequestService } from '../ai/handover-request.service';
import { AiConversationAccessService } from '../ai/ai-conversation-access.service';
import { HandoverChatService } from './handover-chat.service';
import { AgentPresenceService } from './agent-presence.service';
import { WsAuthService } from './ws-auth.service';
import { AI_EVENT } from './ai-events.constants';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import {
  AccessSource,
  QuotaPolicy,
} from '../subscription-billing/tenant-access-decision';
import { PERMISSION } from '../../rbac/rbac.constants';

const TENANT = 't1';

/**
 * The WebSocket bypass.
 *
 * A socket never passes through `SubscriptionAccessGuard` or `FeatureGuard` —
 * those are HTTP guards — so before this gate `ai:message` reached
 * `AiOrchestratorService` with NO entitlement evaluation at all. A clinic whose
 * AI capability was never granted, or was administratively suspended
 * mid-incident, kept running AI turns for as long as a browser tab stayed open.
 */
describe('AiRealtimeGateway — AI entitlement on executing events', () => {
  let gateway: AiRealtimeGateway;
  let orchestrator: { handleStream: jest.Mock };
  let handovers: { create: jest.Mock };
  let handoverChat: { sendAgentReply: jest.Mock };
  let conversationAccess: { canAccess: jest.Mock };
  let entitlements: { resolve: jest.Mock; shouldBlock: jest.Mock };

  const allowed = {
    allowed: true,
    tenantId: TENANT,
    featureKey: FeatureKey.AI_ASSISTANT,
    source: AccessSource.FEATURE_OVERRIDE,
    quotaPolicy: QuotaPolicy.UNMETERED_BY_PLAN,
  };
  const denied = {
    allowed: false,
    tenantId: TENANT,
    featureKey: FeatureKey.AI_ASSISTANT,
    source: AccessSource.DENIED,
    quotaPolicy: QuotaPolicy.BLOCKED,
    reason: 'Feature is administratively suspended for this tenant',
  };

  const socket = (permissions: string[] = []): Socket =>
    ({
      data: {
        tenantId: TENANT,
        userId: 'u1',
        user: { id: 'u1', tenantId: TENANT, roles: [], permissions },
      },
      emit: jest.fn(),
      join: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      rooms: new Set<string>(),
    }) as unknown as Socket;

  // Mirrors WsAuthService's real guest principal: permissions: [], guest:
  // true, never a `users` row or role — structurally can never satisfy a
  // permission check.
  const guestSocket = (): Socket =>
    ({
      data: {
        tenantId: TENANT,
        userId: 'guest-1',
        user: {
          id: 'guest-1',
          tenantId: TENANT,
          roles: [],
          permissions: [],
          guest: true,
        },
      },
      emit: jest.fn(),
      join: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      rooms: new Set<string>(),
    }) as unknown as Socket;

  let tenantContext: TenantContextService;

  beforeEach(() => {
    orchestrator = {
      handleStream: jest.fn().mockResolvedValue({
        aiConversationId: 'conv-1',
        reply: { content: 'hi' },
        usage: {},
        streamed: false,
      }),
    };
    handovers = { create: jest.fn().mockResolvedValue({ id: 'h1' }) };
    handoverChat = {
      sendAgentReply: jest
        .fn()
        .mockResolvedValue({ dispatchedToWhatsapp: true }),
    };
    conversationAccess = { canAccess: jest.fn().mockResolvedValue(true) };
    entitlements = {
      resolve: jest.fn().mockResolvedValue(allowed),
      shouldBlock: jest.fn().mockReturnValue(true),
    };
    tenantContext = new TenantContextService();

    gateway = new AiRealtimeGateway(
      {} as unknown as WsAuthService,
      orchestrator as unknown as AiOrchestratorService,
      tenantContext,
      handovers as unknown as HandoverRequestService,
      handoverChat as unknown as HandoverChatService,
      {} as unknown as AgentPresenceService,
      conversationAccess as unknown as AiConversationAccessService,
      entitlements as unknown as AccessControlService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('ai:message', () => {
    // AI-007: onMessage now also requires ai.conversations.manage
    // (`:42`-adjacent gate, added alongside the pre-existing entitlement
    // check). Every case below that exercises the ENTITLEMENT gate must
    // hold this permission too, or it would trip the (different) permission
    // gate instead and stop proving what it's meant to prove.
    it('runs the turn when the clinic holds the AI capability', async () => {
      const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);
      await gateway.onMessage(client, { content: 'hello' });

      expect(entitlements.resolve).toHaveBeenCalledWith(
        TENANT,
        FeatureKey.AI_ASSISTANT,
      );
      expect(orchestrator.handleStream).toHaveBeenCalled();
    });

    it('never reaches the orchestrator when AI is denied', async () => {
      entitlements.resolve.mockResolvedValueOnce(denied);
      const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

      await gateway.onMessage(client, { content: 'hello' });

      expect(orchestrator.handleStream).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith(AI_EVENT.ERROR, {
        message: 'The AI assistant is not available for this clinic',
      });
    });

    /**
     * The socket error is deliberately generic: `decision.reason` names the
     * clinic's subscription state or an administrative suspension, and this
     * frame is delivered straight to a browser that may be a patient's.
     */
    it('does not leak the internal reason over the wire', async () => {
      entitlements.resolve.mockResolvedValueOnce(denied);
      const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

      await gateway.onMessage(client, { content: 'hello' });

      const frame = (client.emit as jest.Mock).mock.calls.find(
        ([event]) => event === AI_EVENT.ERROR,
      );
      expect(JSON.stringify(frame)).not.toContain('suspended');
    });

    it('fails CLOSED when the decision cannot be resolved', async () => {
      entitlements.resolve.mockRejectedValueOnce(new Error('db down'));
      const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

      await gateway.onMessage(client, { content: 'hello' });

      expect(orchestrator.handleStream).not.toHaveBeenCalled();
    });

    // Plan §18 — shadow records the denial and lets the turn run.
    it('runs the turn anyway in shadow mode', async () => {
      entitlements.resolve.mockResolvedValueOnce(denied);
      entitlements.shouldBlock.mockReturnValueOnce(false);

      await gateway.onMessage(socket([PERMISSION.AI_CONVERSATIONS_MANAGE]), {
        content: 'hello',
      });

      expect(orchestrator.handleStream).toHaveBeenCalled();
      expect(entitlements.shouldBlock).toHaveBeenCalledWith(
        expect.objectContaining({ allowed: false }),
        { surface: 'websocket', detail: AI_EVENT.MESSAGE },
      );
    });

    it('AI-007 — refuses ai:message without ai.conversations.manage: never reaches the orchestrator, and the refusal is an ai:error, not a throw', async () => {
      const client = socket(); // no permissions — an entitled clinic, unpermitted principal
      await expect(
        gateway.onMessage(client, { content: 'hello' }),
      ).resolves.not.toThrow();

      expect(orchestrator.handleStream).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith(AI_EVENT.ERROR, {
        message: 'Forbidden',
      });
      // The entitlement check runs BEFORE the permission check (unchanged
      // ordering) — reached regardless of which gate ultimately refuses.
      expect(entitlements.resolve).toHaveBeenCalled();
    });

    it('AI-007 — a GUEST principal (permissions: [], guest: true) is exempt from the staff permission gate and still reaches the orchestrator', async () => {
      const client = guestSocket();
      await gateway.onMessage(client, { content: 'hello' });

      expect(orchestrator.handleStream).toHaveBeenCalled();
      expect(client.emit).not.toHaveBeenCalledWith(
        AI_EVENT.ERROR,
        expect.objectContaining({ message: 'Forbidden' }),
      );
    });

    describe('AI-016/C2 — correlation id (FR-031, FR-082)', () => {
      it('adopts a well-formed client-supplied correlation hint', async () => {
        const spy = jest.spyOn(tenantContext, 'setCorrelationId');
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

        await gateway.onMessage(client, {
          content: 'hello',
          correlationId: 'trace-abc.123_XYZ',
        });

        expect(spy).toHaveBeenCalledWith('trace-abc.123_XYZ');
      });

      it('rejects a malformed hint (disallowed characters) in favour of a server-generated id', async () => {
        const spy = jest.spyOn(tenantContext, 'setCorrelationId');
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

        await gateway.onMessage(client, {
          content: 'hello',
          correlationId: 'has spaces/and;punct',
        });

        expect(spy).toHaveBeenCalledTimes(1);
        const [used] = spy.mock.calls[0];
        expect(used).not.toBe('has spaces/and;punct');
        expect(used).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ); // server-generated UUID fallback
      });

      it('rejects an over-long hint (>100 chars) in favour of a server-generated id', async () => {
        const spy = jest.spyOn(tenantContext, 'setCorrelationId');
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);
        const tooLong = 'a'.repeat(101);

        await gateway.onMessage(client, { content: 'hello', correlationId: tooLong });

        const [used] = spy.mock.calls[0];
        expect(used).not.toBe(tooLong);
        expect((used as string).length).toBeLessThan(101);
      });

      it('generates a server-side id when no hint is supplied', async () => {
        const spy = jest.spyOn(tenantContext, 'setCorrelationId');
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

        await gateway.onMessage(client, { content: 'hello' });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(typeof spy.mock.calls[0][0]).toBe('string');
      });

      // FR-082: the hint is a correlation label only — never consulted by
      // any authorization or tenancy decision. The entitlement/permission
      // gates above already ran and passed before setCorrelationId is even
      // called (see onMessage's own ordering), so a hint can structurally
      // never influence them; this pins that a malicious-looking hint
      // specifically does not change the outcome either.
      it('a hint that looks like an injection attempt does not affect authorization or tenancy', async () => {
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

        await gateway.onMessage(client, {
          content: 'hello',
          correlationId: "'; DROP TABLE ai_tool_calls; --",
        });

        expect(orchestrator.handleStream).toHaveBeenCalled();
        expect(client.emit).not.toHaveBeenCalledWith(
          AI_EVENT.ERROR,
          expect.anything(),
        );
      });
    });
  });

  describe('lifecycle events that drive an AI conversation', () => {
    it('refuses ai:handover when AI is denied', async () => {
      entitlements.resolve.mockResolvedValueOnce(denied);

      const res = await gateway.onHandover(socket(), {
        aiConversationId: 'conv-1',
      });

      expect(res).toEqual({ ok: false });
      expect(handovers.create).not.toHaveBeenCalled();
    });

    it('refuses ai:agent:reply when AI is denied', async () => {
      entitlements.resolve.mockResolvedValueOnce(denied);

      const res = await gateway.onAgentReply(
        socket([PERMISSION.AI_HANDOVER_MANAGE]),
        { aiConversationId: 'conv-1', content: 'hi' },
      );

      expect(res).toEqual({ ok: false });
      expect(handoverChat.sendAgentReply).not.toHaveBeenCalled();
    });

    it('allows ai:agent:reply for an entitled clinic with the permission', async () => {
      const res = await gateway.onAgentReply(
        socket([PERMISSION.AI_HANDOVER_MANAGE]),
        { aiConversationId: 'conv-1', content: 'hi' },
      );

      expect(res).toMatchObject({ ok: true });
      expect(handoverChat.sendAgentReply).toHaveBeenCalled();
    });

    /**
     * Entitlement never replaces the RBAC check — it is an additional gate.
     * A staff-only event stays staff-only for an entitled clinic.
     */
    it('still refuses ai:agent:reply without the permission, entitlement notwithstanding', async () => {
      const res = await gateway.onAgentReply(socket(), {
        aiConversationId: 'conv-1',
        content: 'hi',
      });

      expect(res).toEqual({ ok: false });
      expect(entitlements.resolve).not.toHaveBeenCalled();
    });
  });
});
