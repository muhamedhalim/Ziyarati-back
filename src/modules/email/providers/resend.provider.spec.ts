import { Logger } from '@nestjs/common';

import { ResendProvider } from './resend.provider';

const config = (env: Record<string, unknown>) =>
  ({ get: jest.fn((k: string) => env[k]) }) as never;

const baseEnv = {
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'no-reply@ziyaratech.com',
  EMAIL_FROM_NAME: 'ZiyaraTech',
};

const message = { to: 'x@y.co', subject: 's', html: '<p>h</p>' };

describe('ResendProvider', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  const ok = (id = 'msg-1') => ({
    ok: true,
    status: 200,
    json: async () => ({ id }),
  });
  const fail = (status: number, body: string) => ({
    ok: false,
    status,
    statusText: 'x',
    text: async () => body,
    json: async () => ({}),
  });
  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body);
  const sentHeaders = () => fetchMock.mock.calls[0][1].headers;

  it('applies the configured sender when the caller leaves `from` unset (EmailChannelProvider does)', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await new ResendProvider(config(baseEnv)).send(message);
    expect(sentBody().from).toBe('ZiyaraTech <no-reply@ziyaratech.com>');
  });

  it('keeps an explicit `from`', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await new ResendProvider(config(baseEnv)).send({
      ...message,
      from: 'A <a@b.co>',
    });
    expect(sentBody().from).toBe('A <a@b.co>');
  });

  it('sends the idempotency key as the Idempotency-Key header', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await new ResendProvider(config(baseEnv)).send({
      ...message,
      idempotencyKey: 'invite:abc',
    });
    expect(sentHeaders()['Idempotency-Key']).toBe('invite:abc');
  });

  it('hashes a key longer than Resend’s 256-char limit instead of sending an invalid one', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await new ResendProvider(config(baseEnv)).send({
      ...message,
      idempotencyKey: 'k'.repeat(300),
    });
    expect(sentHeaders()['Idempotency-Key']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('omits the header when there is no key', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await new ResendProvider(config(baseEnv)).send(message);
    expect(sentHeaders()['Idempotency-Key']).toBeUndefined();
  });

  it('classifies 422 (the production invalid-`from` error) as PERMANENT', async () => {
    fetchMock.mockResolvedValueOnce(fail(422, '{"name":"validation_error"}'));
    const r = await new ResendProvider(config(baseEnv)).send(message);
    expect(r).toEqual(
      expect.objectContaining({ success: false, transient: false }),
    );
  });

  it.each([429, 500, 503])('classifies %i as TRANSIENT', async (status) => {
    fetchMock.mockResolvedValueOnce(fail(status, 'x'));
    const r = await new ResendProvider(config(baseEnv)).send(message);
    expect(r.transient).toBe(true);
  });

  it('409 concurrent_idempotent_requests is TRANSIENT; 409 invalid_idempotent_request is PERMANENT', async () => {
    fetchMock.mockResolvedValueOnce(
      fail(409, '{"name":"concurrent_idempotent_requests"}'),
    );
    fetchMock.mockResolvedValueOnce(
      fail(409, '{"name":"invalid_idempotent_request"}'),
    );
    const p = new ResendProvider(config(baseEnv));
    expect((await p.send(message)).transient).toBe(true);
    expect((await p.send(message)).transient).toBe(false);
  });

  it('aborts a hung request at RESEND_HTTP_TIMEOUT_MS and reports it as TRANSIENT', async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          ),
        ),
    );
    const r = await new ResendProvider(
      config({ ...baseEnv, RESEND_HTTP_TIMEOUT_MS: 1000 }),
    ).send(message);
    expect(r).toEqual({
      success: false,
      error: 'Resend API timeout after 1000ms',
      transient: true,
    });
  });

  it('is permanent and makes no request without an API key', async () => {
    const r = await new ResendProvider(
      config({ ...baseEnv, RESEND_API_KEY: '' }),
    ).send(message);
    expect(r.transient).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
