import { TapWebhookVerifier } from '../webhooks/tap-webhook.verifier';
import type { PaymentsConfig } from '../payments.config';
import {
  formatPreflight,
  runTapPreflight,
  type PreflightCheck,
  type PreflightOptions,
} from './tap-preflight';

const LIVE = 'sk_live_FAKEFAKEFAKEFAKEFAKEFAKEFAKE';
const TEST = 'sk_test_FAKEFAKEFAKEFAKEFAKEFAKEFAKE';
const HOOK = 'https://api.example-clinic.com/api/v1/payments/webhooks/tap';

const liveEnv = {
  NODE_ENV: 'production',
  PAYMENT_PROVIDER: 'tap',
  TAP_ENV: 'live',
  TAP_MERCHANT_ID: '1234567',
  TAP_LIVE_SECRET_KEY: LIVE,
  TAP_WEBHOOK_URL: HOOK,
  APP_URL: 'https://www.example-clinic.com',
  TAP_RECURRING_ENABLED: 'false',
  TAP_BOOKING_PAYMENTS_ENABLED: 'false',
};

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A fake network: Tap, the frontend and the webhook endpoint each get a handler. */
function network(handlers: {
  tap?: Handler;
  frontend?: Handler;
  webhook?: Handler;
}): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith('https://api.tap.company/')) {
      return (
        handlers.tap ?? (() => json(400, { errors: [{ code: '1144' }] }))
      )(url, init);
    }
    if (url === HOOK) {
      return (handlers.webhook ?? (() => json(404, {})))(url, init);
    }
    return (handlers.frontend ?? (() => new Response('ok', { status: 200 })))(
      url,
      init,
    );
  }) as typeof fetch;
}

const run = (
  env: Record<string, string | undefined>,
  handlers: Parameters<typeof network>[0] = {},
  options: Partial<PreflightOptions> = {},
  validate?: (e: Record<string, unknown>) => unknown,
) => runTapPreflight({ env, fetch: network(handlers), validate }, options);

const status = (checks: PreflightCheck[], id: string) =>
  checks.find((c) => c.id === id)?.status;

/** A webhook endpoint that behaves like ours: verifies, re-fetch finds nothing. */
function realisticWebhook(secret: string): Handler {
  const verifier = new TapWebhookVerifier({
    tapSecretKey: secret,
  } as PaymentsConfig);
  return (_url, init) => {
    const hashstring = (init.headers as Record<string, string>).hashstring;
    const body = JSON.parse(String(init.body));
    return verifier.verify(body, hashstring)
      ? json(200, { accepted: true, matched: false })
      : json(401, { message: 'Invalid webhook signature' });
  };
}

