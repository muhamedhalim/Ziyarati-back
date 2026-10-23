import { createHash } from 'node:crypto';

import { TapOnboardingService } from './tap-onboarding.service';
import { MERCHANT_ACCOUNT_STATUS as S } from './payments.constants';
import { ErrorCode } from '../../common/errors';

const TENANT = 't1';
const USER = 'u1';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

type Account = Record<string, unknown> & {
  id: string;
  status: string;
  provider: string;
};

function build(
  opts: {
    account?: Partial<Account>;
    configured?: boolean;
    claim?: boolean;
    lead?: unknown;
    connect?: unknown;
    tenant?: Record<string, unknown> | null;
    user?: Record<string, unknown> | null;
  } = {},
) {
  const account: Account = {
    id: 'm1',
    status: S.NOT_STARTED,
    provider: 'tap',
    ...opts.account,
  };
  const merchants = {
    tapOnboardingConfigured: jest.fn(() => opts.configured ?? true),
    getOrCreate: jest.fn(async () => account),
    claimTapOnboarding: jest.fn(async () => opts.claim ?? true),
    releaseTapOnboardingClaim: jest.fn(async () => undefined),
    recordTapLeadCreated: jest.fn(async (a: Account, leadId: string) => {
      a.provider_lead_id = leadId;
      return a;
    }),
    // Parameters are declared (even when unused) so `mock.calls` is typed with
    // the real call shape instead of an empty tuple.
    recordTapOnboardingStarted: jest.fn(
      async (a: Account, _started?: { leadId: string; callbackTokenHash: string }) => ({
        ...a,
        status: S.PENDING_DOCUMENTS,
      }),
    ),
    recordTapOnboardingClaim: jest.fn(async (_tokenHash?: string, _claim?: unknown) => ({
      id: 'm1',
      status: S.UNDER_REVIEW,
    })),
  };
  const client = {
    createLead: jest.fn(
      async (_body?: unknown) =>
        opts.lead ?? {
          ok: true,
          status: 200,
          transient: false,
          json: { id: 'led_1' },
        },
    ),
    createConnect: jest.fn(
      async (_body?: unknown) =>
        opts.connect ?? {
          ok: true,
          status: 200,
          transient: false,
          json: { connect: { url: 'https://connect.tap.test/abc' } },
        },
    ),
  };
  const config = {
    tapPlatformId: 'commerce_platform_fake',
    tapOnboardingReturnUrl: () =>
      'https://app.test/app/payments?onboarding=return',
    tapOnboardingCallbackUrl: (t: string) =>
      `https://api.test/api/v1/payments/webhooks/tap/onboarding/${t}`,
  };
  const repos = {
    tenant:
      opts.tenant === undefined
        ? {
            id: TENANT,
            name: 'Noor Clinic',
            legal_name: 'Noor Medical Co.',
            contact_email: 'owner@noor.example',
            contact_phone: '0501234567',
          }
        : opts.tenant,
    user:
      opts.user === undefined
        ? {
            id: USER,
            full_name: 'Sara Al Harbi',
            email: 'sara@noor.example',
            phone: '+966555000111',
          }
        : opts.user,
  };
  const dataSource = {
    getRepository: jest.fn((entity: { name: string }) => ({
      findOne: jest.fn(async () =>
        entity.name === 'Tenant' ? repos.tenant : repos.user,
      ),
    })),
  };
  const service = new TapOnboardingService(
    merchants as never,
    client as never,
    config as never,
    dataSource as never,
  );
  return { service, merchants, client, account };
}

