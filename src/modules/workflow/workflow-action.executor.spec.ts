import { WorkflowActionExecutor } from './workflow-action.executor';
import { EmailService } from '../email/email.service';
import { WhatsappMessagingService } from '../whatsapp/whatsapp-messaging.service';
import { WhatsappMessageRouter } from '../whatsapp/routing/whatsapp-message.router';
import { WhatsappExecutionService } from '../whatsapp/whatsapp-execution.service';
import { WhatsappTemplateService } from '../whatsapp/whatsapp-template.service';
import { WHATSAPP_DELIVERY_STATUS } from '../whatsapp/whatsapp.constants';
import { WorkflowRecipientResolver } from './workflow-recipient.resolver';
import {
  WORKFLOW_ACTION_TYPE,
  WORKFLOW_RECIPIENT_TYPE,
} from './workflow.constants';

describe('WorkflowActionExecutor', () => {
  let email: { send: jest.Mock };
  let whatsappMessaging: { sendSession: jest.Mock };
  let whatsappRouter: { resolveForSend: jest.Mock };
  let whatsappExecution: {
    claimBySourceRef: jest.Mock;
    finalizeBySourceRef: jest.Mock;
  };
  let whatsappTemplates: { getSendableTemplate: jest.Mock };
  let recipients: { resolve: jest.Mock };
  let executor: WorkflowActionExecutor;

  const RUN_ID = 'run-1';
  const ACTION_INDEX = 2;
  const EXPECTED_KEY = `workflow-action:${RUN_ID}:${ACTION_INDEX}`;
  const CUSTOMER_CONTACT = { phone: '9665', email: 'customer@example.com' };

  beforeEach(() => {
    email = { send: jest.fn().mockResolvedValue(undefined) };
    whatsappMessaging = {
      sendSession: jest
        .fn()
        .mockResolvedValue({ success: true, providerMessageId: 'wamid.1' }),
    };
    whatsappRouter = {
      resolveForSend: jest.fn().mockResolvedValue({
        id: 'acc-1',
        phoneNumberId: 'pid-1',
        mode: 'REAL',
      }),
    };
    whatsappExecution = {
      claimBySourceRef: jest
        .fn()
        .mockResolvedValue({ claimed: true, log: { id: 'log-1' } }),
      finalizeBySourceRef: jest.fn().mockResolvedValue(undefined),
    };
    whatsappTemplates = { getSendableTemplate: jest.fn() };
    recipients = { resolve: jest.fn().mockResolvedValue(CUSTOMER_CONTACT) };

    executor = new WorkflowActionExecutor(
      email as unknown as EmailService,
      whatsappMessaging as unknown as WhatsappMessagingService,
      whatsappRouter as unknown as WhatsappMessageRouter,
      whatsappExecution as unknown as WhatsappExecutionService,
      whatsappTemplates as unknown as WhatsappTemplateService,
      recipients as unknown as WorkflowRecipientResolver,
    );
  });

  const run = (
    overrides: {
      type?: string;
      recipientType?: string;
      config?: Record<string, unknown>;
      dryRun?: boolean;
    } = {},
  ) =>
    executor.execute(
      't1',
      RUN_ID,
      ACTION_INDEX,
      {
        type: overrides.type ?? WORKFLOW_ACTION_TYPE.EMAIL,
        recipientType:
          overrides.recipientType ?? WORKFLOW_RECIPIENT_TYPE.CUSTOMER,
        config: overrides.config ?? {},
      } as never,
      {},
      overrides.dryRun,
    );

  it('fails a FULLY missing recipientType before any recipient/type dispatch', async () => {
    const res = await run({ recipientType: '' as never });
    expect(res).toMatchObject({ status: 'FAILED' });
    expect(res.detail).toMatch(/recipientType/i);
    expect(recipients.resolve).not.toHaveBeenCalled();
  });

  it('rejects an unknown action type', async () => {
    const res = await run({ type: 'NOTIFICATION' });
    expect(res).toMatchObject({
      status: 'FAILED',
      detail: expect.stringContaining('Unknown action type'),
    });
  });

  describe('EMAIL', () => {
    it('resolves the recipient via WorkflowRecipientResolver, then sends with a business idempotencyKey', async () => {
      const res = await run({ config: { subject: 'Hi', body: 'there' } });
      expect(recipients.resolve).toHaveBeenCalledWith(
        't1',
        WORKFLOW_RECIPIENT_TYPE.CUSTOMER,
        {},
      );
      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: CUSTOMER_CONTACT.email,
          idempotencyKey: EXPECTED_KEY,
          template: 'generic',
        }),
      );
      expect(res).toMatchObject({ status: 'SUCCEEDED' });
    });

    it('fails cleanly when the recipient has no resolvable email (e.g. STAFF user with no email on file)', async () => {
      recipients.resolve.mockResolvedValue({ phone: '9665' });
      const res = await run({ recipientType: WORKFLOW_RECIPIENT_TYPE.STAFF });
      expect(res).toMatchObject({ status: 'FAILED' });
      expect(email.send).not.toHaveBeenCalled();
    });

    it('dry run resolves the recipient but never calls EmailService, and never echoes the address', async () => {
      const res = await run({ dryRun: true });
      expect(recipients.resolve).toHaveBeenCalled();
      expect(email.send).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: 'SUCCEEDED' });
      expect(res.detail).not.toContain(CUSTOMER_CONTACT.email);
    });
  });

  describe('WHATSAPP', () => {
    it('claims by sourceRef BEFORE sending, then finalizes the SAME claimed row on success', async () => {
      const res = await run({
        type: WORKFLOW_ACTION_TYPE.WHATSAPP,
        config: { text: 'hi' },
      });

      expect(whatsappExecution.claimBySourceRef).toHaveBeenCalledWith(
        't1',
        expect.any(String),
        EXPECTED_KEY,
      );
      expect(whatsappMessaging.sendSession).toHaveBeenCalledWith(
        expect.objectContaining({ to: CUSTOMER_CONTACT.phone, text: 'hi' }),
      );
      expect(whatsappExecution.finalizeBySourceRef).toHaveBeenCalledWith(
        'log-1',
        WHATSAPP_DELIVERY_STATUS.SENT,
        expect.objectContaining({ providerRef: 'wamid.1' }),
      );
      expect(res).toMatchObject({ status: 'SUCCEEDED' });
    });

    it('fails cleanly (no send attempted) when the recipient has no resolvable phone number', async () => {
      recipients.resolve.mockResolvedValue({ email: 'x@y.com' });
      const res = await run({
        type: WORKFLOW_ACTION_TYPE.WHATSAPP,
        config: { text: 'hi' },
      });
      expect(res).toMatchObject({ status: 'FAILED' });
      expect(whatsappExecution.claimBySourceRef).not.toHaveBeenCalled();
    });

    it('requires `text` or a templateId — fails cleanly with neither', async () => {
      const res = await run({
        type: WORKFLOW_ACTION_TYPE.WHATSAPP,
        config: {},
      });
      expect(res).toMatchObject({ status: 'FAILED' });
      expect(whatsappExecution.claimBySourceRef).not.toHaveBeenCalled();
    });

    it('renders an approved template by id (never asking the caller for its Meta id) and substitutes variables', async () => {
      whatsappTemplates.getSendableTemplate.mockResolvedValue({
        id: 'tpl-1',
        components: {
          components: [{ type: 'BODY', text: 'Hi {{1}}, see you on {{2}}.' }],
        },
      });
      const res = await run({
        type: WORKFLOW_ACTION_TYPE.WHATSAPP,
        config: {
          templateId: 'tpl-1',
          variables: { '1': 'Sara', '2': '2026-06-15' },
        },
      });
      expect(whatsappTemplates.getSendableTemplate).toHaveBeenCalledWith(
        't1',
        'tpl-1',
      );
      expect(whatsappMessaging.sendSession).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Hi Sara, see you on 2026-06-15.' }),
      );
      expect(res).toMatchObject({ status: 'SUCCEEDED' });
    });

    it('fails with the missing variable names when the template needs a variable not supplied', async () => {
      whatsappTemplates.getSendableTemplate.mockResolvedValue({
        id: 'tpl-1',
        components: { components: [{ type: 'BODY', text: 'Hi {{1}}.' }] },
      });
      const res = await run({
        type: WORKFLOW_ACTION_TYPE.WHATSAPP,
        config: { templateId: 'tpl-1' },
      });
      expect(res).toMatchObject({ status: 'FAILED' });
      expect(res.detail).toContain('1');
      expect(whatsappMessaging.sendSession).not.toHaveBeenCalled();
    });

    it('surfaces a not-approved/not-found template as a FAILED outcome (never throws out of execute())', async () => {
      whatsappTemplates.getSendableTemplate.mockRejectedValue(
        new Error('Only approved templates can be sent'),
      );
      const res = await run({
        type: WORKFLOW_ACTION_TYPE.WHATSAPP,
        config: { templateId: 'tpl-1' },
      });
      expect(res).toMatchObject({
        status: 'FAILED',
        detail: expect.stringContaining('approved'),
      });
    });

    it('never calls sendSession a second time when the claim is already taken — the double-send this closes', async () => {
      whatsappExecution.claimBySourceRef.mockResolvedValueOnce({
        claimed: false,
        log: { id: 'log-1' },
      });
      const res = await run({
        type: WORKFLOW_ACTION_TYPE.WHATSAPP,
        config: { text: 'hi' },
      });
      expect(whatsappMessaging.sendSession).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: 'SUCCEEDED' });
    });

    it('finalizes the claim as FAILED (not left dangling) when no usable WhatsApp account resolves', async () => {
      whatsappRouter.resolveForSend.mockRejectedValueOnce(
        new Error('no account'),
      );
      const res = await run({
        type: WORKFLOW_ACTION_TYPE.WHATSAPP,
        config: { text: 'hi' },
      });
      expect(whatsappExecution.finalizeBySourceRef).toHaveBeenCalledWith(
        'log-1',
        WHATSAPP_DELIVERY_STATUS.FAILED,
        expect.any(Object),
      );
      expect(res).toMatchObject({ status: 'FAILED' });
    });

    it('dry run resolves the recipient and renders the template, but never claims/sends, and never echoes the phone number', async () => {
      const res = await run({
        type: WORKFLOW_ACTION_TYPE.WHATSAPP,
        config: { text: 'hi' },
        dryRun: true,
      });
      expect(whatsappExecution.claimBySourceRef).not.toHaveBeenCalled();
      expect(whatsappMessaging.sendSession).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: 'SUCCEEDED' });
      expect(res.detail).not.toContain(CUSTOMER_CONTACT.phone);
    });
  });
});
