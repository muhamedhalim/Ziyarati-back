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

    gateway = new AiRealtimeGateway(
      {} as unknown as WsAuthService,
      orchestrator as unknown as AiOrchestratorService,
      new TenantContextService(),
      handovers as unknown as HandoverRequestService,
      handoverChat as unknown as HandoverChatService,
      {} as unknown as AgentPresenceService,
      conversationAccess as unknown as AiConversationAccessService,
      entitlements as unknown as AccessControlService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('ai:message', () => {
    it('runs the turn when the clinic holds the AI capability', async () => {
      const client = socket();
      await gateway.onMessage(client, { content: 'hello' });

      expect(entitlements.resolve).toHaveBeenCalledWith(
        TENANT,
        FeatureKey.AI_ASSISTANT,
      );
      expect(orchestrator.handleStream).toHaveBeenCalled();
    });

    it('never reaches the orchestrator when AI is denied', async () => {
      entitlements.resolve.mockResolvedValueOnce(denied);
      const client = socket();

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
      const client = socket();

      await gateway.onMessage(client, { content: 'hello' });

      const frame = (client.emit as jest.Mock).mock.calls.find(
        ([event]) => event === AI_EVENT.ERROR,
      );
      expect(JSON.stringify(frame)).not.toContain('suspended');
    });

    it('fails CLOSED when the decision cannot be resolved', async () => {
      entitlements.resolve.mockRejectedValueOnce(new Error('db down'));
      const client = socket();

      await gateway.onMessage(client, { content: 'hello' });

      expect(orchestrator.handleStream).not.toHaveBeenCalled();
    });

    // Plan §18 — shadow records the denial and lets the turn run.
    it('runs the turn anyway in shadow mode', async () => {
      entitlements.resolve.mockResolvedValueOnce(denied);
      entitlements.shouldBlock.mockReturnValueOnce(false);

      await gateway.onMessage(socket(), { content: 'hello' });

      expect(orchestrator.handleStream).toHaveBeenCalled();
      expect(entitlements.shouldBlock).toHaveBeenCalledWith(
        expect.objectContaining({ allowed: false }),
        { surface: 'websocket', detail: AI_EVENT.MESSAGE },
      );
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