describe('TapOnboardingService.start', () => {
  describe('guards', () => {
    it('is unavailable until the platform id, a key and a webhook URL are configured — and calls nothing', async () => {
      const { service, client, merchants } = build({ configured: false });
      await expect(service.start(TENANT, USER)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(merchants.getOrCreate).not.toHaveBeenCalled();
      expect(client.createLead).not.toHaveBeenCalled();
    });

    it.each([S.UNDER_REVIEW, S.REJECTED, S.SUSPENDED, S.SUBMITTED])(
      'refuses a clinic already on Tap in %s (an admin owns it from there)',
      async (status) => {
        const { service, client } = build({ account: { status } });
        await expect(service.start(TENANT, USER)).rejects.toMatchObject({
          code: ErrorCode.UNPROCESSABLE_ENTITY,
        });
        expect(client.createLead).not.toHaveBeenCalled();
      },
    );

    it('says "already set up" for an approved clinic', async () => {
      const { service } = build({ account: { status: S.APPROVED } });
      await expect(service.start(TENANT, USER)).rejects.toMatchObject({
        message: expect.stringMatching(/already set up/),
      });
    });

    it.each([S.NOT_STARTED, S.PENDING_DOCUMENTS, S.REQUIRES_ACTION])(
      'lets a clinic on Tap start/resume from %s',
      async (status) => {
        const { service } = build({
          account: { status, provider_lead_id: 'led_x' },
        });
        await expect(service.start(TENANT, USER)).resolves.toMatchObject({
          connectUrl: 'https://connect.tap.test/abc',
        });
      },
    );

    it('lets a clinic that was APPROVED under ANOTHER provider switch to Tap (that approval means nothing on Tap)', async () => {
      const { service, merchants } = build({
        account: { status: S.APPROVED, provider: 'legacy-provider' },
      });
      await expect(service.start(TENANT, USER)).resolves.toBeDefined();
      expect(merchants.recordTapLeadCreated).toHaveBeenCalled();
    });

    it('a concurrent "connect" that lost the claim gets a CONFLICT and creates nothing', async () => {
      const { service, client } = build({ claim: false });
      await expect(service.start(TENANT, USER)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(client.createLead).not.toHaveBeenCalled();
      expect(client.createConnect).not.toHaveBeenCalled();
    });
  });

  describe('the happy path', () => {
    it('creates ONE lead, persists it BEFORE the Connect call, then stores only the callback token HASH', async () => {
      const { service, client, merchants } = build();
      const order: string[] = [];
      merchants.recordTapLeadCreated.mockImplementation(
        async (a: Account, id: string) => {
          order.push('lead-persisted');
          a.provider_lead_id = id;
          return a;
        },
      );
      client.createConnect.mockImplementation(async () => {
        order.push('connect');
        return {
          ok: true,
          status: 200,
          transient: false,
          json: { connect: { url: 'https://connect.tap.test/abc' } },
        };
      });

      const out = await service.start(TENANT, USER, 'ar');

      expect(order).toEqual(['lead-persisted', 'connect']);
      expect(out).toEqual({
        connectUrl: 'https://connect.tap.test/abc',
        status: S.PENDING_DOCUMENTS,
      });
      expect(client.createLead).toHaveBeenCalledTimes(1);

      // The token Tap is given in the callback URL is NOT what is stored: only its hash.
      const connectBody = client.createConnect.mock.calls[0][0] as {
        post: { url: string };
      };
      const token = connectBody.post.url.split('/onboarding/')[1];
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
      const stored = merchants.recordTapOnboardingStarted.mock.calls[0][1] as {
        leadId: string;
        callbackTokenHash: string;
      };
      expect(stored).toEqual({
        leadId: 'led_1',
        callbackTokenHash: sha256(token),
      });
      expect(
        JSON.stringify(merchants.recordTapOnboardingStarted.mock.calls),
      ).not.toContain(token);
    });

    it('sends Connect the documented fields: lead id, merchant scope, https return + our callback, the language of the page', async () => {
      const { service, client } = build();
      await service.start(TENANT, USER, 'ar');
      const body = client.createConnect.mock.calls[0][0] as Record<string, any>;
      expect(body).toMatchObject({
        scope: 'merchant',
        lead: { id: 'led_1' },
        redirect: { url: 'https://app.test/app/payments?onboarding=return' },
        board: { editable: true, display: true },
        interface: { locale: 'ar', direction: 'rtl' },
      });
      expect(body.post.url).toMatch(
        /^https:\/\/api\.test\/api\/v1\/payments\/webhooks\/tap\/onboarding\/[A-Za-z0-9_-]+$/,
      );
    });

    it('defaults the hosted page to English / LTR for an unknown locale', async () => {
      const { service, client } = build();
      await service.start(TENANT, USER, 'fr');
      expect((client.createConnect.mock.calls[0][0] as any).interface).toEqual({
        locale: 'en',
        direction: 'ltr',
      });
    });

    it('a fresh token per Connect session (a lost token cannot be recovered, so a new link means a new token)', async () => {
      const a = build();
      await a.service.start(TENANT, USER);
      const b = build();
      await b.service.start(TENANT, USER);
      const tokenOf = (c: ReturnType<typeof build>) =>
        (
          (c.client.createConnect.mock.calls[0][0] as any).post.url as string
        ).split('/onboarding/')[1];
      expect(tokenOf(a)).not.toEqual(tokenOf(b));
    });

    it('REUSES the lead of a clinic that already has one (no duplicate legal entity) and just issues a fresh link', async () => {
      const { service, client, merchants } = build({
        account: {
          status: S.PENDING_DOCUMENTS,
          provider_lead_id: 'led_existing',
        },
      });
      await service.start(TENANT, USER);
      expect(client.createLead).not.toHaveBeenCalled();
      expect(merchants.recordTapLeadCreated).not.toHaveBeenCalled();
      expect((client.createConnect.mock.calls[0][0] as any).lead).toEqual({
        id: 'led_existing',
      });
    });

    it("does NOT reuse a lead that belongs to another provider's history", async () => {
      const { service, client } = build({
        account: {
          status: S.NOT_STARTED,
          provider: 'legacy-provider',
          provider_lead_id: 'led_stale',
        },
      });
      await service.start(TENANT, USER);
      expect(client.createLead).toHaveBeenCalledTimes(1);
    });
  });

  describe('the lead body — documented fields, only what the platform already knows', () => {
    it('ties the lead to OUR platform and sends the clinic names + a contact', async () => {
      const { service, client } = build();
      await service.start(TENANT, USER);
      const body = client.createLead.mock.calls[0][0] as Record<string, any>;
      expect(body).toMatchObject({
        country: 'SA',
        brand: { name: [{ lang: 'en', text: 'Noor Clinic' }] },
        entity: { legal_name: [{ lang: 'en', text: 'Noor Medical Co.' }] },
        wallet: { currency: 'SAR', country: 'SA' },
        merchant: { platforms: [{ id: 'commerce_platform_fake' }] },
      });
      expect(body.users).toEqual([
        {
          primary: true,
          name: [{ lang: 'en', first: 'Sara', last: 'Al Harbi' }],
          contact: {
            email: [{ address: 'owner@noor.example', primary: true }],
            phone: [
              { country_code: '966', number: '501234567', primary: true },
            ],
          },
        },
      ]);
    });

    it("NEVER sends or asks for national ID, birth date, IBAN, licence or documents — Tap's own page collects those", async () => {
      const { service, client } = build();
      await service.start(TENANT, USER);
      const json = JSON.stringify(client.createLead.mock.calls[0][0]);
      for (const forbidden of [
        'identification',
        'national_id',
        'birth',
        'iban',
        'account',
        'license',
        'documents',
        'tax',
      ]) {
        expect(json).not.toContain(`"${forbidden}"`);
      }
    });

    it('pads a name Tap would reject as too short (brand text needs ≥ 3 characters)', async () => {
      const { service, client } = build({
        tenant: {
          id: TENANT,
          name: 'AB',
          legal_name: null,
          contact_email: 'a@b.example',
        },
      });
      await service.start(TENANT, USER);
      const body = client.createLead.mock.calls[0][0] as any;
      expect(body.brand.name[0].text).toBe('AB Clinic');
      expect(body.entity.legal_name[0].text).toBe('AB Clinic');
    });

    it("never forwards a bot placeholder address as the clinic contact; falls back to the acting user's real one", async () => {
      const { service, client } = build({
        tenant: {
          id: TENANT,
          name: 'Noor Clinic',
          contact_email: 'whatsapp+x@bot.internal',
          contact_phone: null,
        },
      });
      await service.start(TENANT, USER);
      const body = client.createLead.mock.calls[0][0] as any;
      expect(body.users[0].contact.email).toEqual([
        { address: 'sara@noor.example', primary: true },
      ]);
      // a non-Saudi-parsable phone is omitted rather than guessed — the user's is Saudi, so it is used
      expect(body.users[0].contact.phone[0]).toMatchObject({
        country_code: '966',
        number: '555000111',
      });
    });

    it('omits `users` entirely when no contact detail is known', async () => {
      const { service, client } = build({
        tenant: { id: TENANT, name: 'Noor Clinic' },
        user: null,
      });
      await service.start(TENANT, undefined);
      expect((client.createLead.mock.calls[0][0] as any).users).toBeUndefined();
    });
  });

  describe("failure handling — the claim is always released, Tap's wording never forwarded", () => {
    const fail = (over: Record<string, unknown>) => ({
      ok: false,
      status: 400,
      transient: false,
      errorCode: '1117',
      json: {},
      ...over,
    });

    it('a rejected lead is a clean 422 with OUR wording, and nothing is persisted', async () => {
      const { service, merchants } = build({ lead: fail({}) });
      await expect(service.start(TENANT, USER)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
        message: expect.stringMatching(/contact support/),
      });
      expect(merchants.recordTapLeadCreated).not.toHaveBeenCalled();
      expect(merchants.releaseTapOnboardingClaim).toHaveBeenCalledWith('m1');
    });

    it('a transient lead failure (timeout / 5xx) is a 503, retryable', async () => {
      const { service, merchants } = build({
        lead: fail({ status: 503, transient: true }),
      });
      await expect(service.start(TENANT, USER)).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE,
      });
      expect(merchants.releaseTapOnboardingClaim).toHaveBeenCalled();
    });

    it('a 2xx lead with no id is a failure, not a lead', async () => {
      const { service } = build({
        lead: { ok: true, status: 200, transient: false, json: {} },
      });
      await expect(service.start(TENANT, USER)).rejects.toBeDefined();
    });

    it('a Connect failure AFTER the lead was persisted keeps the lead (the retry reuses it) and releases the claim', async () => {
      const { service, merchants } = build({
        connect: fail({ status: 500, transient: true }),
      });
      await expect(service.start(TENANT, USER)).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE,
      });
      expect(merchants.recordTapLeadCreated).toHaveBeenCalled();
      expect(merchants.recordTapOnboardingStarted).not.toHaveBeenCalled();
      expect(merchants.releaseTapOnboardingClaim).toHaveBeenCalledWith('m1');
    });

    it('a Connect answered HTTP 200 with an `errors` body is a failure (observed in the real sandbox: an unknown lead id → 200 + code 7016)', async () => {
      const { service, merchants } = build({
        connect: {
          ok: true,
          status: 200,
          transient: false,
          errorCode: '7016',
          errorDescription: 'Invalid lead_id',
          json: {
            errors: [
              {
                code: '7016',
                error: 'Invalid_Id',
                description: 'Invalid lead_id',
              },
            ],
          },
        },
      });
      await expect(service.start(TENANT, USER)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(merchants.recordTapOnboardingStarted).not.toHaveBeenCalled();
      expect(merchants.releaseTapOnboardingClaim).toHaveBeenCalledWith('m1');
    });

    it.each([
      ['http://insecure.tap.test/x', 'plain http'],
      ['javascript:alert(1)', 'a script URL'],
      ['not a url', 'garbage'],
      [undefined, 'nothing'],
    ])(
      'refuses a Connect URL that is %s (%s) — never redirect a clinic to it',
      async (url: string | undefined, _label: string) => {
        const { service, merchants } = build({
          connect: {
            ok: true,
            status: 200,
            transient: false,
            json: { connect: { url } },
          },
        });
        await expect(service.start(TENANT, USER)).rejects.toMatchObject({
          code: ErrorCode.UNPROCESSABLE_ENTITY,
        });
        expect(merchants.recordTapOnboardingStarted).not.toHaveBeenCalled();
      },
    );

    it("does not leak Tap's error description to the clinic", async () => {
      const { service } = build({
        lead: fail({
          errorCode: '1107',
          errorDescription: 'national id invalid for 1234567890',
        }),
      });
      const err = await service.start(TENANT, USER).catch((e) => e);
      expect(JSON.stringify(err)).not.toContain('1234567890');
    });
  });
});

