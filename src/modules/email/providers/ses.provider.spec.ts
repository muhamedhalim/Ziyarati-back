import { Logger } from '@nestjs/common';

const sendMock = jest.fn();
jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
  SendEmailCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import { SESv2Client } from '@aws-sdk/client-sesv2';
import {
  SesProvider,
  classifyTransient,
  encodeFromHeader,
} from './ses.provider';

const config = (env: Record<string, unknown>) =>
  ({ get: jest.fn((k: string) => env[k]) }) as never;

const baseEnv = {
  AWS_REGION: 'me-central-1',
  SES_CONFIGURATION_SET: 'zt-production',
  EMAIL_FROM: 'no-reply@ziyaratech.com',
  EMAIL_FROM_NAME: 'ZiyaraTech',
};

const message = { to: 'x@y.co', subject: 's', html: '<p>h</p>' };
const sentInput = () => sendMock.mock.calls[0][0].input;

const awsError = (name: string, status?: number, extra: object = {}) =>
  Object.assign(new Error(`${name} happened`), {
    name,
    $metadata: status ? { httpStatusCode: status } : {},
    ...extra,
  });

describe('SesProvider', () => {
  beforeEach(() => {
    sendMock.mockReset();
    (SESv2Client as unknown as jest.Mock).mockClear();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is configured by region alone — credentials come from the task role', () => {
    expect(new SesProvider(config(baseEnv)).isConfigured()).toBe(true);
    expect(new SesProvider(config({ ...baseEnv, AWS_REGION: undefined })).isConfigured()).toBe(false);
    expect(
      new SesProvider(config({ ...baseEnv, AWS_REGION: undefined, SES_REGION: 'eu-west-1' })).isConfigured(),
    ).toBe(true);
  });

  it('makes a single SDK attempt with a bounded timeout (BullMQ owns retries)', async () => {
    sendMock.mockResolvedValueOnce({ MessageId: 'm-1' });
    await new SesProvider(config({ ...baseEnv, SES_HTTP_TIMEOUT_MS: 8000 })).send(message);
    expect(SESv2Client).toHaveBeenCalledWith({
      region: 'me-central-1',
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 8000 },
    });
    expect(SESv2Client).not.toHaveBeenCalledWith(
      expect.objectContaining({ credentials: expect.anything() }),
    );
  });

  it('returns the SES MessageId (stored as provider_ref for bounce correlation)', async () => {
    sendMock.mockResolvedValueOnce({ MessageId: '0100018f-abc' });
    const res = await new SesProvider(config(baseEnv)).send(message);
    expect(res).toEqual({ success: true, providerMessageId: '0100018f-abc' });
  });

  it('maps the message: default sender, configuration set, UTF-8 bodies, recipients', async () => {
    sendMock.mockResolvedValueOnce({ MessageId: 'm' });
    await new SesProvider(config(baseEnv)).send({
      ...message,
      to: ['a@b.co', 'c@d.co'],
      text: 'plain',
      cc: ['cc@b.co'],
      replyTo: 'support@ziyaratech.com',
    });
    const input = sentInput();
    expect(input.FromEmailAddress).toBe('ZiyaraTech <no-reply@ziyaratech.com>');
    expect(input.ConfigurationSetName).toBe('zt-production');
    expect(input.Destination).toEqual({
      ToAddresses: ['a@b.co', 'c@d.co'],
      CcAddresses: ['cc@b.co'],
      BccAddresses: undefined,
    });
    expect(input.ReplyToAddresses).toEqual(['support@ziyaratech.com']);
    expect(input.Content.Simple.Subject).toEqual({ Data: 's', Charset: 'UTF-8' });
    expect(input.Content.Simple.Body.Html).toEqual({ Data: '<p>h</p>', Charset: 'UTF-8' });
    expect(input.Content.Simple.Body.Text).toEqual({ Data: 'plain', Charset: 'UTF-8' });
  });

  it('passes custom headers (List-Unsubscribe) and sanitizes tags to SES charset', async () => {
    sendMock.mockResolvedValueOnce({ MessageId: 'm' });
    await new SesProvider(config(baseEnv)).send({
      ...message,
      headers: { 'List-Unsubscribe': '<https://x/u>' },
      tags: [
        { name: 'campaign', value: 'spring sale!' },
        { name: '', value: 'dropped' },
      ],
    });
    const input = sentInput();
    expect(input.Content.Simple.Headers).toEqual([
      { Name: 'List-Unsubscribe', Value: '<https://x/u>' },
    ]);
    expect(input.EmailTags).toEqual([{ Name: 'campaign', Value: 'spring_sale_' }]);
  });

  it('RFC 2047-encodes a non-ASCII (Arabic) display name', async () => {
    sendMock.mockResolvedValueOnce({ MessageId: 'm' });
    await new SesProvider(config({ ...baseEnv, EMAIL_FROM_NAME: 'زيارتك' })).send(message);
    const from = sentInput().FromEmailAddress as string;
    expect(from).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <no-reply@ziyaratech\.com>$/);
    const b64 = /\?B\?(.+)\?=/.exec(from)![1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('زيارتك');
  });

  it.each([
    ['TooManyRequestsException', 429],
    ['LimitExceededException', 400],
    ['InternalServiceErrorException', 500],
    ['TimeoutError', undefined],
  ])('%s is TRANSIENT (BullMQ retries)', async (name, status) => {
    sendMock.mockRejectedValueOnce(awsError(name, status));
    const res = await new SesProvider(config(baseEnv)).send(message);
    expect(res).toMatchObject({ success: false, transient: true });
    expect(res.error).toContain(name);
  });

  it.each([
    ['BadRequestException', 400],
    ['MessageRejected', 400],
    ['MailFromDomainNotVerifiedException', 400],
    ['AccountSuspendedException', 400],
    ['SendingPausedException', 400],
    ['NotFoundException', 404],
    ['AccessDeniedException', 403],
  ])('%s is PERMANENT (no retry, email_logs FAILED)', async (name, status) => {
    sendMock.mockRejectedValueOnce(awsError(name, status));
    const res = await new SesProvider(config(baseEnv)).send(message);
    expect(res).toMatchObject({ success: false, transient: false });
  });

  it('does not log the provider message (it can echo recipient addresses)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    sendMock.mockRejectedValueOnce(
      awsError('MessageRejected', 400, { message: 'Email address is not verified: patient@example.com' }),
    );
    await new SesProvider(config(baseEnv)).send(message);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('patient@example.com');
  });

  it('fails permanently without a region, without calling SES', async () => {
    const res = await new SesProvider(config({ ...baseEnv, AWS_REGION: undefined })).send(message);
    expect(res).toMatchObject({ success: false, transient: false });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('classifyTransient', () => {
  it('permanent names win over a 5xx status', () => {
    expect(classifyTransient('SendingPausedException', 503, undefined)).toBe(false);
  });
  it('an unknown 4xx is permanent, an unknown 5xx transient, no response transient', () => {
    expect(classifyTransient('Weird', 422, undefined)).toBe(false);
    expect(classifyTransient('Weird', 502, undefined)).toBe(true);
    expect(classifyTransient('Weird', undefined, undefined)).toBe(true);
  });
  it('honours the SDK $retryable marker', () => {
    expect(classifyTransient('Weird', 400, { throttling: true })).toBe(true);
  });
});

describe('encodeFromHeader', () => {
  it('leaves ASCII senders untouched', () => {
    expect(encodeFromHeader('ZiyaraTech <a@b.co>')).toBe('ZiyaraTech <a@b.co>');
    expect(encodeFromHeader('a@b.co')).toBe('a@b.co');
  });
  it('strips surrounding quotes before encoding', () => {
    const out = encodeFromHeader('"عيادة" <a@b.co>');
    const b64 = /\?B\?(.+)\?=/.exec(out)![1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('عيادة');
  });
});
