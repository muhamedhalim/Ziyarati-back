import { HandoverChatService } from './handover-chat.service';
import { AgentWhatsappDispatcher } from './agent-whatsapp-dispatcher.service';
import { HandoverRequestService } from '../ai/handover-request.service';
import { WhatsappMessagingService } from '../whatsapp/whatsapp-messaging.service';
import { WhatsappMessageRouter } from '../whatsapp/routing/whatsapp-message.router';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import { ConversationAiTakeoverService } from '../conversations/conversation-ai-takeover.service';
import { MessageStatusService } from '../conversations/message-status.service';

const TENANT = 't1';

describe('HandoverChatService.sendAgentReply', () => {
  let service: HandoverChatService;
  let handovers: { sendAgentReply: jest.Mock };
  let messaging: { sendSession: jest.Mock };
  let router: { resolveForSend: jest.Mock };
  let conversationExecution: { recordProviderMessageId: jest.Mock };
  let messageStatus: { markFailed: jest.Mock };
  let takeover: { stampStaffReply: jest.Mock };
  let calls: string[];

  const CONVERSATION = {
    id: 'conv-1',
    customer: { phone: '+966500000000', whatsapp_id: null },
    whatsapp_account: { id: 'acc-1' },
  };

  beforeEach(() => {
    calls = [];
    handovers = {
      sendAgentReply: jest.fn().mockResolvedValue({
        message: { id: 'msg-1' },
        conversation: CONVERSATION,
      }),
    };
    router = {
      resolveForSend: jest.fn().mockResolvedValue({
        id: 'acc-1',
        phoneNumberId: 'pid-1',
        mode: 'LIVE',
      }),
    };
    conversationExecution = {
      recordProviderMessageId: jest.fn().mockResolvedValue(undefined),
    };
    messageStatus = { markFailed: jest.fn().mockResolvedValue(undefined) };
    takeover = {
      stampStaffReply: jest.fn().mockImplementation(async () => {
        calls.push('stamp');
        return new Date();
      }),
    };
    messaging = {
      sendSession: jest.fn().mockImplementation(async () => {
        calls.push('send');
        return { success: true, providerMessageId: 'wamid.agent-1' };
      }),
    };
    const dispatcher = new AgentWhatsappDispatcher(
      messaging as unknown as WhatsappMessagingService,
      router as unknown as WhatsappMessageRouter,
      conversationExecution as unknown as ConversationExecutionService,
      messageStatus as unknown as MessageStatusService,
    );
    service = new HandoverChatService(
      handovers as unknown as HandoverRequestService,
      dispatcher,
      takeover as unknown as ConversationAiTakeoverService,
    );
  });

  describe('FND-023 — provider message id', () => {
    it('records the provider message id onto the timeline message after a successful send', async () => {
      await service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hello there');

      expect(
        conversationExecution.recordProviderMessageId,
      ).toHaveBeenCalledWith(TENANT, 'msg-1', 'wamid.agent-1');
    });

    it('does not attempt to record a provider id when the send fails', async () => {
      messaging.sendSession.mockResolvedValueOnce({
        success: false,
        error: 'boom',
      });

      await service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hello there');

      expect(
        conversationExecution.recordProviderMessageId,
      ).not.toHaveBeenCalled();
    });

    it('does not attempt to record a provider id when nothing was dispatched (no WhatsApp account/number)', async () => {
      handovers.sendAgentReply.mockResolvedValueOnce({
        message: { id: 'msg-2' },
        conversation: { id: 'conv-2', customer: null, whatsapp_account: null },
      });

      await service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hello there');

      expect(messaging.sendSession).not.toHaveBeenCalled();
      expect(
        conversationExecution.recordProviderMessageId,
      ).not.toHaveBeenCalled();
    });
  });

  describe('delivery outcome', () => {
    it('reports it was delivered', async () => {
      await expect(
        service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hi'),
      ).resolves.toMatchObject({
        dispatchedToWhatsapp: true,
        conversationId: 'conv-1',
      });
    });

    it('marks the saved reply FAILED when WhatsApp refuses it — the inbox must not show it as sent', async () => {
      messaging.sendSession.mockResolvedValueOnce({
        success: false,
        error: 'boom',
      });

      const result = await service.sendAgentReply(
        TENANT,
        'user-1',
        'aiconv-1',
        'hi',
      );

      expect(result.dispatchedToWhatsapp).toBe(false);
      expect(messageStatus.markFailed).toHaveBeenCalledWith(TENANT, 'msg-1');
    });

    it('marks it FAILED, and still returns the saved message, when the send throws', async () => {
      router.resolveForSend.mockRejectedValueOnce(
        new Error('account disconnected'),
      );

      const result = await service.sendAgentReply(
        TENANT,
        'user-1',
        'aiconv-1',
        'hi',
      );

      expect(result.dispatchedToWhatsapp).toBe(false);
      expect(result.message).toEqual({ id: 'msg-1' });
      expect(messageStatus.markFailed).toHaveBeenCalledWith(TENANT, 'msg-1');
    });

    it('marks nothing FAILED when there was nothing to send (not a WhatsApp conversation)', async () => {
      handovers.sendAgentReply.mockResolvedValueOnce({
        message: { id: 'msg-2' },
        conversation: { id: 'conv-2', customer: null, whatsapp_account: null },
      });

      await service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hi');

      expect(messageStatus.markFailed).not.toHaveBeenCalled();
    });

    it('a failure while marking does not lose the reply or throw', async () => {
      messaging.sendSession.mockResolvedValueOnce({
        success: false,
        error: 'boom',
      });
      messageStatus.markFailed.mockRejectedValueOnce(new Error('db'));

      await expect(
        service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hi'),
      ).resolves.toMatchObject({ dispatchedToWhatsapp: false });
    });
  });

  describe('automatic human takeover', () => {
    it('stamps the takeover window on the conversation the agent replied on', async () => {
      await service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hi');

      expect(takeover.stampStaffReply).toHaveBeenCalledWith(TENANT, 'conv-1');
    });

    it('stamps BEFORE delivering, so an AI turn already running sees it at its pre-send check', async () => {
      await service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hi');

      expect(calls).toEqual(['stamp', 'send']);
    });

    it('stamps even when the reply could not be delivered — the person is engaged', async () => {
      messaging.sendSession.mockResolvedValueOnce({
        success: false,
        error: 'boom',
      });

      await service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hi');

      expect(takeover.stampStaffReply).toHaveBeenCalledTimes(1);
    });

    it('does not stamp when the reply was refused (e.g. assigned to another agent)', async () => {
      handovers.sendAgentReply.mockRejectedValueOnce(new Error('CONFLICT'));

      await expect(
        service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hi'),
      ).rejects.toThrow('CONFLICT');

      expect(takeover.stampStaffReply).not.toHaveBeenCalled();
      expect(messaging.sendSession).not.toHaveBeenCalled();
    });
  });
});
