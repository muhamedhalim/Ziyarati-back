import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConversationExecutionService } from './conversation-execution.service';
import { Message } from '../../entities/Conversations/Message';
import { Conversation } from '../../entities/Conversations/Conversation';
import { MessageStatusService } from './message-status.service';
import {
  createMockEntityManager,
  createMockRepository,
  MockEntityManager,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CUSTOMER = 'cust-1';
const ACCOUNT = 'acc-1';

/**
 * The timeline write path the WhatsApp inbound bridge relies on: idempotent
 * recording by `wamid`, and resolving ONE thread per (tenant, customer,
 * WhatsApp number) — including adopting a handover thread that was created
 * without a customer or number.
 */
describe('ConversationExecutionService — WhatsApp timeline thread', () => {
  let service: ConversationExecutionService;
  let messages: MockRepository;
  let conversations: MockRepository;
  let txMessages: MockRepository;
  let txConversations: MockRepository;
  let manager: MockEntityManager;
  let statusAppend: jest.Mock;

  beforeEach(async () => {
    messages = createMockRepository();
    conversations = createMockRepository();
    txMessages = createMockRepository();
    txConversations = createMockRepository();
    manager = createMockEntityManager(
      new Map<unknown, MockRepository>([
        [Message, txMessages],
        [Conversation, txConversations],
      ]),
    );
    statusAppend = jest.fn().mockResolvedValue(undefined);
    const dataSource = {
      transaction: jest.fn(async (cb: (m: unknown) => unknown) => cb(manager)),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationExecutionService,
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        { provide: MessageStatusService, useValue: { append: statusAppend } },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(ConversationExecutionService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('recordChannelMessageOnce — idempotent on the wamid', () => {
    const origin = { waMessageId: 'wamid.1', messageType: 'text' };
    const conv = { id: 'thread-1', customer: { id: CUSTOMER } };

    it('creates the message, its SENT status and bumps last_message_at', async () => {
      txConversations.findOne.mockResolvedValue({ ...conv });
      txMessages.save.mockImplementation(async (m: object) => ({
        id: 'm1',
        ...m,
      }));

      const res = await service.recordChannelMessageOnce(
        TENANT,
        'thread-1',
        'CUSTOMER',
        'hello',
        undefined,
        origin,
      );

      expect(res.created).toBe(true);
      expect(res.message).toMatchObject({ id: 'm1', wa_message_id: 'wamid.1' });
      expect(txMessages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sender_type: 'CUSTOMER',
          sender_customer: { id: CUSTOMER },
          content: 'hello',
          message_type: 'text',
          wa_message_id: 'wamid.1',
        }),
      );
      expect(statusAppend).toHaveBeenCalledWith(TENANT, 'm1', 'SENT', manager);
      expect(txConversations.save).toHaveBeenCalledWith(
        expect.objectContaining({ last_message_at: expect.any(Date) }),
      );
    });

    it('writes nothing when this tenant already holds a message with that wamid', async () => {
      txConversations.findOne.mockResolvedValue({ ...conv });
      txMessages.findOne.mockResolvedValue({ id: 'existing' });

      const res = await service.recordChannelMessageOnce(
        TENANT,
        'thread-1',
        'CUSTOMER',
        'hello',
        undefined,
        origin,
      );

      expect(res).toEqual({ message: { id: 'existing' }, created: false });
      expect(txMessages.findOne).toHaveBeenCalledWith({
        where: { tenant: { id: TENANT }, wa_message_id: 'wamid.1' },
      });
      expect(txMessages.save).not.toHaveBeenCalled();
      expect(statusAppend).not.toHaveBeenCalled();
      expect(txConversations.save).not.toHaveBeenCalled();
    });

    it('does not look anything up for a message with no wamid', async () => {
      txConversations.findOne.mockResolvedValue({ ...conv });
      txMessages.save.mockImplementation(async (m: object) => ({
        id: 'm2',
        ...m,
      }));

      const res = await service.recordChannelMessageOnce(
        TENANT,
        'thread-1',
        'BOT',
        'reply',
      );

      expect(res.created).toBe(true);
      expect(txMessages.findOne).not.toHaveBeenCalled();
    });

    it("is a no-op for a conversation that is not this tenant's", async () => {
      txConversations.findOne.mockResolvedValue(null);

      const res = await service.recordChannelMessageOnce(
        TENANT,
        'someone-elses',
        'CUSTOMER',
        'hello',
        undefined,
        origin,
      );

      expect(res).toEqual({ message: null, created: false });
      expect(txConversations.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'someone-elses', tenant: { id: TENANT } },
        }),
      );
      expect(txMessages.save).not.toHaveBeenCalled();
    });

    it('resolves to the winner when a concurrent writer takes the unique index first', async () => {
      txConversations.findOne.mockResolvedValue({ ...conv });
      txMessages.save.mockRejectedValue(
        Object.assign(new Error('duplicate'), { code: '23505' }),
      );
      messages.findOne.mockResolvedValue({ id: 'winner' });

      const res = await service.recordChannelMessageOnce(
        TENANT,
        'thread-1',
        'CUSTOMER',
        'hello',
        undefined,
        origin,
      );

      expect(res).toEqual({ message: { id: 'winner' }, created: false });
    });

    it("lets a unique violation propagate inside a caller's own transaction", async () => {
      txConversations.findOne.mockResolvedValue({ ...conv });
      txMessages.save.mockRejectedValue(
        Object.assign(new Error('duplicate'), { code: '23505' }),
      );

      await expect(
        service.recordChannelMessageOnce(
          TENANT,
          'thread-1',
          'CUSTOMER',
          'hello',
          manager as never,
          origin,
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('does not swallow an unrelated database error', async () => {
      txConversations.findOne.mockResolvedValue({ ...conv });
      txMessages.save.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.recordChannelMessageOnce(
          TENANT,
          'thread-1',
          'CUSTOMER',
          'hello',
          undefined,
          origin,
        ),
      ).rejects.toThrow('connection lost');
    });

    it('recordChannelMessage keeps its old contract: the Message, or null', async () => {
      txConversations.findOne.mockResolvedValue({ ...conv });
      txMessages.findOne.mockResolvedValue({ id: 'existing' });

      await expect(
        service.recordChannelMessage(
          TENANT,
          'thread-1',
          'CUSTOMER',
          'hello',
          undefined,
          origin,
        ),
      ).resolves.toEqual({ id: 'existing' });

      txConversations.findOne.mockResolvedValue(null);
      await expect(
        service.recordChannelMessage(TENANT, 'nope', 'BOT', 'x'),
      ).resolves.toBeNull();
    });
  });

  describe('findOrCreateForWhatsapp — one thread per (tenant, customer, number)', () => {
    it('reuses the thread of that customer on that WhatsApp number', async () => {
      conversations.findOne.mockResolvedValue({ id: 'thread-1' });

      const thread = await service.findOrCreateForWhatsapp(
        TENANT,
        CUSTOMER,
        ACCOUNT,
      );

      expect(thread).toEqual({ id: 'thread-1' });
      expect(conversations.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenant: { id: TENANT },
            customer: { id: CUSTOMER },
            whatsapp_account: { id: ACCOUNT },
          },
        }),
      );
      expect(txConversations.save).not.toHaveBeenCalled();
    });

    it('creates a whatsapp thread under an advisory lock keyed to that triple', async () => {
      conversations.findOne.mockResolvedValue(null);
      txConversations.findOne.mockResolvedValue(null);

      await service.findOrCreateForWhatsapp(TENANT, CUSTOMER, ACCOUNT);

      expect(manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`wa-thread:${TENANT}:${CUSTOMER}:${ACCOUNT}`],
      );
      expect(txConversations.create).toHaveBeenCalledWith({
        tenant: { id: TENANT },
        customer: { id: CUSTOMER },
        whatsapp_account: { id: ACCOUNT },
        type: 'whatsapp',
      });
      // The lock is taken BEFORE the re-check that decides whether to create.
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        txConversations.findOne.mock.invocationCallOrder[0],
      );
    });

    it('opens no second thread when a concurrent worker created it while waiting for the lock', async () => {
      conversations.findOne.mockResolvedValue(null);
      txConversations.findOne.mockResolvedValue({ id: 'winner-thread' });

      const thread = await service.findOrCreateForWhatsapp(
        TENANT,
        CUSTOMER,
        ACCOUNT,
      );

      expect(thread).toEqual({ id: 'winner-thread' });
      expect(txConversations.save).not.toHaveBeenCalled();
    });
  });

  describe('resolveWhatsappThread — adopting the thread the AI session is bound to', () => {
    it('returns the bound thread, looked up tenant-scoped, and fills in what it lacks', async () => {
      const handoverThread = { id: 'handover-thread', type: 'support' };
      conversations.findOne.mockResolvedValue(handoverThread);

      const thread = await service.resolveWhatsappThread(
        TENANT,
        CUSTOMER,
        ACCOUNT,
        'handover-thread',
      );

      expect(conversations.findOne).toHaveBeenCalledWith({
        where: { id: 'handover-thread', tenant: { id: TENANT } },
        relations: { customer: true, whatsapp_account: true },
      });
      expect(conversations.update).toHaveBeenCalledWith(
        { id: 'handover-thread', tenant: { id: TENANT } },
        {
          customer: { id: CUSTOMER },
          whatsapp_account: { id: ACCOUNT },
        },
      );
      expect(thread).toMatchObject({ id: 'handover-thread' });
    });

    it('only ever fills — a thread that already has its own customer and number is left alone', async () => {
      conversations.findOne.mockResolvedValue({
        id: 'bound-thread',
        customer: { id: 'other-customer' },
        whatsapp_account: { id: 'other-account' },
      });

      const thread = await service.resolveWhatsappThread(
        TENANT,
        CUSTOMER,
        ACCOUNT,
        'bound-thread',
      );

      expect(conversations.update).not.toHaveBeenCalled();
      expect(thread.id).toBe('bound-thread');
    });

    it('fills just the missing half', async () => {
      conversations.findOne.mockResolvedValue({
        id: 'bound-thread',
        customer: { id: CUSTOMER },
      });

      await service.resolveWhatsappThread(
        TENANT,
        CUSTOMER,
        ACCOUNT,
        'bound-thread',
      );

      expect(conversations.update).toHaveBeenCalledWith(
        { id: 'bound-thread', tenant: { id: TENANT } },
        { whatsapp_account: { id: ACCOUNT } },
      );
    });

    it("ignores a bound thread id that is not this tenant's and falls back to the normal lookup", async () => {
      // First call: the tenant-scoped lookup of the bound id finds nothing.
      // Second call: findOrCreateForWhatsapp's own lookup finds the thread.
      conversations.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'normal-thread' });

      const thread = await service.resolveWhatsappThread(
        TENANT,
        CUSTOMER,
        ACCOUNT,
        'foreign-thread',
      );

      expect(thread).toEqual({ id: 'normal-thread' });
      expect(conversations.update).not.toHaveBeenCalled();
    });

    it('goes straight to find-or-create when the AI session has no thread yet', async () => {
      conversations.findOne.mockResolvedValue({ id: 'normal-thread' });

      const thread = await service.resolveWhatsappThread(
        TENANT,
        CUSTOMER,
        ACCOUNT,
      );

      expect(thread).toEqual({ id: 'normal-thread' });
      expect(conversations.findOne).toHaveBeenCalledTimes(1);
    });
  });
});
