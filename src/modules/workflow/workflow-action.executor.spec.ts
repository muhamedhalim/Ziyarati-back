import { WorkflowActionExecutor } from './workflow-action.executor';
import { EmailService } from '../email/email.service';
import { WhatsappMessagingService } from '../whatsapp/whatsapp-messaging.service';
import { WhatsappMessageRouter } from '../whatsapp/routing/whatsapp-message.router';
import { WhatsappExecutionService } from '../whatsapp/whatsapp-execution.service';
import { WHATSAPP_DELIVERY_STATUS } from '../whatsapp/whatsapp.constants';
import { NotificationSchedulerService } from '../notifications/notification-scheduler.service';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { WORKFLOW_ACTION_TYPE } from './workflow.constants';

describe('WorkflowActionExecutor — per-action-type idempotency (gap-closure pass, §0.11)', () => {
  let email: { send: jest.Mock };
  let whatsappMessaging: { sendSession: jest.Mock };
  let whatsappRouter: { resolveForSend: jest.Mock };
  let whatsappExecution: { claimBySourceRef: jest.Mock; finalizeBySourceRef: jest.Mock };
  let notifications: { schedule: jest.Mock };
  let orchestrator: { handle: jest.Mock };
  let executor: WorkflowActionExecutor;

  const RUN_ID = 'run-1';
  const ACTION_INDEX = 2;
  const EXPECTED_KEY = `workflow-action:${RUN_ID}:${ACTION_INDEX}`;

  beforeEach(() => {
    email = { send: jest.fn().mockResolvedValue(undefined) };
    whatsappMessaging = { sendSession: jest.fn().mockResolvedValue({ success: true, providerMessageId: 'wamid.1' }) };
    whatsappRouter = { resolveForSend: jest.fn().mockResolvedValue({ id: 'acc-1', phoneNumberId: 'pid-1', mode: 'REAL' }) };
    whatsappExecution = {
      claimBySourceRef: jest.fn().mockResolvedValue({ claimed: true, log: { id: 'log-1' } }),
      finalizeBySourceRef: jest.fn().mockResolvedValue(undefined),
    };
    notifications = { schedule: jest.fn().mockResolvedValue({ id: 'sched-1' }) };
    orchestrator = { handle: jest.fn().mockResolvedValue({ aiConversationId: 'conv-1' }) };

    executor = new WorkflowActionExecutor(
      email as unknown as EmailService,
      whatsappMessaging as unknown as WhatsappMessagingService,
      whatsappRouter as unknown as WhatsappMessageRouter,
      whatsappExecution as unknown as WhatsappExecutionService,
      notifications as unknown as NotificationSchedulerService,
      orchestrator as unknown as AiOrchestratorService,
    );
  });

  it('EMAIL: passes a business idempotencyKey (runId:actionIndex), not the content hash fallback', async () => {
    await executor.execute(
      't1',
      RUN_ID,
      ACTION_INDEX,
      { type: WORKFLOW_ACTION_TYPE.EMAIL, config: { to: 'a@b.com', template: 'generic' } } as never,
      {},
    );

    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: EXPECTED_KEY }));
  });

  it('AI: passes the same business idempotencyKey through to the orchestrator', async () => {
    await executor.execute(
      't1',
      RUN_ID,
      ACTION_INDEX,
      { type: WORKFLOW_ACTION_TYPE.AI, config: { prompt: 'hello' } } as never,
      {},
    );

    expect(orchestrator.handle).toHaveBeenCalledWith('t1', expect.objectContaining({ idempotencyKey: EXPECTED_KEY }));
  });

  describe('WHATSAPP', () => {
    it('claims by sourceRef BEFORE sending, then finalizes the SAME claimed row on success', async () => {
      const res = await executor.execute(
        't1',
        RUN_ID,
        ACTION_INDEX,
        { type: WORKFLOW_ACTION_TYPE.WHATSAPP, config: { to: '9665', text: 'hi' } } as never,
        {},
      );

      expect(whatsappExecution.claimBySourceRef).toHaveBeenCalledWith('t1', expect.any(String), EXPECTED_KEY);
      expect(whatsappMessaging.sendSession).toHaveBeenCalled();
      expect(whatsappExecution.finalizeBySourceRef).toHaveBeenCalledWith(
        'log-1',
        WHATSAPP_DELIVERY_STATUS.SENT,
        expect.objectContaining({ providerRef: 'wamid.1' }),
      );
      expect(res).toMatchObject({ status: 'SUCCEEDED' });
    });

    it('never calls sendSession a second time when the claim is already taken — the double-send this closes', async () => {
      whatsappExecution.claimBySourceRef.mockResolvedValueOnce({ claimed: false, log: { id: 'log-1' } });

      const res = await executor.execute(
        't1',
        RUN_ID,
        ACTION_INDEX,
        { type: WORKFLOW_ACTION_TYPE.WHATSAPP, config: { to: '9665', text: 'hi' } } as never,
        {},
      );

      expect(whatsappMessaging.sendSession).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: 'SUCCEEDED' });
    });

    it('finalizes the claim as FAILED (not left dangling) when no usable WhatsApp account resolves', async () => {
      whatsappRouter.resolveForSend.mockRejectedValueOnce(new Error('no account'));

      const res = await executor.execute(
        't1',
        RUN_ID,
        ACTION_INDEX,
        { type: WORKFLOW_ACTION_TYPE.WHATSAPP, config: { to: '9665', text: 'hi' } } as never,
        {},
      );

      expect(whatsappExecution.finalizeBySourceRef).toHaveBeenCalledWith('log-1', WHATSAPP_DELIVERY_STATUS.FAILED, expect.any(Object));
      expect(res).toMatchObject({ status: 'FAILED' });
    });
  });

  it('NOTIFICATION: passes the business idempotencyKey as sourceRef to schedule()', async () => {
    await executor.execute(
      't1',
      RUN_ID,
      ACTION_INDEX,
      { type: WORKFLOW_ACTION_TYPE.NOTIFICATION, config: { templateId: 'tpl-1' } } as never,
      {},
    );

    expect(notifications.schedule).toHaveBeenCalledWith('t1', expect.any(Object), EXPECTED_KEY);
  });

  it('WEBHOOK: sends a STABLE idempotency key (header + body), not a wall-clock value', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await executor.execute(
      't1',
      RUN_ID,
      ACTION_INDEX,
      { type: WORKFLOW_ACTION_TYPE.WEBHOOK, config: { url: 'https://example.com/hook' } } as never,
      {},
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Workflow-Idempotency-Key']).toBe(EXPECTED_KEY);
    expect(JSON.parse(init.body).idempotencyKey).toBe(EXPECTED_KEY);
  });
});
