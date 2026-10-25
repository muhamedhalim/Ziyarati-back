import { WhatsappCampaignDeliveryProvider } from './whatsapp-campaign-delivery.provider';
import { CampaignDeliveryPayload } from './campaign-delivery.provider.interface';
import { CAMPAIGN_CHANNEL } from '../campaign.constants';
import { WhatsappExecutionService } from '../../whatsapp/whatsapp-execution.service';
import { WHATSAPP_DELIVERY_STATUS } from '../../whatsapp/whatsapp.constants';
import { AppError, ErrorCode } from '../../../common/errors';

function payload(overrides: Partial<CampaignDeliveryPayload> = {}): CampaignDeliveryPayload {
  return {
    tenantId: 't1',
    campaignId: 'camp-1',
    channel: CAMPAIGN_CHANNEL.WHATSAPP,
    recipientId: 'rec-1',
    customerId: 'cust-1',
    templateId: 'tpl-1',
    ...overrides,
  };
}

describe('WhatsappCampaignDeliveryProvider', () => {
  let provider: WhatsappCampaignDeliveryProvider;
  let execution: { sendTemplateMessage: jest.Mock };

  beforeEach(() => {
    execution = { sendTemplateMessage: jest.fn() };
    provider = new WhatsappCampaignDeliveryProvider(
      execution as unknown as WhatsappExecutionService,
    );
  });

  describe('supports', () => {
    it('claims the WHATSAPP channel', () => {
      expect(provider.supports(CAMPAIGN_CHANNEL.WHATSAPP)).toBe(true);
    });

    it('leaves other channels to their own providers (or the noop)', () => {
      expect(provider.supports(CAMPAIGN_CHANNEL.EMAIL)).toBe(false);
      expect(provider.supports(undefined)).toBe(false);
    });
  });

  describe('send', () => {
    it('delegates to the shared send seam rather than re-implementing it', async () => {
      execution.sendTemplateMessage.mockResolvedValueOnce({
        status: WHATSAPP_DELIVERY_STATUS.SENT,
        providerMessageId: 'wamid.ABC',
      });

      const result = await provider.send(payload({ metadata: { '1': 'Sara' } }));

      expect(execution.sendTemplateMessage).toHaveBeenCalledWith('t1', 'tpl-1', {
        customerId: 'cust-1',
        variables: { '1': 'Sara' },
      });
      expect(result).toEqual({ success: true, providerRef: 'wamid.ABC' });
    });

    it('returns the wamid as the providerRef (the dispatcher\'s idempotency key)', async () => {
      execution.sendTemplateMessage.mockResolvedValueOnce({
        status: WHATSAPP_DELIVERY_STATUS.SENT,
        providerMessageId: 'wamid.XYZ',
      });

      await expect(provider.send(payload())).resolves.toMatchObject({
        providerRef: 'wamid.XYZ',
      });
    });

    it('fails permanently when the campaign has no template', async () => {
      // WhatsApp business-initiated sends REQUIRE an approved template, so this
      // can never succeed on retry.
      const result = await provider.send(payload({ templateId: undefined }));

      expect(result).toMatchObject({ success: false, transient: false });
      expect(execution.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('surfaces the provider error text for heuristic classification', async () => {
      execution.sendTemplateMessage.mockResolvedValueOnce({
        status: WHATSAPP_DELIVERY_STATUS.FAILED,
        error: '429: rate limit exceeded',
      });

      const result = await provider.send(payload());

      // Left unclassified on purpose: CampaignDispatchService reads '429' as
      // transient. Hard-coding transient:false here would kill legitimate retries.
      expect(result.success).toBe(false);
      expect(result.error).toContain('429');
      expect(result.transient).toBeUndefined();
    });

    it('classifies a Meta error code: permanent codes are not retried, capacity codes are (L-05)', async () => {
      execution.sendTemplateMessage.mockResolvedValueOnce({
        status: WHATSAPP_DELIVERY_STATUS.FAILED,
        error: 'message undeliverable',
        errorCode: 131026,
      });
      await expect(provider.send(payload())).resolves.toMatchObject({
        success: false,
        transient: false,
      });

      execution.sendTemplateMessage.mockResolvedValueOnce({
        status: WHATSAPP_DELIVERY_STATUS.FAILED,
        error: 'throughput limit',
        errorCode: 130429,
      });
      await expect(provider.send(payload())).resolves.toMatchObject({
        success: false,
        transient: true,
      });
    });

    it('reports failure when the seam returns SENT but no message id', async () => {
      execution.sendTemplateMessage.mockResolvedValueOnce({
        status: WHATSAPP_DELIVERY_STATUS.SENT,
        providerMessageId: undefined,
      });

      // No wamid = nothing to write to the UNIQUE provider_ref guard, so this
      // must not be recorded as a successful send.
      await expect(provider.send(payload())).resolves.toMatchObject({ success: false });
    });
  });

  describe('never throws (dispatcher contract)', () => {
    it.each([
      ['no connected account', ErrorCode.NOT_FOUND],
      ['inactive account / unapproved template / quota exhausted', ErrorCode.UNPROCESSABLE_ENTITY],
      ['malformed recipient', ErrorCode.BAD_REQUEST],
      ['forbidden', ErrorCode.FORBIDDEN],
    ])('classifies %s as PERMANENT (no retry)', async (_label, code) => {
      execution.sendTemplateMessage.mockRejectedValueOnce(
        new AppError(code, { message: 'nope' }),
      );

      const result = await provider.send(payload());

      expect(result).toMatchObject({ success: false, transient: false });
    });

    it('leaves an infrastructure fault unclassified for the retry heuristic', async () => {
      execution.sendTemplateMessage.mockRejectedValueOnce(new Error('ECONNRESET'));

      const result = await provider.send(payload());

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNRESET');
      expect(result.transient).toBeUndefined();
    });

    it('does not leak an unexpected throw to the dispatcher', async () => {
      execution.sendTemplateMessage.mockRejectedValueOnce(new Error('boom'));
      await expect(provider.send(payload())).resolves.toBeDefined();
    });
  });
});
