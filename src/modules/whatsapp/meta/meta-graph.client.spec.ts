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
    graphUrl: (path: string) =>
      `https://graph.facebook.com/v21.0/${path.replace(/^\//, '')}`,
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
    fetchMock.mockResolvedValueOnce(
      ok({ id: '1234567890', status: 'PENDING', category: 'UTILITY' }),
    );

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

    expect(result).toEqual({
      id: '1234567890',
      status: 'PENDING',
      category: 'UTILITY',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://graph.facebook.com/v21.0/waba-1/message_templates',
    );
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
      fail(400, {
        error: {
          message: 'Template name is invalid',
          code: 100,
          error_subcode: 2388042,
        },
      }),
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
    fetchMock.mockResolvedValueOnce(
      fail(401, {
        error: { message: 'Invalid OAuth access token', code: 190 },
      }),
    );

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

/**
 * Regression cover for the defect that broke Embedded Signup in production:
 * `getWaba` named `owner_business_info` in its `fields` list. That field is
 * gated on `business_management`, a permission Meta's Embedded Signup NEVER
 * grants (it grants exactly `whatsapp_business_management` +
 * `whatsapp_business_messaging`), so Graph rejected the entire read and
 * onboarding aborted at step 3 for every clinic.
 *
 * Every other suite mocks `getWaba` wholesale, which is precisely why nothing
 * caught it — these assertions are on the real outbound request.
 */
describe('MetaGraphClient.getWaba', () => {
  let client: MetaGraphClient;
  let fetchMock: jest.Mock;

  const config = {
    graphVersion: 'v21.0',
    httpTimeoutMs: 10_000,
    graphUrl: (path: string) =>
      `https://graph.facebook.com/v21.0/${path.replace(/^\//, '')}`,
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

  it('does NOT request owner_business_info in the primary read', async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ id: 'waba-1', name: 'Clinic', currency: 'SAR', timezone_id: '1' }),
      )
      .mockResolvedValueOnce(ok({ owner_business_info: { id: 'biz-1' } }));

    await client.getWaba('waba-1', 'tok-1');

    const primaryUrl = fetchMock.mock.calls[0][0] as string;
    expect(primaryUrl).toContain('fields=id,name,currency,timezone_id');
    expect(primaryUrl).not.toContain('owner_business_info');
  });

  it('still resolves the owning business id when the token may read it', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ id: 'waba-1', name: 'Clinic' }))
      .mockResolvedValueOnce(ok({ owner_business_info: { id: 'biz-1' } }));

    await expect(client.getWaba('waba-1', 'tok-1')).resolves.toMatchObject({
      id: 'waba-1',
      ownerBusinessId: 'biz-1',
    });
  });

  it('SUCCEEDS with an Embedded Signup token that cannot read owner_business_info', async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ id: 'waba-1', name: 'Clinic', currency: 'SAR', timezone_id: '1' }),
      )
      .mockResolvedValueOnce(
        fail(403, {
          error: {
            message: '(#200) Requires business_management permission',
            code: 200,
            type: 'OAuthException',
          },
        }),
      );

    // The whole point: a clinic connects even though the optional read fails.
    await expect(client.getWaba('waba-1', 'tok-1')).resolves.toEqual({
      id: 'waba-1',
      name: 'Clinic',
      currency: 'SAR',
      timezoneId: '1',
      ownerBusinessId: undefined,
    });
  });

  it('still fails loudly when the WABA itself cannot be read', async () => {
    fetchMock.mockResolvedValueOnce(
      fail(400, { error: { message: 'Unsupported get request', code: 100 } }),
    );

    await expect(client.getWaba('waba-1', 'tok-1')).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });
});

describe('MetaGraphClient — Coexistence', () => {
  let client: MetaGraphClient;
  let fetchMock: jest.Mock;

  const config = {
    graphVersion: 'v21.0',
    httpTimeoutMs: 10_000,
    graphUrl: (path: string) =>
      `https://graph.facebook.com/v21.0/${path.replace(/^\//, '')}`,
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

  describe('getPhoneCoexistenceStatus', () => {
    it('reads is_on_biz_app/platform_type from the phone number', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({ is_on_biz_app: true, platform_type: 'CLOUD_API' }),
      );

      const result = await client.getPhoneCoexistenceStatus('pid-1', 'tok-1');

      expect(result).toEqual({ isOnBizApp: true, platformType: 'CLOUD_API' });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toBe(
        'https://graph.facebook.com/v21.0/pid-1?fields=is_on_biz_app,platform_type',
      );
    });

    it('returns undefined fields rather than throwing when Meta omits them', async () => {
      fetchMock.mockResolvedValueOnce(ok({}));

      await expect(
        client.getPhoneCoexistenceStatus('pid-1', 'tok-1'),
      ).resolves.toEqual({
        isOnBizApp: undefined,
        platformType: undefined,
      });
    });

    it('propagates a Graph API failure as an AppError (caller decides how to handle it)', async () => {
      fetchMock.mockResolvedValueOnce(
        fail(400, { error: { message: 'Unsupported get request', code: 100 } }),
      );

      await expect(
        client.getPhoneCoexistenceStatus('pid-1', 'tok-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('triggerSmbAppDataSync', () => {
    it('POSTs to /{phone_number_id}/smb_app_data with the requested sync_type', async () => {
      fetchMock.mockResolvedValueOnce(ok({ success: true }));

      await client.triggerSmbAppDataSync(
        'pid-1',
        'tok-1',
        'smb_app_state_sync',
      );

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v21.0/pid-1/smb_app_data');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer tok-1');
      expect(JSON.parse(init.body)).toEqual({
        messaging_product: 'whatsapp',
        sync_type: 'smb_app_state_sync',
      });
    });

    it('sends history as its own call with sync_type: history', async () => {
      fetchMock.mockResolvedValueOnce(ok({ success: true }));

      await client.triggerSmbAppDataSync('pid-1', 'tok-1', 'history');

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        messaging_product: 'whatsapp',
        sync_type: 'history',
      });
    });

    it('throws an AppError on a Graph rejection, WITHOUT the token anywhere in it', async () => {
      fetchMock.mockResolvedValueOnce(
        fail(400, { error: { message: 'Invalid parameter', code: 100 } }),
      );

      const err = await client
        .triggerSmbAppDataSync('pid-1', 'super-secret-token', 'history')
        .catch((e) => e);

      expect(err).toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(JSON.stringify(err)).not.toContain('super-secret-token');
    });
  });
});
