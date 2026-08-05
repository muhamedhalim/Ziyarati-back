import { HandoverChatService } from './handover-chat.service';
import { HandoverRequestService } from '../ai/handover-request.service';
import { WhatsappMessagingService } from '../whatsapp/whatsapp-messaging.service';
import { WhatsappMessageRouter } from '../whatsapp/routing/whatsapp-message.router';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';

const TENANT = 't1';

describe('HandoverChatService.sendAgentReply — FND-023 provider message id', () => {
  let service: HandoverChatService;
  let handovers: { sendAgentReply: jest.Mock };
  let messaging: { sendSession: jest.Mock };
  let router: { resolveForSend: jest.Mock };
  let conversationExecution: { recordProviderMessageId: jest.Mock };

  const CONVERSATION = {
    id: 'conv-1',
    customer: { phone: '+966500000000', whatsapp_id: null },
    whatsapp_account: { id: 'acc-1' },
  };

  beforeEach(() => {
    handovers = {
      sendAgentReply: jest.fn().mockResolvedValue({
        message: { id: 'msg-1' },
        conversation: CONVERSATION,
      }),
    };
    router = {
      resolveForSend: jest.fn().mockResolvedValue({ id: 'acc-1', phoneNumberId: 'pid-1', mode: 'LIVE' }),
    };
    conversationExecution = { recordProviderMessageId: jest.fn().mockResolvedValue(undefined) };
    messaging = { sendSession: jest.fn() };
    service = new HandoverChatService(
      handovers as unknown as HandoverRequestService,
      messaging as unknown as WhatsappMessagingService,
      router as unknown as WhatsappMessageRouter,
      conversationExecution as unknown as ConversationExecutionService,
    );
  });

  it('records the provider message id onto the timeline message after a successful send', async () => {
    messaging.sendSession.mockResolvedValueOnce({ success: true, providerMessageId: 'wamid.agent-1' });

    await service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hello there');

    expect(conversationExecution.recordProviderMessageId).toHaveBeenCalledWith(
      TENANT,
      'msg-1',
      'wamid.agent-1',
    );
  });

  it('does not attempt to record a provider id when the send fails', async () => {
    messaging.sendSession.mockResolvedValueOnce({ success: false, error: 'boom' });

    await service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hello there');

    expect(conversationExecution.recordProviderMessageId).not.toHaveBeenCalled();
  });

  it('does not attempt to record a provider id when nothing was dispatched (no WhatsApp account/number)', async () => {
    handovers.sendAgentReply.mockResolvedValueOnce({
      message: { id: 'msg-2' },
      conversation: { id: 'conv-2', customer: null, whatsapp_account: null },
    });

    await service.sendAgentReply(TENANT, 'user-1', 'aiconv-1', 'hello there');

    expect(messaging.sendSession).not.toHaveBeenCalled();
    expect(conversationExecution.recordProviderMessageId).not.toHaveBeenCalled();
  });
});