describe('runTapPreflight', () => {
  describe('dark deploy (provider not yet switched)', () => {
    it('passes, skips every Tap check and never calls Tap', async () => {
      const tap = jest.fn(() => json(400, { errors: [{ code: '1144' }] }));
      const report = await run(
        {
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'moyasar',
          APP_URL: 'https://www.example-clinic.com',
        },
        { tap },
      );
      expect(report.ok).toBe(true);
      expect(status(report.checks, 'provider')).toBe('SKIP');
      expect(status(report.checks, 'tap-auth')).toBeUndefined();
      expect(tap).not.toHaveBeenCalled();
      // …but the frontend check still runs: it is the gate BEFORE the flip.
      expect(status(report.checks, 'frontend')).toBe('PASS');
    });

    it('treats an unset PAYMENT_PROVIDER as the legacy default, not as Tap', async () => {
      const report = await run({
        NODE_ENV: 'production',
        APP_URL: 'https://x.example.com',
      });
      expect(status(report.checks, 'provider')).toBe('SKIP');
    });

    it('--expect-active turns the skip into a failure', async () => {
      const report = await run(
        { NODE_ENV: 'production', PAYMENT_PROVIDER: 'moyasar' },
        {},
        { expectActive: true, checkFrontend: false },
      );
      expect(report.ok).toBe(false);
      expect(status(report.checks, 'provider')).toBe('FAIL');
    });
  });

  describe('a correct live configuration', () => {
    it('passes end to end', async () => {
      const report = await run(
        liveEnv,
        {},
        { expectActive: true, expectEnv: 'live', expectFlagsOff: true },
      );
      expect(report.checks.filter((c) => c.status === 'FAIL')).toEqual([]);
      expect(report.ok).toBe(true);
      expect(status(report.checks, 'tap-auth')).toBe('PASS');
      expect(status(report.checks, 'flags')).toBe('PASS');
    });

    it('sends the active key as a bearer token, to a read-only endpoint', async () => {
      const tap = jest.fn((_u: string, _i: RequestInit) =>
        json(400, { errors: [{ code: '1144' }] }),
      );
      await run(liveEnv, { tap });
      const [url, init] = tap.mock.calls[0];
      expect(init.method).toBe('GET');
      expect(url).toContain('/v2/charges/');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${LIVE}`,
      );
    });

    it('never puts a key in any line it prints', async () => {
      const report = await run(
        liveEnv,
        { webhook: realisticWebhook(LIVE) },
        { probeWebhook: true },
      );
      const text = JSON.stringify(report) + formatPreflight(report);
      expect(text).not.toContain(LIVE);
      expect(text).not.toContain('FAKEFAKE');
    });
  });

  describe('environment and keys', () => {
    it('refuses a live key that is not an sk_live_ key', async () => {
      const report = await run({ ...liveEnv, TAP_LIVE_SECRET_KEY: TEST });
      expect(status(report.checks, 'tap-key')).toBe('FAIL');
      expect(report.ok).toBe(false);
    });

    it('fails when the active key is missing', async () => {
      const report = await run({ ...liveEnv, TAP_LIVE_SECRET_KEY: undefined });
      expect(status(report.checks, 'tap-key')).toBe('FAIL');
      expect(status(report.checks, 'tap-auth')).toBe('SKIP');
    });

    it('fails when TAP_ENV is not the expected one', async () => {
      const report = await run(
        { ...liveEnv, TAP_ENV: 'sandbox', TAP_TEST_SECRET_KEY: TEST },
        {},
        { expectEnv: 'live' },
      );
      expect(status(report.checks, 'tap-env')).toBe('FAIL');
    });

    it('warns (does not fail) when production runs on sandbox keys', async () => {
      const report = await run({
        ...liveEnv,
        TAP_ENV: 'sandbox',
        TAP_TEST_SECRET_KEY: TEST,
      });
      expect(status(report.checks, 'tap-env')).toBe('WARN');
      expect(report.ok).toBe(true);
    });

    it("warns when production also carries the other environment's key", async () => {
      const report = await run({ ...liveEnv, TAP_TEST_SECRET_KEY: TEST });
      expect(status(report.checks, 'tap-key-other-env')).toBe('WARN');
      expect(report.ok).toBe(true);
    });

    it('fails when TAP_ENV is unset in production', async () => {
      const report = await run({ ...liveEnv, TAP_ENV: undefined });
      expect(status(report.checks, 'tap-env')).toBe('FAIL');
    });

    it('fails without a merchant id', async () => {
      const report = await run({ ...liveEnv, TAP_MERCHANT_ID: '' });
      expect(status(report.checks, 'tap-merchant')).toBe('FAIL');
    });
  });

  describe('the key against Tap', () => {
    it.each([
      ['401', 401, {}],
      ['403', 403, {}],
      ['1101 key/env mismatch', 400, { errors: [{ code: 1101 }] }],
      ['2104 credentials', 400, { errors: [{ code: '2104' }] }],
    ])('FAILS when Tap rejects the key (%s)', async (_n, http, body) => {
      const report = await run(liveEnv, { tap: () => json(http, body) });
      expect(status(report.checks, 'tap-auth')).toBe('FAIL');
      expect(report.ok).toBe(false);
    });

    it('accepts 9997 (bad id format) as proof the key authenticated', async () => {
      const report = await run(liveEnv, {
        tap: () => json(400, { errors: [{ code: '9997' }] }),
      });
      expect(status(report.checks, 'tap-auth')).toBe('PASS');
    });

    it.each([500, 503, 429])(
      'only WARNS on http %s — authentication was not exercised',
      async (http) => {
        const report = await run(liveEnv, { tap: () => json(http, {}) });
        expect(status(report.checks, 'tap-auth')).toBe('WARN');
        expect(report.ok).toBe(true);
      },
    );

    it('only WARNS when Tap is unreachable', async () => {
      const report = await run(liveEnv, {
        tap: () => {
          throw new Error('socket hang up');
        },
      });
      expect(status(report.checks, 'tap-auth')).toBe('WARN');
      expect(report.ok).toBe(true);
    });
  });

  describe('webhook URL', () => {
    it.each([
      [
        'plain http in production',
        'http://api.example-clinic.com/api/v1/payments/webhooks/tap',
        'FAIL',
      ],
      ['localhost', 'https://localhost/api/v1/payments/webhooks/tap', 'FAIL'],
      [
        'a private address',
        'https://10.0.3.4/api/v1/payments/webhooks/tap',
        'FAIL',
      ],
      [
        'an internal host',
        'https://api.corp.internal/api/v1/payments/webhooks/tap',
        'FAIL',
      ],
      [
        'the wrong path',
        'https://api.example-clinic.com/api/v1/payments/webhooks/moyasar',
        'FAIL',
      ],
      ['not a URL', 'api.example-clinic.com', 'FAIL'],
    ])('FAILS for %s', async (_n, url, expected) => {
      const report = await run({ ...liveEnv, TAP_WEBHOOK_URL: url });
      expect(status(report.checks, 'webhook-url')).toBe(expected);
    });

    it('FAILS when unset in production, only WARNS outside it', async () => {
      expect(
        status(
          (await run({ ...liveEnv, TAP_WEBHOOK_URL: undefined })).checks,
          'webhook-url',
        ),
      ).toBe('FAIL');
      expect(
        status(
          (
            await run({
              ...liveEnv,
              NODE_ENV: 'development',
              TAP_WEBHOOK_URL: undefined,
            })
          ).checks,
          'webhook-url',
        ),
      ).toBe('WARN');
    });

    it('accepts a trailing slash', async () => {
      const report = await run({ ...liveEnv, TAP_WEBHOOK_URL: `${HOOK}/` });
      expect(status(report.checks, 'webhook-url')).toBe('PASS');
    });
  });

  describe('flags', () => {
    it('fails booking payments without a platform id', async () => {
      const report = await run({
        ...liveEnv,
        TAP_BOOKING_PAYMENTS_ENABLED: 'true',
      });
      expect(status(report.checks, 'flags')).toBe('FAIL');
    });

    it.each(['TAP_RECURRING_ENABLED', 'TAP_BOOKING_PAYMENTS_ENABLED'])(
      '--expect-flags-off fails when %s is on',
      async (flag) => {
        const report = await run(
          {
            ...liveEnv,
            [flag]: 'true',
            TAP_PLATFORM_ID: 'commerce_platform_x',
          },
          {},
          { expectFlagsOff: true },
        );
        expect(status(report.checks, 'flags')).toBe('FAIL');
      },
    );

    it('reports an enabled flag as PASS when nothing says it must be off', async () => {
      const report = await run({ ...liveEnv, TAP_RECURRING_ENABLED: 'true' });
      expect(status(report.checks, 'flags')).toBe('PASS');
    });
  });

  describe('frontend', () => {
    it('FAILS on 404: the release with the pay pages is not deployed', async () => {
      const report = await run(liveEnv, {
        frontend: () => new Response('nf', { status: 404 }),
      });
      expect(status(report.checks, 'frontend')).toBe('FAIL');
    });

    it('FAILS in production when APP_URL is not https', async () => {
      const report = await run({
        ...liveEnv,
        APP_URL: 'http://www.example-clinic.com',
      });
      expect(status(report.checks, 'frontend')).toBe('FAIL');
    });

    it('only WARNS when unreachable outside production', async () => {
      const report = await run(
        {
          ...liveEnv,
          NODE_ENV: 'development',
          APP_URL: 'http://localhost:3000',
        },
        {
          frontend: () => {
            throw new Error('ECONNREFUSED');
          },
        },
      );
      expect(status(report.checks, 'frontend')).toBe('WARN');
    });

    it('can be skipped', async () => {
      const report = await run(liveEnv, {}, { checkFrontend: false });
      expect(status(report.checks, 'frontend')).toBeUndefined();
    });

    it('falls back to the first FRONTEND_ORIGIN', async () => {
      const seen: string[] = [];
      await run(
        {
          ...liveEnv,
          APP_URL: undefined,
          FRONTEND_ORIGIN: 'https://a.example.com,https://b.example.com',
        },
        {
          frontend: (url) => {
            seen.push(url);
            return new Response('ok');
          },
        },
      );
      expect(seen).toEqual(['https://a.example.com/pay/return']);
    });
  });

  describe("the application's own boot validation", () => {
    it('FAILS with the first line of the boot error', async () => {
      const report = await run(liveEnv, {}, {}, () => {
        throw new Error(
          '❌ Env validation error: TAP_MERCHANT_ID is not set\nsecond line',
        );
      });
      const c = report.checks.find((x) => x.id === 'env-validation')!;
      expect(c.status).toBe('FAIL');
      expect(c.detail).toContain('TAP_MERCHANT_ID is not set');
      expect(c.detail).not.toContain('second line');
      expect(c.detail).not.toContain('❌');
    });

    it('passes when the validator accepts', async () => {
      const validate = jest.fn();
      const report = await run(liveEnv, {}, {}, validate);
      expect(status(report.checks, 'env-validation')).toBe('PASS');
      expect(validate).toHaveBeenCalledTimes(1);
    });
  });

  describe('--probe-webhook', () => {
    const probe = { probeWebhook: true } as const;

    it('passes against an endpoint that verifies like ours', async () => {
      const report = await run(
        liveEnv,
        { webhook: realisticWebhook(LIVE) },
        probe,
      );
      expect(status(report.checks, 'webhook-signed')).toBe('PASS');
      expect(status(report.checks, 'webhook-unsigned')).toBe('PASS');
      expect(report.ok).toBe(true);
    });

    it('is not run unless asked for', async () => {
      const webhook = jest.fn(() => json(200, {}));
      await run(liveEnv, { webhook });
      expect(webhook).not.toHaveBeenCalled();
    });

    it('FAILS when the deployed service holds a different secret (401 on a correct signature)', async () => {
      const report = await run(
        liveEnv,
        { webhook: realisticWebhook('sk_live_SOMETHINGELSE') },
        probe,
      );
      expect(status(report.checks, 'webhook-signed')).toBe('FAIL');
      expect(report.ok).toBe(false);
    });

    it('FAILS when the endpoint accepts a WRONG signature (verification not enforced)', async () => {
      const report = await run(
        liveEnv,
        { webhook: () => json(200, { accepted: true, matched: false }) },
        probe,
      );
      expect(status(report.checks, 'webhook-signed')).toBe('PASS');
      expect(status(report.checks, 'webhook-unsigned')).toBe('FAIL');
      expect(report.ok).toBe(false);
    });

    it.each([
      [403, 'the WAF'],
      [404, 'the route'],
      [500, 'a server error'],
    ])('FAILS on http %s (%s)', async (http) => {
      const report = await run(
        liveEnv,
        { webhook: () => json(http, {}) },
        probe,
      );
      expect(status(report.checks, 'webhook-signed')).toBe('FAIL');
    });

    it('only WARNS on 503 (the API could not reach Tap to re-fetch)', async () => {
      const report = await run(
        liveEnv,
        { webhook: () => json(503, {}) },
        probe,
      );
      expect(status(report.checks, 'webhook-signed')).toBe('WARN');
    });

    it('reads the wrapped response shape ({ data: { matched } })', async () => {
      const inner = realisticWebhook(LIVE);
      const report = await run(
        liveEnv,
        {
          webhook: async (u, i) => {
            const r = await inner(u, i);
            return r.status === 200
              ? json(200, {
                  success: true,
                  data: { accepted: true, matched: false },
                })
              : r;
          },
        },
        probe,
      );
      expect(status(report.checks, 'webhook-signed')).toBe('PASS');
    });

    it('FAILS if the delivery MATCHED a real payment (the probe id must match nothing)', async () => {
      const report = await run(
        liveEnv,
        { webhook: () => json(200, { accepted: true, matched: true }) },
        probe,
      );
      expect(status(report.checks, 'webhook-signed')).toBe('FAIL');
    });

    it('needs an active Tap configuration', async () => {
      const report = await run(
        { ...liveEnv, TAP_WEBHOOK_URL: undefined },
        {},
        probe,
      );
      expect(status(report.checks, 'webhook-probe')).toBe('FAIL');
    });

    it("signs with the verifier's own formula (so it cannot drift from it)", async () => {
      const seen: { body: string; hashstring: string }[] = [];
      await run(
        liveEnv,
        {
          webhook: (_u, init) => {
            seen.push({
              body: String(init.body),
              hashstring: (init.headers as Record<string, string>).hashstring,
            });
            return json(401, {});
          },
        },
        probe,
      );
      const verifier = new TapWebhookVerifier({
        tapSecretKey: LIVE,
      } as PaymentsConfig);
      expect(
        verifier.verify(JSON.parse(seen[0].body), seen[0].hashstring),
      ).toBe(true);
      expect(
        verifier.verify(JSON.parse(seen[1].body), seen[1].hashstring),
      ).toBe(false);
    });
  });

  describe('formatPreflight', () => {
    it('ends with an unambiguous verdict line', async () => {
      const ok = formatPreflight(
        await run(
          { NODE_ENV: 'production', PAYMENT_PROVIDER: 'moyasar' },
          {},
          { checkFrontend: false },
        ),
      );
      expect(ok.trim().endsWith('TAP_PREFLIGHT_OK')).toBe(true);
      const bad = formatPreflight(
        await run({ ...liveEnv, TAP_MERCHANT_ID: '' }),
      );
      expect(bad.trim().endsWith('TAP_PREFLIGHT_FAIL')).toBe(true);
    });
  });
});