describe('TapOnboardingService.recordCallback (an UNAUTHENTICATED hint — never trusted with money)', () => {
  const token = 'A'.repeat(43);

  it('hands the HASH of the token to the state machine, never the token', async () => {
    const { service, merchants } = build();
    await service.recordCallback(token, {});
    expect(merchants.recordTapOnboardingClaim).toHaveBeenCalledWith(
      sha256(token),
      expect.anything(),
    );
  });

  it('recognises the documented merchant shape and keeps only three advisory facts', async () => {
    const { service, merchants } = build();
    await service.recordCallback(token, {
      object: 'merchant',
      id: 'merchant_abc123',
      is_acceptance_allowed: true,
      is_payout_allowed: false,
      operator: { api_credentials: { live: { secret: 'sk_live_LEAK_ME' } } },
    });
    const claim = merchants.recordTapOnboardingClaim.mock.calls[0][1];
    expect(claim).toEqual({
      merchantId: 'merchant_abc123',
      isAcceptanceAllowed: true,
      isPayoutAllowed: false,
      recognised: true,
    });
    // The credentials that ride along on a Tap merchant object are dropped, not stored.
    expect(
      JSON.stringify(merchants.recordTapOnboardingClaim.mock.calls),
    ).not.toContain('sk_live_LEAK_ME');
  });

  it('also accepts the merchant nested under a `merchant` key', async () => {
    const { service, merchants } = build();
    await service.recordCallback(token, {
      merchant: { id: 'merchant_nested1', is_acceptance_allowed: false },
    });
    expect(merchants.recordTapOnboardingClaim.mock.calls[0][1]).toMatchObject({
      merchantId: 'merchant_nested1',
      isAcceptanceAllowed: false,
      recognised: true,
    });
  });

  it.each([
    ['an empty object', {}],
    ['an array', [1, 2]],
    ['a string', 'x'],
    ['null', null],
    ['a merchant with a malformed id', { merchant: { id: 'bad id; DROP' } }],
    ['a merchant whose id is a number', { merchant: { id: 123 } }],
    [
      'non-boolean flags',
      { merchant: { id: 'merchant_ok1', is_acceptance_allowed: 'yes' } },
    ],
  ])(
    'treats %s as unrecognised rather than throwing or trusting it',
    async (_l, body) => {
      const { service, merchants } = build();
      await expect(
        service.recordCallback(token, body),
      ).resolves.toBeUndefined();
      const claim = merchants.recordTapOnboardingClaim.mock.calls[0][1] as any;
      if (!claim.merchantId) expect(claim.recognised).toBe(false);
      expect(
        claim.isAcceptanceAllowed === undefined ||
          typeof claim.isAcceptanceAllowed === 'boolean',
      ).toBe(true);
    },
  );

  it.each([
    ['short'],
    [''],
    ['has spaces in it which is not a token at all'],
    ['../../etc/passwd'],
    ['x'.repeat(200)],
  ])(
    'ignores a malformed token (%p) without touching the database',
    async (bad) => {
      const { service, merchants } = build();
      await expect(service.recordCallback(bad, {})).resolves.toBeUndefined();
      expect(merchants.recordTapOnboardingClaim).not.toHaveBeenCalled();
    },
  );

  it('resolves quietly for an unknown token (the route answers the same 200)', async () => {
    const { service, merchants } = build();
    merchants.recordTapOnboardingClaim.mockResolvedValueOnce(null as never);
    await expect(
      service.recordCallback(token, { id: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('never logs the body or the token', async () => {
    const { service } = build();
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn((service as any).logger, level)
        .mockImplementation((m: unknown) => {
          lines.push(String(m));
        });
    }
    await service.recordCallback(token, {
      id: 'merchant_abc123',
      secret: 'sk_live_LEAK_ME',
    });
    await service.recordCallback('bad token', { secret: 'sk_live_LEAK_ME' });
    const all = lines.join('\n');
    expect(all).not.toContain('sk_live_LEAK_ME');
    expect(all).not.toContain(token);
  });
});
