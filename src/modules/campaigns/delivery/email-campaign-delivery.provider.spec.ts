import { ConfigService } from '@nestjs/config';

import { EmailCampaignDeliveryProvider } from './email-campaign-delivery.provider';
import { CampaignDeliveryPayload } from './campaign-delivery.provider.interface';
import { CAMPAIGN_CHANNEL } from '../campaign.constants';
import { EmailProviderFactory } from '../../email/providers/email-provider.factory';
import { UnsubscribeTokenService } from '../../email/unsubscribe-token.service';

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
  const unsubscribeTokens = new UnsubscribeTokenService(
    makeConfig({ EMAIL_UNSUBSCRIBE_SECRET: 'unit-test-unsubscribe-secret' }),
  );

  beforeEach(() => {
    send = jest.fn();
    resolve = jest
      .fn()
      .mockReturnValue({ name: 'resend', send, isConfigured: () => true });
    provider = new EmailCampaignDeliveryProvider(
      { resolve } as unknown as EmailProviderFactory,
      makeConfig({ EMAIL_ENABLED: 'true', APP_URL: 'https://app.test' }),
      unsubscribeTokens,
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

    it('embeds a verifiable unsubscribe link and the RFC 8058 one-click headers (CR-03)', async () => {
      send.mockResolvedValueOnce({ success: true, providerMessageId: 'm1' });
      await provider.send(payload({ tenantId: 'tenant-9', email: 'Patient@Example.com' }));

      const msg = send.mock.calls[0][0];
      const pageUrl = /https:\/\/app\.test\/unsubscribe\/([A-Za-z0-9_-]+)/.exec(msg.html);
      expect(pageUrl).not.toBeNull();
      expect(msg.text).toContain(`https://app.test/unsubscribe/${pageUrl![1]}`);
      // The token authorises exactly this (tenant, normalised email) pair.
      expect(unsubscribeTokens.verify(pageUrl![1])).toEqual({
        tenantId: 'tenant-9',
        email: 'patient@example.com',
      });
      expect(msg.headers).toEqual({
        'List-Unsubscribe': `<https://app.test/api/v1/public/unsubscribe/${pageUrl![1]}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
    });

    it('campaign metadata cannot override the unsubscribe link (CR-03)', async () => {
      send.mockResolvedValueOnce({ success: true, providerMessageId: 'm1' });
      await provider.send(payload({ metadata: { unsubscribeUrl: 'https://evil.test/x' } }));
      const msg = send.mock.calls[0][0];
      expect(msg.html).not.toContain('evil.test');
      expect(msg.html).toContain('https://app.test/unsubscribe/');
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
