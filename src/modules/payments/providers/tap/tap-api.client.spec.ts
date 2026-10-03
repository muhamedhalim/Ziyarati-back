import { TapApiClient } from './tap-api.client';
import { PaymentsConfig } from '../../payments.config';

const SECRET = 'sk_test_UnitTestKeyNotARealSecret0000';

const config = (over: Record<string, unknown> = {}) =>
  ({
    tapSecretKey: SECRET,
    tapApiBase: 'https://api.tap.company',
    tapRequestTimeoutMs: 50,
    ...over,
  }) as unknown as PaymentsConfig;

const res = (status: number, json: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => json,
});

describe('TapApiClient', () => {
  let fetchMock: jest.Mock;
  let original: typeof globalThis.fetch;

  const build = (cfg = config()) => {
    const client = new TapApiClient(cfg);
    // Skip the real backoff delay.
    jest.spyOn(client as any, 'sleep').mockResolvedValue(undefined);
    return client;
  };

  beforeEach(() => {
    original = (globalThis as any).fetch;
    fetchMock = jest.fn();
    (globalThis as any).fetch = fetchMock;
  });
  afterEach(() => {
    (globalThis as any).fetch = original;
    jest.restoreAllMocks();
  });

  it('sends Bearer auth + JSON to the configured base and parses a 2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, { id: 'chg_1', status: 'CAPTURED' }),
    );
    const out = await build().getCharge('chg_1');

    expect(out).toMatchObject({ ok: true, status: 200, transient: false });
    expect(out.json.id).toBe('chg_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.tap.company/v2/charges/chg_1');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeDefined();
  });

  it('url-encodes the id (path-injection safe)', async () => {
    fetchMock.mockResolvedValueOnce(
      res(404, { errors: [{ code: '1142', description: 'x' }] }),
    );
    await build().getCharge('chg_1/../../v2/refunds');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.tap.company/v2/charges/chg_1%2F..%2F..%2Fv2%2Frefunds',
    );
  });

  describe('clinic onboarding (Lead / Connect)', () => {
    const SEGMENT = 'sk_test_SegmentKeyNotARealSecret0';

    it('createLead POSTs /v3/lead authenticated with the ONBOARDING key, not the merchant key', async () => {
      fetchMock.mockResolvedValueOnce(res(200, { id: 'led_1' }));
      const out = await build(
        config({ tapOnboardingSecretKey: SEGMENT }),
      ).createLead({ country: 'SA' });
      expect(out.json.id).toBe('led_1');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.tap.company/v3/lead');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${SEGMENT}`);
      expect(JSON.parse(init.body)).toEqual({ country: 'SA' });
    });

    it('createConnect POSTs /v3/connect with the onboarding key', async () => {
      fetchMock.mockResolvedValueOnce(
        res(200, { connect: { url: 'https://connect.tap.test/x' } }),
      );
      const out = await build(
        config({ tapOnboardingSecretKey: SEGMENT }),
      ).createConnect({
        scope: 'merchant',
      });
      expect(out.json.connect?.url).toBe('https://connect.tap.test/x');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.tap.company/v3/connect');
      expect(init.headers.Authorization).toBe(`Bearer ${SEGMENT}`);
    });

    it('charges and retrievals still use the merchant key — the onboarding key is not a general override', async () => {
      fetchMock.mockResolvedValueOnce(res(200, { id: 'chg_1' }));
      await build(config({ tapOnboardingSecretKey: SEGMENT })).getCharge(
        'chg_1',
      );
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        `Bearer ${SECRET}`,
      );
    });

    it('with no key at all it makes no request and reports a configuration problem, not an outage', async () => {
      const out = await build(
        config({ tapSecretKey: undefined, tapOnboardingSecretKey: undefined }),
      ).createLead({});
      expect(fetchMock).not.toHaveBeenCalled();
      expect(out).toMatchObject({
        ok: false,
        transient: false,
        errorCode: 'TAP_NOT_CONFIGURED',
      });
    });
  });

  it('POSTs a JSON body for create calls', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { id: 'chg_2' }));
    await build().createCharge({ amount: 10, currency: 'SAR' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.tap.company/v2/charges');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ amount: 10, currency: 'SAR' });
  });

  it("parses Tap's errors[] into errorCode/errorDescription and treats a 4xx as DEFINITIVE", async () => {
    fetchMock.mockResolvedValueOnce(
      res(400, { errors: [{ code: 1117, description: 'Invalid amount' }] }),
    );
    const out = await build().createCharge({});
    expect(out).toMatchObject({
      ok: false,
      status: 400,
      transient: false,
      errorCode: '1117',
      errorDescription: 'Invalid amount',
    });
  });

  it.each([500, 502, 503, 504])(
    'a %i is TRANSIENT (outcome unknown), not a definitive failure',
    async (status) => {
      fetchMock.mockResolvedValueOnce(res(status, {}));
      const out = await build().createCharge({});
      expect(out).toMatchObject({ ok: false, status, transient: true });
    },
  );

  describe('429 handling', () => {
    it('retries a 429 with backoff and returns the eventual success', async () => {
      fetchMock
        .mockResolvedValueOnce(res(429, {}))
        .mockResolvedValueOnce(res(429, {}))
        .mockResolvedValueOnce(res(200, { id: 'chg_3' }));
      const client = build();
      const out = await client.getCharge('chg_3');
      expect(out.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(
        (client as any).sleep.mock.calls.map((c: number[]) => c[0]),
      ).toEqual([250, 500]);
    });

    it('gives up after the bounded retries and reports it as transient', async () => {
      fetchMock.mockResolvedValue(res(429, {}));
      const out = await build().getCharge('chg_4');
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 try + 2 retries
      expect(out).toMatchObject({ ok: false, status: 429, transient: true });
    });

    it('does NOT retry a 5xx (the request may have been processed)', async () => {
      fetchMock.mockResolvedValue(res(503, {}));
      await build().createCharge({});
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('no response at all', () => {
    it('a network error is transient/UNREACHABLE', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      const out = await build().getCharge('chg_5');
      expect(out).toMatchObject({
        ok: false,
        status: 0,
        transient: true,
        errorCode: 'UNREACHABLE',
      });
    });

    it('aborts after the configured timeout and reports TIMEOUT (transient)', async () => {
      fetchMock.mockImplementationOnce(
        (_url: string, init: any) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      );
      const out = await build().getCharge('chg_6');
      expect(out).toMatchObject({
        ok: false,
        status: 0,
        transient: true,
        errorCode: 'TIMEOUT',
      });
    });

    it('an unparseable body does not throw', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      });
      const out = await build().getCharge('chg_7');
      expect(out).toMatchObject({ ok: false, status: 502, transient: true });
    });
  });

  describe('configuration', () => {
    it('without a secret key makes NO request and is NOT transient (a config problem, not an outage)', async () => {
      const out = await build(config({ tapSecretKey: undefined })).getCharge(
        'chg_8',
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(out).toMatchObject({
        ok: false,
        transient: false,
        errorCode: 'TAP_NOT_CONFIGURED',
      });
    });

    it('isConfigured reflects the key', () => {
      expect(build().isConfigured).toBe(true);
      expect(build(config({ tapSecretKey: undefined })).isConfigured).toBe(
        false,
      );
    });

    it('honours a non-default API base', async () => {
      fetchMock.mockResolvedValueOnce(res(200, {}));
      await build(
        config({ tapApiBase: 'https://sandbox.proxy.test' }),
      ).getCharge('c');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://sandbox.proxy.test/v2/charges/c',
      );
    });
  });

  it('never writes the secret key or a request body to the logs', async () => {
    const client = build();
    const logs: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn((client as any).logger, level)
        .mockImplementation((m: unknown) => {
          logs.push(String(m));
        });
    }
    fetchMock.mockResolvedValueOnce(
      res(400, { errors: [{ code: '1117', description: 'bad' }] }),
    );
    await client.createCharge({
      customer: { email: 'patient@example.test' },
      amount: 1,
    });
    fetchMock.mockRejectedValueOnce(new Error(`boom ${SECRET}`));
    await client.createCharge({ amount: 1 });

    const all = logs.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('patient@example.test');
  });
});
