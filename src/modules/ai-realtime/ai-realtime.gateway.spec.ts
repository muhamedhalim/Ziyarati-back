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
import { AiWsRateLimitService } from './ai-ws-rate-limit.service';
import { ErrorCode } from '../../common/errors/error-code';
import { AppError } from '../../common/errors/app-error';
import { QueryFailedError } from 'typeorm';

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
  let wsRateLimit: { checkAndRecord: jest.Mock };

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
    // Default: never refuses — cases below that specifically exercise the
    // rate limiter override this per-test.
    wsRateLimit = {
      checkAndRecord: jest.fn().mockResolvedValue({ allowed: true }),
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
      wsRateLimit as unknown as AiWsRateLimitService,
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
        code: 'FORBIDDEN',
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
      // Unified {code, message} error contract (guest-identity-churn fix,
      // section 8) — every emit on this gateway now carries a machine-
      // readable `code`, this one included.
      expect(client.emit).toHaveBeenCalledWith(AI_EVENT.ERROR, {
        code: ErrorCode.FORBIDDEN,
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

        await gateway.onMessage(client, {
          content: 'hello',
          correlationId: tooLong,
        });

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

    describe('AI-022 — channel length (FR-046, FR-047)', () => {
      it('rejects an over-length channel with a clean VALIDATION_ERROR, before persistence', async () => {
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);
        const overLong = 'A'.repeat(21); // AiConversation.channel is varchar(20)

        await gateway.onMessage(client, {
          content: 'hello',
          channel: overLong as never,
        });

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        expect(client.emit).toHaveBeenCalledWith(
          AI_EVENT.ERROR,
          expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        );
      });

      it('accepts a channel at exactly the 20-character bound', async () => {
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);
        const exactlyTwenty = 'A'.repeat(20);

        await gateway.onMessage(client, {
          content: 'hello',
          channel: exactlyTwenty as never,
        });

        expect(orchestrator.handleStream).toHaveBeenCalled();
      });
    });

    describe('AI-015/AI-028 — realtime rate limiting (FR-051, FR-053, D5)', () => {
      it('checks the rate limiter with the authenticated user id and tier, after entitlement + permission, before the turn runs', async () => {
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);
        await gateway.onMessage(client, { content: 'hello' });

        expect(wsRateLimit.checkAndRecord).toHaveBeenCalledWith(
          'u1',
          'authenticated',
        );
        expect(orchestrator.handleStream).toHaveBeenCalled();
      });

      it('checks the rate limiter with the guest tier for a guest principal', async () => {
        const client = guestSocket();
        await gateway.onMessage(client, { content: 'hello' });

        expect(wsRateLimit.checkAndRecord).toHaveBeenCalledWith(
          'guest-1',
          'guest',
        );
      });

      it('never consults the rate limiter for a call already refused on permission grounds — refused calls must not consume budget', async () => {
        const client = socket(); // no permissions
        await gateway.onMessage(client, { content: 'hello' });

        expect(wsRateLimit.checkAndRecord).not.toHaveBeenCalled();
      });

      it('refuses the turn with RATE_LIMITED when the healthy-path limiter trips', async () => {
        wsRateLimit.checkAndRecord.mockResolvedValueOnce({
          allowed: false,
          code: ErrorCode.RATE_LIMITED,
        });
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

        await gateway.onMessage(client, { content: 'hello' });

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        expect(client.emit).toHaveBeenCalledWith(
          AI_EVENT.ERROR,
          expect.objectContaining({ code: ErrorCode.RATE_LIMITED }),
        );
      });

      it('refuses the turn with SERVICE_UNAVAILABLE on the fail-closed degraded path — distinct from the normal RATE_LIMITED refusal', async () => {
        wsRateLimit.checkAndRecord.mockResolvedValueOnce({
          allowed: false,
          code: ErrorCode.SERVICE_UNAVAILABLE,
        });
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

        await gateway.onMessage(client, { content: 'hello' });

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        const [, payload] = (client.emit as jest.Mock).mock.calls.find(
          ([event]) => event === AI_EVENT.ERROR,
        )!;
        expect(payload.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
        expect(payload.code).not.toBe(ErrorCode.RATE_LIMITED);
      });

      it('runs the turn normally when the limiter allows it', async () => {
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);
        await gateway.onMessage(client, { content: 'hello' });

        expect(orchestrator.handleStream).toHaveBeenCalled();
        expect(client.emit).not.toHaveBeenCalledWith(
          AI_EVENT.ERROR,
          expect.anything(),
        );
      });
    });

    describe('AI-010 — shared error normalization on a failed turn (FR-040, FR-041, FR-042)', () => {
      it('sanitizes a raw driver error instead of echoing it to the client', async () => {
        orchestrator.handleStream.mockRejectedValueOnce(
          Object.assign(
            new QueryFailedError('SELECT 1', [], new Error('dup')),
            { code: '23505', detail: 'Key (email)=(x@y.com) already exists.' },
          ),
        );
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

        await gateway.onMessage(client, { content: 'hello' });

        const [, payload] = (client.emit as jest.Mock).mock.calls.find(
          ([event]) => event === AI_EVENT.ERROR,
        )!;
        expect(payload.code).toBeDefined();
        expect(JSON.stringify(payload)).not.toContain('x@y.com');
        expect(JSON.stringify(payload)).not.toContain('SELECT 1');
      });

      // FR-042: normalization must not flatten every error into one opaque
      // string — a deliberate, safe AppError message the application code
      // itself chose to throw still reaches the client UNCHANGED.
      it('a deliberate, safe AppError message still reaches the client unchanged', async () => {
        orchestrator.handleStream.mockRejectedValueOnce(
          new AppError(ErrorCode.CONFLICT, {
            message: 'This appointment slot was just booked by someone else.',
          }),
        );
        const client = socket([PERMISSION.AI_CONVERSATIONS_MANAGE]);

        await gateway.onMessage(client, { content: 'hello' });

        expect(client.emit).toHaveBeenCalledWith(
          AI_EVENT.ERROR,
          expect.objectContaining({
            code: ErrorCode.CONFLICT,
            message: 'This appointment slot was just booked by someone else.',
          }),
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

  /**
   * Guest-identity-churn fix, error-contract half: every conversation-lookup
   * failure on this gateway must emit the SAME `{code, message}` shape
   * (`ai:message`'s `runMessage` catch already normalized via
   * `normalizeException` — AI-010), so a client can branch on `code` instead
   * of string-matching `message`. `onJoin` previously failed completely
   * silently (no `ai:error` at all), which is what let a stale restored
   * `aiConversationId` sit unnoticed until the next `ai:message` also failed.
   */
  describe('unified {code, message} error contract for conversation lookups', () => {
    it('ai:join emits a coded NOT_FOUND — not silence — when the conversation cannot be accessed', async () => {
      conversationAccess.canAccess.mockResolvedValueOnce(false);
      const client = socket();

      const res = await gateway.onJoin(client, {
        aiConversationId: 'stale-conv',
      });

      expect(res).toEqual({ joined: null });
      expect(client.emit).toHaveBeenCalledWith(AI_EVENT.ERROR, {
        code: ErrorCode.NOT_FOUND,
        message: 'AI conversation not found',
      });
    });

    it('ai:join emits no error on success', async () => {
      const client = socket();

      const res = await gateway.onJoin(client, { aiConversationId: 'conv-1' });

      expect(res).toEqual({ joined: 'conv-1' });
      expect(client.emit).not.toHaveBeenCalledWith(
        AI_EVENT.ERROR,
        expect.anything(),
      );
    });

    it('ai:handover emits a coded NOT_FOUND for an inaccessible conversation', async () => {
      conversationAccess.canAccess.mockResolvedValueOnce(false);
      const client = socket();

      await gateway.onHandover(client, { aiConversationId: 'stale-conv' });

      expect(client.emit).toHaveBeenCalledWith(AI_EVENT.ERROR, {
        code: ErrorCode.NOT_FOUND,
        message: 'AI conversation not found',
      });
    });

    it('ai:agent:reply emits a coded NOT_FOUND for an inaccessible conversation', async () => {
      conversationAccess.canAccess.mockResolvedValueOnce(false);
      const client = socket([PERMISSION.AI_HANDOVER_MANAGE]);

      await gateway.onAgentReply(client, {
        aiConversationId: 'stale-conv',
        content: 'hi',
      });

      expect(client.emit).toHaveBeenCalledWith(AI_EVENT.ERROR, {
        code: ErrorCode.NOT_FOUND,
        message: 'AI conversation not found',
      });
    });
  });
});

/**
 * `ai:tool` — per-tool progress on a streaming turn.
 *
 * The property under test is not "an event is emitted" but WHAT it carries and
 * WHERE it goes. Before this event existed the client had only
 * `ai:thinking`/`ai:token`/`ai:done`, so a turn that spent seconds inside
 * `search_public_availability` was indistinguishable from a hung one — and the
 * tempting client-side workaround (cycle plausible statuses on a timer) would
 * have been fabricated progress.
 */
describe('AiRealtimeGateway — ai:tool progress', () => {
  const TENANT_ID = 't1';

  function build(streamImpl: jest.Mock) {
    const orchestrator = { handleStream: streamImpl };
    const tenantContext = new TenantContextService();
    const gateway = new AiRealtimeGateway(
      {} as unknown as WsAuthService,
      orchestrator as unknown as AiOrchestratorService,
      tenantContext,
      { create: jest.fn() } as unknown as HandoverRequestService,
      { sendAgentReply: jest.fn() } as unknown as HandoverChatService,
      {} as unknown as AgentPresenceService,
      {
        canAccess: jest.fn().mockResolvedValue(true),
      } as unknown as AiConversationAccessService,
      {
        resolve: jest.fn().mockResolvedValue({
          allowed: true,
          tenantId: TENANT_ID,
          featureKey: FeatureKey.AI_ASSISTANT,
          source: AccessSource.FEATURE_OVERRIDE,
          quotaPolicy: QuotaPolicy.UNMETERED_BY_PLAN,
        }),
        shouldBlock: jest.fn().mockReturnValue(true),
      } as unknown as AccessControlService,
      {
        checkAndRecord: jest.fn().mockResolvedValue({ allowed: true }),
      } as unknown as AiWsRateLimitService,
    );
    return gateway;
  }

  const guest = (): Socket =>
    ({
      id: 'sock-1',
      data: {
        tenantId: TENANT_ID,
        userId: 'guest-1',
        user: {
          id: 'guest-1',
          tenantId: TENANT_ID,
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

  it('relays a tool start/end to the calling socket, carrying the NAME only', async () => {
    const stream = jest.fn(async (_tenantId, _input, _onToken, onToolEvent) => {
      onToolEvent?.({ name: 'search_public_availability', phase: 'start' });
      onToolEvent?.({ name: 'search_public_availability', phase: 'end' });
      return {
        aiConversationId: 'conv-1',
        reply: { content: 'here are the times' },
        usage: {},
        streamed: true,
      };
    });
    const gateway = build(stream as unknown as jest.Mock);
    const client = guest();

    await gateway.onMessage(client, { content: 'when can I come in?' });

    const toolEmits = (client.emit as jest.Mock).mock.calls.filter(
      (c) => c[0] === AI_EVENT.TOOL,
    );
    expect(toolEmits).toHaveLength(2);
    expect(toolEmits[0][1]).toEqual({
      aiConversationId: null,
      name: 'search_public_availability',
      phase: 'start',
    });
    expect(toolEmits[1][1]).toMatchObject({ phase: 'end' });

    // The whole point of the payload shape: a public booking call carries the
    // patient's name and phone in its arguments, and clinic data in its
    // result. Neither may ride a socket that exists to drive a spinner.
    for (const [, payload] of toolEmits) {
      expect(Object.keys(payload as object).sort()).toEqual([
        'aiConversationId',
        'name',
        'phase',
      ]);
    }
  });

  it('never broadcasts tool progress to the conversation or tenant room', async () => {
    const roomEmit = jest.fn();
    const stream = jest.fn(async (_tenantId, _input, _onToken, onToolEvent) => {
      onToolEvent?.({ name: 'list_cities', phase: 'start' });
      return {
        aiConversationId: 'conv-1',
        reply: { content: 'ok' },
        usage: {},
        streamed: true,
      };
    });
    const gateway = build(stream as unknown as jest.Mock);
    const client = guest();
    (client.to as jest.Mock).mockReturnValue({ emit: roomEmit });

    await gateway.onMessage(client, { content: 'hi' });

    // Other viewers of this conversation still get CONVERSATION_UPDATE; they
    // must not get another client's per-tool chatter.
    expect(roomEmit.mock.calls.some((c) => c[0] === AI_EVENT.TOOL)).toBe(false);
  });

  it('a turn that calls no tool emits no ai:tool at all', async () => {
    const stream = jest.fn(async () => ({
      aiConversationId: 'conv-1',
      reply: { content: 'we open at 9' },
      usage: {},
      streamed: true,
    }));
    const gateway = build(stream as unknown as jest.Mock);
    const client = guest();

    await gateway.onMessage(client, { content: 'what time do you open?' });

    expect(
      (client.emit as jest.Mock).mock.calls.some((c) => c[0] === AI_EVENT.TOOL),
    ).toBe(false);
  });
});

/**
 * Attachment ids on a socket frame.
 *
 * Socket.IO frames never pass through the global `ValidationPipe`, so whatever
 * a client emits arrives here as-is. This is not the authorization boundary —
 * redemption is scoped to the socket's own verified subject, so a foreign id
 * resolves to nothing — but a malformed frame must be dropped at the edge
 * rather than carried three layers deeper before something notices.
 */
describe('AiRealtimeGateway — ai:message attachmentIds', () => {
  const TENANT_ID = 't1';
  const VALID_A = '11111111-1111-4111-8111-111111111111';
  const VALID_B = '22222222-2222-4222-8222-222222222222';

  function build() {
    const handleStream = jest.fn().mockResolvedValue({
      aiConversationId: 'conv-1',
      reply: { content: 'ok' },
      usage: {},
      streamed: true,
    });
    const gateway = new AiRealtimeGateway(
      {} as unknown as WsAuthService,
      { handleStream } as unknown as AiOrchestratorService,
      new TenantContextService(),
      { create: jest.fn() } as unknown as HandoverRequestService,
      { sendAgentReply: jest.fn() } as unknown as HandoverChatService,
      {} as unknown as AgentPresenceService,
      { canAccess: jest.fn().mockResolvedValue(true) } as unknown as AiConversationAccessService,
      {
        resolve: jest.fn().mockResolvedValue({
          allowed: true,
          tenantId: TENANT_ID,
          featureKey: FeatureKey.AI_ASSISTANT,
          source: AccessSource.FEATURE_OVERRIDE,
          quotaPolicy: QuotaPolicy.UNMETERED_BY_PLAN,
        }),
        shouldBlock: jest.fn().mockReturnValue(true),
      } as unknown as AccessControlService,
      {
        checkAndRecord: jest.fn().mockResolvedValue({ allowed: true }),
      } as unknown as AiWsRateLimitService,
    );
    return { gateway, handleStream };
  }

  const guest = (): Socket =>
    ({
      id: 'sock-1',
      data: {
        tenantId: TENANT_ID,
        userId: 'guest-1',
        user: { id: 'guest-1', tenantId: TENANT_ID, roles: [], permissions: [], guest: true },
      },
      emit: jest.fn(),
      join: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      rooms: new Set<string>(),
    }) as unknown as Socket;

  async function forwarded(attachmentIds: unknown) {
    const { gateway, handleStream } = build();
    await gateway.onMessage(guest(), {
      content: 'what does this say?',
      attachmentIds,
    } as never);
    return handleStream.mock.calls[0][1].attachmentIds;
  }

  it('forwards well-formed uuid v4 ids', async () => {
    expect(await forwarded([VALID_A, VALID_B])).toEqual([VALID_A, VALID_B]);
  });

  it('omits the field entirely when the client sent none', async () => {
    expect(await forwarded(undefined)).toBeUndefined();
  });

  it.each([
    ['a bare string instead of an array', 'not-an-array'],
    ['an object', { id: VALID_A }],
    ['an array of non-strings', [1, 2, 3]],
    ['an array of malformed ids', ['../../etc/passwd', "'; DROP TABLE--"]],
    ['an empty array', []],
  ])('drops %s', async (_label, value) => {
    expect(await forwarded(value)).toBeUndefined();
  });

  it('keeps only the well-formed entries from a mixed array', async () => {
    expect(await forwarded([VALID_A, 'nonsense', 42, null])).toEqual([VALID_A]);
  });

  it('caps a flood at the same three the DTO allows', async () => {
    // A thousand-element array is a denial-of-service that no single-id check
    // would catch.
    const flood = Array.from({ length: 1000 }, () => VALID_A);
    expect(await forwarded(flood)).toHaveLength(3);
  });
});
