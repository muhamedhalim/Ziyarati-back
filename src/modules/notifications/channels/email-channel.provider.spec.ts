const sesSendMock = jest.fn();
jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation(() => ({ send: sesSendMock })),
  SendEmailCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import { EmailChannelProvider } from './email-channel.provider';
import { NOTIFICATION_CHANNEL } from '../notification.constants';
import { EmailProviderFactory } from '../../email/providers/email-provider.factory';
import { SesProvider } from '../../email/providers/ses.provider';
import { NoopEmailProvider } from '../../email/providers/noop-email.provider';

describe('EmailChannelProvider', () => {
  const makeFactory = (overrides: Partial<EmailProviderFactory> = {}) =>
    ({
      isLiveDelivery: jest.fn(() => true),
      resolve: jest.fn(() => ({
        name: 'ses',
        isConfigured: () => true,
        send: jest.fn(async () => ({
          success: true,
          providerMessageId: 'msg-1',
        })),
      })),
      ...overrides,
    }) as unknown as EmailProviderFactory;

  it('supports only EMAIL', () => {
    const provider = new EmailChannelProvider(makeFactory());
    expect(provider.supports(NOTIFICATION_CHANNEL.EMAIL)).toBe(true);
    expect(provider.supports(NOTIFICATION_CHANNEL.WHATSAPP)).toBe(false);
    expect(provider.supports(undefined)).toBe(false);
  });

  it('a successful send returns the provider message id as providerRef', async () => {
    const provider = new EmailChannelProvider(makeFactory());
    const result = await provider.send({
      tenantId: 't1',
      channel: NOTIFICATION_CHANNEL.EMAIL,
      recipientEmail: 'patient@example.com',
      contentEn: 'Your appointment is confirmed',
      locale: 'en',
    });
    expect(result).toEqual({
      success: true,
      providerRef: 'msg-1',
      error: undefined,
      transient: undefined,
    });
  });

  it('FAILS CLOSED when email is not configured — never falls through to the noop success', async () => {
    const factory = makeFactory({ isLiveDelivery: jest.fn(() => false) });
    const provider = new EmailChannelProvider(factory);
    const result = await provider.send({
      tenantId: 't1',
      channel: NOTIFICATION_CHANNEL.EMAIL,
      recipientEmail: 'patient@example.com',
      contentEn: 'hello',
    });
    expect(result.success).toBe(false);
    expect(result.transient).toBe(false);
    expect(factory.resolve).not.toHaveBeenCalled();
  });

  it('classifies transient vs permanent per the underlying EmailSendResult', async () => {
    const factory = makeFactory({
      resolve: jest.fn(() => ({
        name: 'ses',
        isConfigured: () => true,
        send: jest.fn(async () => ({
          success: false,
          error: 'rate limited',
          transient: true,
        })),
      })),
    });
    const provider = new EmailChannelProvider(factory);
    const result = await provider.send({
      tenantId: 't1',
      channel: NOTIFICATION_CHANNEL.EMAIL,
      recipientEmail: 'patient@example.com',
      contentEn: 'hello',
    });
    expect(result).toEqual({
      success: false,
      providerRef: undefined,
      error: 'rate limited',
      transient: true,
    });
  });

  it('rejects with no recipient address before ever resolving a provider', async () => {
    const factory = makeFactory();
    const provider = new EmailChannelProvider(factory);
    const result = await provider.send({
      tenantId: 't1',
      channel: NOTIFICATION_CHANNEL.EMAIL,
      contentEn: 'hello',
    });
    expect(result.success).toBe(false);
    expect(factory.resolve).not.toHaveBeenCalled();
  });

  it('renders from the template content, honouring recipient locale', async () => {
    let sentMessage: any;
    const factory = makeFactory({
      resolve: jest.fn(() => ({
        name: 'ses',
        isConfigured: () => true,
        send: jest.fn(async (msg: any) => {
          sentMessage = msg;
          return { success: true, providerMessageId: 'm' };
        }),
      })),
    });
    const provider = new EmailChannelProvider(factory);
    await provider.send({
      tenantId: 't1',
      channel: NOTIFICATION_CHANNEL.EMAIL,
      recipientEmail: 'p@example.com',
      contentAr: 'مرحبا',
      contentEn: 'hello',
      locale: 'ar',
    });
    expect(sentMessage.text).toBe('مرحبا');
    expect(sentMessage.to).toBe('p@example.com');
  });
});

// Production defect found 2026-09-23: this channel never set `from`. The sender
// must come from the single shared resolver (resolveEmailConfig), applied by
// the real SesProvider.
describe('EmailChannelProvider → real factory → real SesProvider (sender)', () => {
  beforeEach(() => sesSendMock.mockReset());
  afterEach(() => jest.restoreAllMocks());

  it('the outgoing SES request carries the configured platform sender', async () => {
    const env: Record<string, string> = {
      NODE_ENV: 'production',
      AWS_REGION: 'eu-central-1',
      EMAIL_FROM: 'no-reply@ziyaratech.com',
      EMAIL_FROM_NAME: 'ZiyaraTech',
    };
    const config = { get: jest.fn((k: string) => env[k]) } as never;
    sesSendMock.mockResolvedValue({ MessageId: 'ses-1' });
    const factory = new EmailProviderFactory(
      config,
      new NoopEmailProvider(),
      new SesProvider(config),
    );

    const result = await new EmailChannelProvider(factory).send({
      tenantId: 't1',
      channel: NOTIFICATION_CHANNEL.EMAIL,
      recipientEmail: 'patient@example.com',
      contentEn: 'Your appointment is confirmed',
      locale: 'en',
    });

    expect(result.success).toBe(true);
    expect(sesSendMock.mock.calls[0][0].input.FromEmailAddress).toBe(
      'ZiyaraTech <no-reply@ziyaratech.com>',
    );
  });
});
