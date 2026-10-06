import { Logger } from '@nestjs/common';

import { StaffWhatsappReplyService } from './staff-whatsapp-reply.service';
import { ErrorCode } from '../../common/errors';

const TENANT = 't1';
const USER = 'u1';
const CONV = 'conv-1';

const waConversation = (over: Record<string, unknown> = {}) => ({
  id: CONV,
  owner_type: 'AI',
  assigned_to: null,
  customer: { id: 'cust-1', phone: '+966500000000', whatsapp_id: null },
  whatsapp_account: { id: 'acc-1' },
  ...over,
});

describe('StaffWhatsappReplyService', () => {
  let service: StaffWhatsappReplyService;
  let conversations: { findOne: jest.Mock };
  let timeline: { sendMessage: jest.Mock };
  let takeover: { stampStaffReply: jest.Mock };
  let aiExecution: { recordStaffMessage: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let order: string[];

  beforeEach(() => {
    order = [];
    conversations = { findOne: jest.fn().mockResolvedValue(waConversation()) };
    timeline = {
      sendMessage: jest.fn().mockImplementation(async () => {
        order.push('save');
        return { id: 'msg-1' };
      }),
    };
    takeover = {
      stampStaffReply: jest.fn().mockImplementation(async () => {
        order.push('stamp');
        return new Date('2030-01-01T10:30:00Z');
      }),
    };
    aiExecution = {
      recordStaffMessage: jest.fn().mockImplementation(async () => {
        order.push('history');
        return true;
      }),
    };
    dispatcher = {
      dispatch: jest.fn().mockImplementation(async () => {
        order.push('send');
        return true;
      }),
    };
    service = new StaffWhatsappReplyService(
      conversations as never,
      timeline as never,
      takeover as never,
      aiExecution as never,
      dispatcher as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('saves, stamps the takeover, records AI history and delivers — in that order, stamp BEFORE delivery', async () => {
    const result = await service.send(TENANT, USER, CONV, 'Hello');

    expect(order).toEqual(['save', 'stamp', 'history', 'send']);
    expect(result).toEqual({
      message: { id: 'msg-1' },
      conversationId: CONV,
      dispatchedToWhatsapp: true,
      aiPausedUntil: new Date('2030-01-01T10:30:00Z'),
    });
  });

  it('saves the reply as the AGENT, attributed to the authenticated user', async () => {
    await service.send(TENANT, USER, CONV, 'Hello');

    expect(timeline.sendMessage).toHaveBeenCalledWith(TENANT, USER, CONV, {
      content: 'Hello',
      senderType: 'AGENT',
    });
  });

  it('hands the dispatcher the saved message, so a refusal can mark THAT message FAILED', async () => {
    await service.send(TENANT, USER, CONV, 'Hello');

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ id: CONV }),
      'msg-1',
      'Hello',
    );
  });

  it('reports a failed delivery without losing the saved reply', async () => {
    dispatcher.dispatch.mockResolvedValue(false);

    await expect(
      service.send(TENANT, USER, CONV, 'Hello'),
    ).resolves.toMatchObject({
      dispatchedToWhatsapp: false,
      message: { id: 'msg-1' },
    });
  });

  it('reports no deadline when automatic takeover is off', async () => {
    takeover.stampStaffReply.mockResolvedValue(null);

    await expect(
      service.send(TENANT, USER, CONV, 'Hello'),
    ).resolves.toMatchObject({
      aiPausedUntil: null,
    });
  });

  describe('authorisation', () => {
    it('looks the conversation up inside the caller’s tenant, so another clinic’s id is a 404 and nothing is written', async () => {
      conversations.findOne.mockRejectedValue(
        Object.assign(new Error('Conversation not found'), {
          code: ErrorCode.NOT_FOUND,
        }),
      );

      await expect(
        service.send(TENANT, USER, 'foreign', 'Hello'),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });

      expect(conversations.findOne).toHaveBeenCalledWith(TENANT, 'foreign');
      expect(timeline.sendMessage).not.toHaveBeenCalled();
      expect(takeover.stampStaffReply).not.toHaveBeenCalled();
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('refuses a conversation handed to ANOTHER agent with 409 — nothing is saved, stamped or sent', async () => {
      conversations.findOne.mockResolvedValue(
        waConversation({
          owner_type: 'HUMAN',
          assigned_to: { id: 'someone-else' },
        }),
      );

      await expect(
        service.send(TENANT, USER, CONV, 'Hello'),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });

      expect(timeline.sendMessage).not.toHaveBeenCalled();
      expect(takeover.stampStaffReply).not.toHaveBeenCalled();
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('lets the agent the conversation is assigned to reply', async () => {
      conversations.findOne.mockResolvedValue(
        waConversation({ owner_type: 'HUMAN', assigned_to: { id: USER } }),
      );

      await expect(
        service.send(TENANT, USER, CONV, 'Hello'),
      ).resolves.toBeDefined();
    });

    it('does not treat an ordinary assignment on an AI-owned conversation as a handover lock', async () => {
      conversations.findOne.mockResolvedValue(
        waConversation({
          owner_type: 'AI',
          assigned_to: { id: 'someone-else' },
        }),
      );

      await expect(
        service.send(TENANT, USER, CONV, 'Hello'),
      ).resolves.toBeDefined();
    });
  });

  describe('not a WhatsApp conversation → 422, nothing is written', () => {
    it.each([
      ['no WhatsApp account', { whatsapp_account: null }],
      ['no customer', { customer: null }],
      [
        'a customer with no number',
        { customer: { id: 'c', phone: null, whatsapp_id: null } },
      ],
    ])('%s', async (_name, over) => {
      conversations.findOne.mockResolvedValue(waConversation(over));

      await expect(
        service.send(TENANT, USER, CONV, 'Hello'),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });

      expect(timeline.sendMessage).not.toHaveBeenCalled();
      expect(takeover.stampStaffReply).not.toHaveBeenCalled();
    });

    it('accepts a customer with only a WhatsApp id', async () => {
      conversations.findOne.mockResolvedValue(
        waConversation({
          customer: { id: 'c', phone: null, whatsapp_id: '966500000000' },
        }),
      );

      await expect(
        service.send(TENANT, USER, CONV, 'Hello'),
      ).resolves.toBeDefined();
    });
  });

  describe('best-effort steps never lose the reply', () => {
    it('a failure adding to the AI history is logged and the reply is still delivered', async () => {
      aiExecution.recordStaffMessage.mockRejectedValue(new Error('db'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        service.send(TENANT, USER, CONV, 'Hello'),
      ).resolves.toMatchObject({
        dispatchedToWhatsapp: true,
      });

      expect(dispatcher.dispatch).toHaveBeenCalled();
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain('Hello'); // never the message text
    });
  });
});
