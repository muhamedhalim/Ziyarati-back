import { ConfigService } from '@nestjs/config';

import { EmailCampaignDeliveryProvider } from './email-campaign-delivery.provider';
import { CampaignDeliveryPayload } from './campaign-delivery.provider.interface';
import { CAMPAIGN_CHANNEL } from '../campaign.constants';
import { EmailProviderFactory } from '../../email/providers/email-provider.factory';

function payload(
  overrides: Partial<CampaignDeliveryPayload> = {},
): CampaignDeliveryPayload {
  return {
    tenantId: 't1',
    campaignId: 'camp-1',
    channel: CAMPAIGN_CHANNEL.EMAIL,
    recipientId: 'rec-1',
    customerId: 'cust-1',
    email: 'patient@example.com',
    emailSubject: '20% off this month',
    emailBody: 'Book now',
    ...overrides,
  };
}

function makeConfig(vars: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => vars[key] } as unknown as ConfigService;
}

describe('EmailCampaignDeliveryProvider', () => {
  let provider: EmailCampaignDeliveryProvider;
  let send: jest.Mock;
  let resolve: jest.Mock;

  beforeEach(() => {
    send = jest.fn();
    resolve = jest
      .fn()
      .mockReturnValue({ name: 'resend', send, isConfigured: () => true });
    provider = new EmailCampaignDeliveryProvider(
      { resolve } as unknown as EmailProviderFactory,
      makeConfig({ EMAIL_ENABLED: 'true', APP_URL: 'https://app.test' }),
    );
  });

  describe('supports', () => {
    it('claims the EMAIL channel', () => {
      expect(provider.supports(CAMPAIGN_CHANNEL.EMAIL)).toBe(true);
    });

    it('leaves other channels to their own providers (or the noop)', () => {
      expect(provider.supports(CAMPAIGN_CHANNEL.WHATSAPP)).toBe(false);
      expect(provider.supports(undefined)).toBe(false);
    });
  });

  describe('send', () => {
    it('renders the campaign_marketing template and delegates to the shared email provider', async () => {
      send.mockResolvedValueOnce({
        success: true,
        providerMessageId: 'resend-msg-1',
      });

      const result = await provider.send(payload());

      expect(resolve).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'patient@example.com',
          subject: expect.stringContaining('20% off'),
          html: expect.stringContaining('Book now'),
        }),
      );
      expect(result).toEqual({ success: true, providerRef: 'resend-msg-1' });
    });

    it('sets reply-to from the payload (FR-E018 — clinic contact, not the platform sender)', async () => {
      send.mockResolvedValueOnce({ success: true, providerMessageId: 'm1' });
      await provider.send(payload({ replyTo: 'clinic@example.com' }));
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ replyTo: 'clinic@example.com' }),
      );
    });

    it('fails permanently when the recipient has no email address', async () => {
      const result = await provider.send(payload({ email: undefined }));
      expect(result).toMatchObject({ success: false, transient: false });
      expect(send).not.toHaveBeenCalled();
    });

    it('reports failure when the provider succeeds but returns no message id', async () => {
      send.mockResolvedValueOnce({
        success: true,
        providerMessageId: undefined,
      });
      await expect(provider.send(payload())).resolves.toMatchObject({
        success: false,
      });
    });

    it('surfaces the provider error and transient classification', async () => {
      send.mockResolvedValueOnce({
        success: false,
        error: 'HTTP 429',
        transient: true,
      });
      const result = await provider.send(payload());
      expect(result).toMatchObject({
        success: false,
        error: 'HTTP 429',
        transient: true,
      });
    });

    it('never throws — an unexpected exception is converted to a failure result', async () => {
      send.mockRejectedValueOnce(new Error('network down'));
      await expect(provider.send(payload())).resolves.toMatchObject({
        success: false,
      });
    });
  });
});
