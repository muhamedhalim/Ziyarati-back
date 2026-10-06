import 'reflect-metadata';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { HandoverReplyController } from './handover-reply.controller';
import { HandoverRequestController } from '../ai/handover-request.controller';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';

describe('HandoverReplyController', () => {
  const message = { id: 'msg-1', content: 'hello patient' };
  const handoverChat = {
    sendAgentReply: jest.fn().mockResolvedValue({
      message,
      conversationId: 'conv-1',
      dispatchedToWhatsapp: true,
    }),
  };
  const ctx = { requireTenantId: jest.fn().mockReturnValue('t1') };
  const controller = new HandoverReplyController(
    handoverChat as never,
    ctx as never,
  );

  afterEach(() => jest.clearAllMocks());

  it('sends through HandoverChatService — the one path that also delivers over WhatsApp', async () => {
    const result = await controller.reply(
      'ai-1',
      { content: 'hello patient' },
      'u1',
    );

    expect(handoverChat.sendAgentReply).toHaveBeenCalledWith(
      't1',
      'u1',
      'ai-1',
      'hello patient',
    );
    // Response shape is unchanged for existing clients: the saved message.
    expect(result).toBe(message);
  });

  it('takes the tenant from the authenticated context, never from the request', async () => {
    await controller.reply('ai-1', { content: 'x' }, 'u1');

    expect(ctx.requireTenantId).toHaveBeenCalledTimes(1);
    expect(handoverChat.sendAgentReply.mock.calls[0][0]).toBe('t1');
  });

  it('keeps its URL and its permission', () => {
    expect(Reflect.getMetadata(PATH_METADATA, HandoverReplyController)).toBe(
      'ai/handovers',
    );
    const handler = HandoverReplyController.prototype.reply;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'conversations/:aiConversationId/reply',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      PERMISSION.AI_HANDOVER_MANAGE,
    ]);
  });

  it('is no longer served by the AI module controller (one route, one owner)', () => {
    expect(
      (
        HandoverRequestController.prototype as unknown as Record<
          string,
          unknown
        >
      ).reply,
    ).toBeUndefined();
  });
});
