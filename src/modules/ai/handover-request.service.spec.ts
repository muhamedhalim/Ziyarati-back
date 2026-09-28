import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { HandoverRequestService } from './handover-request.service';
import { HandoverRequest } from '../../entities/AI Agent/HandoverRequest';
import { Conversation } from '../../entities/Conversations/Conversation';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import { CustomerNoteService } from '../crm/customer-note.service';
import { PublicBookingContextService } from '../public-booking/public-booking-context.service';
import { HANDOVER_STATUS } from './ai.constants';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('HandoverRequestService', () => {
  let service: HandoverRequestService;
  let handovers: MockRepository;
  let conversations: MockRepository;
  let aiConversations: MockRepository;
  let users: MockRepository;
  let aiMessages: MockRepository;
  let timeline: { recordChannelMessage: jest.Mock };
  let publicBooking: { resolveSelectedClinic: jest.Mock };

  beforeEach(async () => {
    handovers = createMockRepository();
    conversations = createMockRepository();
    aiConversations = createMockRepository();
    users = createMockRepository();
    aiMessages = createMockRepository();
    timeline = { recordChannelMessage: jest.fn().mockResolvedValue({ id: 'm' }) };
    publicBooking = { resolveSelectedClinic: jest.fn() };
    conversations.exists.mockResolvedValue(true);
    users.exists.mockResolvedValue(true);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        HandoverRequestService,
        { provide: getRepositoryToken(HandoverRequest), useValue: handovers },
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        { provide: getRepositoryToken(AiConversation), useValue: aiConversations },
        { provide: getRepositoryToken(AiMessage), useValue: aiMessages },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(UserRole), useValue: createMockRepository() },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConversationExecutionService, useValue: timeline },
        { provide: CustomerNoteService, useValue: {} },
        { provide: PublicBookingContextService, useValue: publicBooking },
      ],
    }).compile();
    service = moduleRef.get(HandoverRequestService);
  });

  afterEach(() => jest.clearAllMocks());

  const load = (status: string) =>
    handovers.findOne.mockResolvedValue({
      id: 'h1',
      status,
      conversation: { id: 'c1' },
      assigned_to: { id: 'u1' },
    });

  it('creates a handover and flips a linked AI conversation to HANDED_OVER', async () => {
    handovers.save.mockResolvedValueOnce({ id: 'h1' });
    // First call is the new idempotency pre-check (no open handover yet); the
    // second is the trailing `this.findOne()` that returns the saved row.
    handovers.findOne.mockResolvedValueOnce(null);
    handovers.findOne.mockResolvedValueOnce({ id: 'h1', status: HANDOVER_STATUS.PENDING });
    aiConversations.findOne.mockResolvedValueOnce({ id: 'ai1', status: 'ACTIVE' });
    await service.create(TENANT, { conversationId: 'c1', aiConversationId: 'ai1' } as any);
    expect(aiConversations.save).toHaveBeenCalled();
  });

  describe('idempotency', () => {
    it('returns the existing OPEN handover instead of creating a duplicate', async () => {
      handovers.findOne.mockResolvedValueOnce({
        id: 'h-existing',
        status: HANDOVER_STATUS.PENDING,
        conversation: { id: 'c1' },
      });
      const res = await service.create(TENANT, { conversationId: 'c1' } as any);
      expect(res).toMatchObject({ id: 'h-existing' });
      expect(handovers.save).not.toHaveBeenCalled();
    });

    it('a TERMINAL existing handover does not block a fresh one', async () => {
      handovers.save.mockResolvedValueOnce({ id: 'h2' });
      handovers.findOne.mockResolvedValueOnce({
        id: 'h-old',
        status: HANDOVER_STATUS.RESOLVED,
        conversation: { id: 'c1' },
      });
      handovers.findOne.mockResolvedValueOnce({ id: 'h2', status: HANDOVER_STATUS.PENDING });
      const res = await service.create(TENANT, { conversationId: 'c1' } as any);
      expect(handovers.save).toHaveBeenCalled();
      expect(res).toMatchObject({ id: 'h2' });
    });
  });

  it('rejects a conversation not in the tenant with 422', async () => {
    conversations.exists.mockResolvedValueOnce(false);
    await expect(service.create(TENANT, { conversationId: 'x' } as any)).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('assign rejects an assignee not in the tenant', async () => {
    users.exists.mockResolvedValueOnce(false);
    await expect(service.assign(TENANT, 'h1', { assignedToUserId: 'x' } as any)).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('assign transitions PENDING → ASSIGNED', async () => {
    load(HANDOVER_STATUS.PENDING);
    await service.assign(TENANT, 'h1', { assignedToUserId: 'u1' } as any);
    expect(handovers.save).toHaveBeenCalledWith(expect.objectContaining({ status: HANDOVER_STATUS.ASSIGNED }));
  });

  it('assign rejects a terminal handover', async () => {
    load(HANDOVER_STATUS.RESOLVED);
    await expect(service.assign(TENANT, 'h1', { assignedToUserId: 'u1' } as any)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });

  it('accept requires ASSIGNED status', async () => {
    load(HANDOVER_STATUS.PENDING);
    await expect(service.accept(TENANT, 'h1', 'u1')).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('resolve sets RESOLVED + resolved_at', async () => {
    load(HANDOVER_STATUS.ACCEPTED);
    await service.resolve(TENANT, 'h1');
    const saved = handovers.save.mock.calls[0][0];
    expect(saved.status).toBe(HANDOVER_STATUS.RESOLVED);
    expect(saved.resolved_at).toBeInstanceOf(Date);
  });

  it('reject sets REJECTED (terminal)', async () => {
    load(HANDOVER_STATUS.ASSIGNED);
    await service.reject(TENANT, 'h1', 'spam');
    expect(handovers.save).toHaveBeenCalledWith(expect.objectContaining({ status: HANDOVER_STATUS.REJECTED }));
  });

  // ── F-07: a web guest's "talk to a human" ─────────────────────────────────
  describe('guest handover (F-07)', () => {
    const DISCOVERY = 'discovery-tenant';
    const CLINIC = 'clinic-tenant';
    const GUEST = { id: 'guest-1', tenantId: DISCOVERY, roles: [], permissions: [], guest: true } as any;
    const STAFF = { id: 'u1', tenantId: CLINIC, roles: ['owner'], permissions: [] } as any;

    beforeEach(() => {
      handovers.save.mockImplementation(async (x: any) => ({ id: 'h-new', ...x }));
      handovers.findOne.mockResolvedValue({ id: 'h-new', status: HANDOVER_STATUS.PENDING });
      conversations.save.mockImplementation(async (x: any) => ({ id: 'k-new', ...x }));
      publicBooking.resolveSelectedClinic.mockResolvedValue(CLINIC);
    });

    it('a staff / WhatsApp principal is filed under ITS OWN tenant, as before — the clinic resolver is never consulted', async () => {
      handovers.findOne.mockResolvedValueOnce(null); // idempotency pre-check: nothing open yet
      aiConversations.findOne.mockResolvedValueOnce({ id: 'ai1', status: 'ACTIVE', conversation: { id: 'c1' } });
      await service.requestForCustomer(CLINIC, STAFF, { aiConversationId: 'ai1', reason: 'x' } as any);
      expect(publicBooking.resolveSelectedClinic).not.toHaveBeenCalled();
      expect(handovers.create).toHaveBeenCalledWith(expect.objectContaining({ tenant: { id: CLINIC } }));
      expect(aiConversations.findOne.mock.calls[0][0].where).toEqual({ id: 'ai1', tenant: { id: CLINIC } });
    });

    it("a guest is filed under the clinic the SERVER resolved, and its AI conversation is looked up in the guest's own tenant", async () => {
      handovers.findOne.mockResolvedValueOnce(null); // idempotency pre-check: nothing open yet
      aiConversations.findOne.mockResolvedValueOnce({ id: 'ai1', status: 'ACTIVE', conversation: undefined });
      await service.requestForCustomer(DISCOVERY, GUEST, { aiConversationId: 'ai1', reason: 'wants a person' } as any);

      expect(publicBooking.resolveSelectedClinic).toHaveBeenCalledWith(DISCOVERY, 'ai1', GUEST);
      expect(aiConversations.findOne.mock.calls[0][0].where).toEqual({ id: 'ai1', tenant: { id: DISCOVERY } });
      expect(handovers.create).toHaveBeenCalledWith(expect.objectContaining({ tenant: { id: CLINIC } }));
      expect(conversations.create).toHaveBeenCalledWith(expect.objectContaining({ tenant: { id: CLINIC } }));
    });

    it('a guest cannot choose the clinic: any tenant / conversation id in the DTO is ignored', async () => {
      handovers.findOne.mockResolvedValueOnce(null); // idempotency pre-check: nothing open yet
      aiConversations.findOne.mockResolvedValueOnce({ id: 'ai1', status: 'ACTIVE' });
      await service.requestForCustomer(DISCOVERY, GUEST, {
        aiConversationId: 'ai1',
        conversationId: 'someone-elses-conversation',
        tenantId: 'other-clinic',
      } as any);
      expect(conversations.exists).not.toHaveBeenCalled(); // the supplied conversationId path was not taken
      expect(handovers.create).toHaveBeenCalledWith(expect.objectContaining({ tenant: { id: CLINIC } }));
    });

    it('a guest with no clinic selected is refused and NOTHING is written anywhere', async () => {
      publicBooking.resolveSelectedClinic.mockRejectedValue(new Error('No clinic has been selected'));
      await expect(
        service.requestForCustomer(DISCOVERY, GUEST, { aiConversationId: 'ai1' } as any),
      ).rejects.toThrow('No clinic has been selected');
      expect(handovers.save).not.toHaveBeenCalled();
      expect(conversations.save).not.toHaveBeenCalled();
      expect(aiConversations.save).not.toHaveBeenCalled();
    });

    it("opens a FRESH conversation in the clinic and links the guest's AI conversation to it (a stale link from another tenant is never reused)", async () => {
      handovers.findOne.mockResolvedValueOnce(null); // idempotency pre-check: nothing open yet
      aiConversations.findOne.mockResolvedValueOnce({
        id: 'ai1',
        status: 'ACTIVE',
        conversation: { id: 'stale-conv-from-another-clinic' },
      });
      await service.requestForCustomer(DISCOVERY, GUEST, { aiConversationId: 'ai1' } as any);

      const linked = aiConversations.save.mock.calls[0][0];
      expect(linked.conversation.id).toBe('k-new');
      expect(handovers.create).toHaveBeenCalledWith(
        expect.objectContaining({ conversation: { id: 'k-new' } }),
      );
    });

    it('a second request while already handed over returns the OPEN request — no second conversation, no second clinic', async () => {
      aiConversations.findOne.mockResolvedValueOnce({
        id: 'ai1',
        status: 'HANDED_OVER',
        conversation: { id: 'k1' },
      });
      handovers.findOne.mockResolvedValueOnce({ id: 'h-open', status: HANDOVER_STATUS.ACCEPTED });

      const res = await service.requestForCustomer(DISCOVERY, GUEST, { aiConversationId: 'ai1' } as any);

      expect(res).toMatchObject({ id: 'h-open' });
      expect(conversations.save).not.toHaveBeenCalled();
      expect(handovers.save).not.toHaveBeenCalled();
    });

    it("seeds the clinic's conversation with the guest's recent chat, read ONLY from the guest's own tenant", async () => {
      handovers.findOne.mockResolvedValueOnce(null); // idempotency pre-check: nothing open yet
      aiConversations.findOne.mockResolvedValueOnce({ id: 'ai1', status: 'ACTIVE' });
      aiMessages.find.mockResolvedValueOnce([
        { role: 'assistant', content: 'How can I help?' },
        { role: 'user', content: 'I want to speak to someone' },
      ]);

      await service.requestForCustomer(DISCOVERY, GUEST, { aiConversationId: 'ai1' } as any);

      const where = aiMessages.find.mock.calls[0][0].where;
      expect(where.tenant).toEqual({ id: DISCOVERY });
      expect(where.ai_conversation_id).toBe('ai1');
      // the query is newest-first, so it is reversed: oldest first, written into the CLINIC's tenant
      expect(timeline.recordChannelMessage.mock.calls.map((c) => [c[0], c[2], c[3]])).toEqual([
        [CLINIC, 'CUSTOMER', 'I want to speak to someone'],
        [CLINIC, 'BOT', 'How can I help?'],
      ]);
    });

    it("a failure while seeding the transcript never stops the request being filed", async () => {
      handovers.findOne.mockResolvedValueOnce(null); // idempotency pre-check: nothing open yet
      aiConversations.findOne.mockResolvedValueOnce({ id: 'ai1', status: 'ACTIVE' });
      aiMessages.find.mockRejectedValueOnce(new Error('db hiccup'));
      await expect(
        service.requestForCustomer(DISCOVERY, GUEST, { aiConversationId: 'ai1' } as any),
      ).resolves.toBeDefined();
      expect(handovers.save).toHaveBeenCalled();
    });
  });

  // ── the clinic's staff take part in a conversation whose AI half is elsewhere ─
  describe('canAgentAccess (F-07)', () => {
    it('true only when the AI conversation is linked to a conversation THIS tenant owns AND this tenant holds a handover request on it', async () => {
      aiConversations.findOne.mockResolvedValueOnce({ id: 'ai1', conversation: { id: 'k1' } });
      handovers.exists.mockResolvedValueOnce(true);

      expect(await service.canAgentAccess('clinic', 'ai1')).toBe(true);
      expect(aiConversations.findOne.mock.calls[0][0].where).toEqual({
        id: 'ai1',
        conversation: { tenant: { id: 'clinic' } },
      });
      expect(handovers.exists).toHaveBeenCalledWith({
        where: { conversation: { id: 'k1' }, tenant: { id: 'clinic' } },
      });
    });

    it('false when no conversation of this tenant is linked', async () => {
      aiConversations.findOne.mockResolvedValueOnce(null);
      expect(await service.canAgentAccess('clinic', 'ai1')).toBe(false);
      expect(handovers.exists).not.toHaveBeenCalled();
    });

    it('false when the link exists but this tenant holds no handover request on it', async () => {
      aiConversations.findOne.mockResolvedValueOnce({ id: 'ai1', conversation: { id: 'k1' } });
      handovers.exists.mockResolvedValueOnce(false);
      expect(await service.canAgentAccess('clinic', 'ai1')).toBe(false);
    });

    it('false (never throws) on a malformed id or a database error', async () => {
      aiConversations.findOne.mockRejectedValueOnce(new Error('invalid input syntax for type uuid'));
      expect(await service.canAgentAccess('clinic', 'not-a-uuid')).toBe(false);
      expect(await service.canAgentAccess('', 'ai1')).toBe(false);
      expect(await service.canAgentAccess('clinic', '')).toBe(false);
    });
  });

  describe('returnToAi for a guest conversation (F-07)', () => {
    it("resumes the AI and removes the cross-tenant link, so the guest's later turns cannot mirror into the clinic's conversation", async () => {
      handovers.findOne.mockResolvedValue({
        id: 'h1',
        status: HANDOVER_STATUS.ACCEPTED,
        conversation: { id: 'k1' },
      });
      const guestAi = { id: 'ai1', status: 'HANDED_OVER', tenant: { id: 'discovery' }, conversation: { id: 'k1' } };
      aiConversations.findOne.mockResolvedValueOnce(guestAi);

      await service.returnToAi('clinic', 'h1');

      expect(aiConversations.findOne.mock.calls[0][0].where).toEqual({
        conversation: { id: 'k1', tenant: { id: 'clinic' } },
      });
      const saved = aiConversations.save.mock.calls[0][0];
      expect(saved.status).toBe('ACTIVE');
      expect(saved.conversation).toBeNull();
    });

    it('keeps the link for a same-tenant conversation (WhatsApp / dashboard) exactly as before', async () => {
      handovers.findOne.mockResolvedValue({
        id: 'h1',
        status: HANDOVER_STATUS.ACCEPTED,
        conversation: { id: 'k1' },
      });
      const own = { id: 'ai1', status: 'HANDED_OVER', tenant: { id: 'clinic' }, conversation: { id: 'k1' } };
      aiConversations.findOne.mockResolvedValueOnce(own);

      await service.returnToAi('clinic', 'h1');

      const saved = aiConversations.save.mock.calls[0][0];
      expect(saved.status).toBe('ACTIVE');
      expect(saved.conversation).toEqual({ id: 'k1' });
    });
  });

  describe('sendAgentReply authorisation (F-07)', () => {
    it("looks the AI conversation up as the tenant's own OR as one linked to a conversation the tenant owns — never by id alone", async () => {
      aiConversations.findOne.mockResolvedValueOnce(null);
      await expect(service.sendAgentReply('clinic', 'u1', 'ai-of-another-tenant', 'hi')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(aiConversations.findOne.mock.calls[0][0].where).toEqual([
        { id: 'ai-of-another-tenant', tenant: { id: 'clinic' } },
        { id: 'ai-of-another-tenant', conversation: { tenant: { id: 'clinic' } } },
      ]);
    });
  });
});
