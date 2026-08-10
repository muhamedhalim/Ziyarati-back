import { MetaGraphClient } from './meta-graph.client';
import { MetaConfig } from './meta.config';
import { ErrorCode } from '../../../common/errors';

/**
 * HTTP is mocked at the `fetch` boundary — the client's whole job is turning
 * Graph's wire format into our shapes and its failures into AppErrors, so that
 * is exactly what is asserted here. No real Meta call is made.
 */
describe('MetaGraphClient.createTemplate', () => {
  let client: MetaGraphClient;
  let fetchMock: jest.Mock;

  const config = {
    graphVersion: 'v21.0',
    httpTimeoutMs: 10_000,
    graphUrl: (path: string) => `https://graph.facebook.com/v21.0/${path.replace(/^\//, '')}`,
  } as unknown as MetaConfig;

  const ok = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Map(),
  });

  const fail = (status: number, body: unknown) => ({
    ok: false,
    status,
    json: async () => body,
    headers: new Map(),
  });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new MetaGraphClient(config);
  });

  afterEach(() => jest.restoreAllMocks());

  it('POSTs to the WABA message_templates edge with a JSON body and bearer token', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: '1234567890', status: 'PENDING', category: 'UTILITY' }));

    const result = await client.createTemplate('waba-1', 'tok-1', {
      name: 'appointment_reminder_review_test',
      language: 'en_US',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: 'Hello {{1}}, this is a reminder for your appointment on {{2}}.',
          example: { body_text: [['Mohamed', '12 August 2026 at 5:00 PM']] },
        },
      ],
    });

    expect(result).toEqual({ id: '1234567890', status: 'PENDING', category: 'UTILITY' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/waba-1/message_templates');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toMatchObject({
      name: 'appointment_reminder_review_test',
      language: 'en_US',
      category: 'UTILITY',
    });
  });

  it('uses the configured Graph version rather than a hardcoded one', async () => {
    const v23 = {
      ...config,
      graphVersion: 'v23.0',
      graphUrl: (p: string) => `https://graph.facebook.com/v23.0/${p}`,
    } as unknown as MetaConfig;
    fetchMock.mockResolvedValueOnce(ok({ id: 'x' }));

    await new MetaGraphClient(v23).createTemplate('w', 't', {
      name: 'n',
      language: 'en',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'hi' }],
    });

    expect(fetchMock.mock.calls[0][0]).toContain('/v23.0/');
  });

  it("surfaces Meta's rejection message as a 422 AppError", async () => {
    fetchMock.mockResolvedValueOnce(
      fail(400, { error: { message: 'Template name is invalid', code: 100, error_subcode: 2388042 } }),
    );

    await expect(
      client.createTemplate('waba-1', 'tok-1', {
        name: 'Bad Name',
        language: 'en_US',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'hi' }],
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
      message: expect.stringContaining('Template name is invalid'),
    });
  });

  it('throws when Meta accepts but returns no template id', async () => {
    fetchMock.mockResolvedValueOnce(ok({ status: 'PENDING' }));

    await expect(
      client.createTemplate('waba-1', 'tok-1', {
        name: 'n',
        language: 'en',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
  });

  it('never puts the access token in the thrown error or the URL', async () => {
    fetchMock.mockResolvedValueOnce(fail(401, { error: { message: 'Invalid OAuth access token', code: 190 } }));

    const err = await client
      .createTemplate('waba-1', 'super-secret-token', {
        name: 'n',
        language: 'en',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'hi' }],
      })
      .catch((e) => e);

    expect(JSON.stringify(err)).not.toContain('super-secret-token');
    expect(fetchMock.mock.calls[0][0]).not.toContain('super-secret-token');
  });

  it('GET requests still carry no body or content-type (regression on the shared request path)', async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: [] }));
    await client.listTemplates('waba-1', 'tok-1');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
  });
});
