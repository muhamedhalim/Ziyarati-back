import { PublicPaymentService } from './public-payment.service';
import {
  AppointmentPaymentStatus,
  AppointmentStatus,
  PaymentStatus,
} from '../../entities/enums';
import { Payment } from '../../entities/Payments/Payment';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppError, ErrorCode } from '../../common/errors';

const TENANT = 't1';
const TOKEN = 'T'.repeat(32);
const APPT = 'appt-1';
const NOW = Date.now();

const ref = (over: Record<string, unknown> = {}) => ({
  linkId: 'l1',
  tenantId: TENANT,
  appointmentId: APPT,
  status: 'ACTIVE',
  ...over,
});

const appointment = (over: Record<string, unknown> = {}) => ({
  id: APPT,
  status: AppointmentStatus.PENDING_PAYMENT,
  payment_status: AppointmentPaymentStatus.UNPAID,
  total_amount: 250,
  currency: 'SAR',
  start_at: new Date('2026-11-01T10:00:00.000Z'),
  booked_timezone: 'Asia/Riyadh',
  tenant: { name: 'Noor Clinic' },
  branch: { timezone: 'Asia/Riyadh' },
  services: [{ service: { name: 'Dental cleaning' } }],
  ...over,
});

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  status: PaymentStatus.PENDING,
  amount: 250,
  currency: 'SAR',
  gateway_payment_id: 'chg_abc12345',
  created_at: new Date(NOW - 60_000),
  metadata: {
    redirect_url: 'https://checkout.tap.test/chg_abc12345',
    redirect_issued_at: new Date(NOW - 60_000).toISOString(),
  },
  tenant: { id: TENANT, name: 'Noor Clinic' },
  appointment: {
    start_at: new Date('2026-11-01T10:00:00.000Z'),
    branch: { timezone: 'Asia/Riyadh' },
  },
  ...over,
});

function build(
  opts: {
    ref?: unknown;
    appt?: unknown;
    capability?: { available: boolean; reason?: string };
    pending?: unknown;
    byCharge?: unknown;
    served?: boolean;
  } = {},
) {
  const links = {
    findPublicByToken: jest.fn(async () =>
      opts.ref === undefined ? ref() : opts.ref,
    ),
  };
  const paymentsSvc = {
    create: jest.fn(),
    confirm: jest.fn(),
    supersedePending: jest.fn(async () => true),
  };
  const capability = {
    resolve: jest.fn(
      async () =>
        opts.capability ?? {
          available: true,
          settlementMerchantId: 'merchant_abc123',
        },
    ),
  };
  const apptRepo = {
    findOne: jest.fn(async () =>
      opts.appt === undefined ? appointment() : opts.appt,
    ),
  };
  const paymentRepo = {
    findOne: jest.fn(async (q: { where: Record<string, unknown> }) =>
      'gateway_payment_id' in q.where
        ? (opts.byCharge ?? null)
        : (opts.pending ?? null),
    ),
  };
  const dataSource = {
    getRepository: jest.fn((e: unknown) =>
      e === Appointment ? apptRepo : e === Payment ? paymentRepo : null,
    ),
  };
  const config = { patientPayPageServed: opts.served ?? true };
  const service = new PublicPaymentService(
    links as never,
    paymentsSvc as never,
    capability as never,
    dataSource as never,
    config as never,
  );
  return { service, links, paymentsSvc, capability, apptRepo, paymentRepo };
}

const isNotFound = (e: unknown) =>
  e instanceof AppError && e.code === ErrorCode.NOT_FOUND;

describe('PublicPaymentService.resolve', () => {
  it('describes the booking for a payer — and nothing that identifies the patient', async () => {
    const { service } = build();
    const view = await service.resolve(TOKEN);
    expect(view).toEqual({
      state: 'payable',
      clinicName: 'Noor Clinic',
      serviceNames: ['Dental cleaning'],
      startAt: '2026-11-01T10:00:00.000Z',
      timezone: 'Asia/Riyadh',
      amount: 250,
      currency: 'SAR',
    });
    expect(JSON.stringify(view)).not.toMatch(
      /customer|patient|phone|email|tenantId|appointmentId/i,
    );
  });

  it('an unknown / malformed token is the ONE uniform 404', async () => {
    const { service } = build({ ref: null });
    const err = await service.resolve(TOKEN).catch((e) => e);
    expect(isNotFound(err)).toBe(true);
  });

  it('a link whose appointment no longer exists is the same 404 (no oracle)', async () => {
    const { service } = build({ appt: null });
    expect(isNotFound(await service.resolve(TOKEN).catch((e) => e))).toBe(true);
  });

  it("loads the appointment inside the LINK'S tenant, never a caller-supplied one", async () => {
    const { service, apptRepo } = build();
    await service.resolve(TOKEN);
    expect(apptRepo.findOne.mock.calls[0][0]).toMatchObject({
      where: { id: APPT, tenant: { id: TENANT } },
    });
  });

  describe('state', () => {
    it.each([
      [
        'paid when the booking is PAID',
        {},
        { payment_status: AppointmentPaymentStatus.PAID },
        'paid',
      ],
      [
        'paid when partially refunded (money moved)',
        {},
        { payment_status: AppointmentPaymentStatus.PARTIALLY_REFUNDED },
        'paid',
      ],
      ['paid when the link was spent', { status: 'USED' }, {}, 'paid'],
      [
        'expired when the link was disabled',
        { status: 'DISABLED' },
        {},
        'expired',
      ],
      ['expired when the link expired', { status: 'EXPIRED' }, {}, 'expired'],
      [
        'expired for a cancelled booking',
        {},
        { status: AppointmentStatus.CANCELLED },
        'expired',
      ],
      [
        'expired for a completed booking',
        {},
        { status: AppointmentStatus.COMPLETED },
        'expired',
      ],
      [
        'expired for a no-show',
        {},
        { status: AppointmentStatus.NO_SHOW },
        'expired',
      ],
      [
        'expired for an insured booking (never charged online)',
        {},
        { payment_status: AppointmentPaymentStatus.INSURANCE },
        'expired',
      ],
      [
        'expired for a REFUNDED booking',
        {},
        { payment_status: AppointmentPaymentStatus.REFUNDED },
        'expired',
      ],
      [
        'expired when there is nothing payable',
        {},
        { total_amount: 0 },
        'expired',
      ],
      [
        'payable for a CONFIRMED but unpaid booking (pay-ahead)',
        {},
        { status: AppointmentStatus.CONFIRMED },
        'payable',
      ],
    ])('%s', async (_label, refOver, apptOver, expected) => {
      const { service } = build({
        ref: ref(refOver),
        appt: appointment(apptOver),
      });
      expect((await service.resolve(TOKEN)).state).toBe(expected);
    });

    it('unavailable when the clinic cannot take an online payment right now', async () => {
      const { service } = build({
        capability: { available: false, reason: 'CLINIC_NOT_ONBOARDED' },
      });
      const view = await service.resolve(TOKEN);
      expect(view.state).toBe('unavailable');
      // the reason code stays server-side: a payer never learns onboarding details
      expect(JSON.stringify(view)).not.toContain('CLINIC_NOT_ONBOARDED');
    });

    it('UNAVAILABLE on a deployment whose provider cannot complete a patient payment here (a non-Tap provider in production) — and the clinic is not even consulted', async () => {
      const { service, capability } = build({ served: false });
      expect((await service.resolve(TOKEN)).state).toBe('unavailable');
      expect(capability.resolve).not.toHaveBeenCalled();
    });

    it('does not even ask about capability for a link that is already paid / expired', async () => {
      const { service, capability } = build({ ref: ref({ status: 'USED' }) });
      await service.resolve(TOKEN);
      expect(capability.resolve).not.toHaveBeenCalled();
    });

    it('prices from the APPOINTMENT (server truth), rounded to 2dp', async () => {
      const { service } = build({
        appt: appointment({ total_amount: '99.999' }),
      });
      expect((await service.resolve(TOKEN)).amount).toBe(100);
    });
  });
});

describe('PublicPaymentService.checkout', () => {
  const created = (over: Record<string, unknown> = {}) => ({
    payment: payment(),
    status: PaymentStatus.PENDING,
    redirectUrl: 'https://checkout.tap.test/chg_new00001',
    ...over,
  });

  it('creates a BOOKING payment priced and routed by the SERVER — it accepts no money input at all', async () => {
    const { service, paymentsSvc } = build();
    paymentsSvc.create.mockResolvedValueOnce(created());

    const out = await service.checkout(TOKEN);

    expect(out).toEqual({
      state: 'redirect',
      redirectUrl: 'https://checkout.tap.test/chg_new00001',
    });
    expect(paymentsSvc.create).toHaveBeenCalledWith(
      TENANT,
      { appointmentId: APPT }, // no amount, currency, gateway, merchant or callback from the client
      { purpose: 'BOOKING' },
    );
    expect(service.checkout.length).toBe(1); // the token is the only parameter
  });

  it.each(['paid', 'expired', 'unavailable'] as const)(
    'returns %s without creating anything when the link is in that state',
    async (state) => {
      const map = {
        paid: { ref: ref({ status: 'USED' }) },
        expired: { ref: ref({ status: 'EXPIRED' }) },
        unavailable: { capability: { available: false } },
      };
      const { service, paymentsSvc } = build(map[state] as never);
      expect(await service.checkout(TOKEN)).toEqual({ state });
      expect(paymentsSvc.create).not.toHaveBeenCalled();
    },
  );

  it('creates nothing on a deployment that cannot complete a patient payment here', async () => {
    const { service, paymentsSvc } = build({ served: false });
    expect(await service.checkout(TOKEN)).toEqual({ state: 'unavailable' });
    expect(paymentsSvc.create).not.toHaveBeenCalled();
  });

  it('an unknown token is a 404 and creates nothing', async () => {
    const { service, paymentsSvc } = build({ ref: null });
    expect(isNotFound(await service.checkout(TOKEN).catch((e) => e))).toBe(
      true,
    );
    expect(paymentsSvc.create).not.toHaveBeenCalled();
  });

  describe('an attempt is already PENDING', () => {
    it('resumes a LIVE attempt: asks the gateway first (the payer may already have paid), then re-offers the same URL — no second charge', async () => {
      const { service, paymentsSvc } = build({ pending: payment() });
      paymentsSvc.confirm.mockResolvedValueOnce(payment());
      expect(await service.checkout(TOKEN)).toEqual({
        state: 'redirect',
        redirectUrl: 'https://checkout.tap.test/chg_abc12345',
      });
      expect(paymentsSvc.confirm).toHaveBeenCalledWith(TENANT, 'p1', {});
      expect(paymentsSvc.create).not.toHaveBeenCalled();
    });

    it('answers "paid" when the gateway says the earlier attempt was captured (webhook not here yet) — never a second charge', async () => {
      const { service, paymentsSvc } = build({ pending: payment() });
      paymentsSvc.confirm.mockResolvedValueOnce(
        payment({ status: PaymentStatus.PAID }),
      );
      expect(await service.checkout(TOKEN)).toEqual({ state: 'paid' });
      expect(paymentsSvc.create).not.toHaveBeenCalled();
    });

    it('a FAILED earlier attempt (declined / abandoned / timed out) is replaced by a NEW one', async () => {
      const { service, paymentsSvc } = build({ pending: payment() });
      paymentsSvc.confirm.mockResolvedValueOnce(
        payment({ status: PaymentStatus.FAILED }),
      );
      paymentsSvc.create.mockResolvedValueOnce(created());
      const out = await service.checkout(TOKEN);
      expect(out).toMatchObject({ state: 'redirect' });
      expect(paymentsSvc.create).toHaveBeenCalledTimes(1);
      expect(paymentsSvc.supersedePending).not.toHaveBeenCalled(); // confirm already closed it
    });

    it('an attempt that NEVER reached the gateway (no charge id, so no URL was ever shown) is superseded and replaced', async () => {
      const { service, paymentsSvc } = build({
        pending: payment({ gateway_payment_id: undefined, metadata: {} }),
      });
      paymentsSvc.create.mockResolvedValueOnce(created());
      expect(await service.checkout(TOKEN)).toMatchObject({
        state: 'redirect',
      });
      expect(paymentsSvc.supersedePending).toHaveBeenCalledWith(TENANT, 'p1');
      expect(paymentsSvc.confirm).not.toHaveBeenCalled();
    });

    it('an attempt open at the gateway PAST any payable window is superseded and replaced', async () => {
      const old = payment({
        metadata: {
          redirect_url: 'https://checkout.tap.test/chg_abc12345',
          redirect_issued_at: new Date(NOW - 80 * 60_000).toISOString(),
        },
      });
      const { service, paymentsSvc } = build({ pending: old });
      paymentsSvc.confirm.mockResolvedValueOnce(old);
      paymentsSvc.create.mockResolvedValueOnce(created());
      expect(await service.checkout(TOKEN)).toMatchObject({
        state: 'redirect',
      });
      expect(paymentsSvc.supersedePending).toHaveBeenCalledWith(TENANT, 'p1');
    });

    it("the age is read from the INSTANT WE RECORDED, never from created_at (a timestamp WITHOUT time zone, skewed by the server's UTC offset): a skewed created_at must not retire a live attempt", async () => {
      const skewed = payment({ created_at: new Date(NOW - 180 * 60_000) }); // +3h skew; the page was issued a minute ago
      const { service, paymentsSvc } = build({ pending: skewed });
      paymentsSvc.confirm.mockResolvedValueOnce(skewed);
      expect(await service.checkout(TOKEN)).toEqual({
        state: 'redirect',
        redirectUrl: 'https://checkout.tap.test/chg_abc12345',
      });
      expect(paymentsSvc.supersedePending).not.toHaveBeenCalled();
      expect(paymentsSvc.create).not.toHaveBeenCalled();
    });

    it('a row with no recorded instant is treated as live, not stale (worst case the payer sees an expired hosted page, which the next open replaces)', async () => {
      const noInstant = payment({
        metadata: { redirect_url: 'https://checkout.tap.test/chg_abc12345' },
      });
      const { service, paymentsSvc } = build({ pending: noInstant });
      paymentsSvc.confirm.mockResolvedValueOnce(noInstant);
      expect(await service.checkout(TOKEN)).toMatchObject({
        state: 'redirect',
      });
      expect(paymentsSvc.supersedePending).not.toHaveBeenCalled();
    });

    it('if the stale attempt was settled between the check and the supersede, it does NOT create a second charge', async () => {
      const old = payment({
        metadata: {
          redirect_url: 'https://checkout.tap.test/chg_abc12345',
          redirect_issued_at: new Date(NOW - 80 * 60_000).toISOString(),
        },
      });
      const { service, paymentsSvc } = build({ pending: old });
      paymentsSvc.confirm.mockResolvedValueOnce(old);
      paymentsSvc.supersedePending.mockResolvedValueOnce(false);
      expect(await service.checkout(TOKEN)).toEqual({ state: 'processing' });
      expect(paymentsSvc.create).not.toHaveBeenCalled();
    });

    it('a gateway that cannot be verified is "processing" — never a guess, never a second charge', async () => {
      const { service, paymentsSvc } = build({ pending: payment() });
      paymentsSvc.confirm.mockRejectedValueOnce(
        new Error('captured amount mismatch'),
      );
      expect(await service.checkout(TOKEN)).toEqual({ state: 'processing' });
      expect(paymentsSvc.create).not.toHaveBeenCalled();
    });

    it('a live attempt with no stored URL cannot be re-offered: "processing"', async () => {
      const { service, paymentsSvc } = build({
        pending: payment({ metadata: {} }),
      });
      paymentsSvc.confirm.mockResolvedValueOnce(payment({ metadata: {} }));
      expect(await service.checkout(TOKEN)).toEqual({ state: 'processing' });
      expect(paymentsSvc.create).not.toHaveBeenCalled();
    });

    it('never re-offers a URL that is not https', async () => {
      const bad = payment({
        metadata: { redirect_url: 'javascript:alert(1)' },
      });
      const { service, paymentsSvc } = build({ pending: bad });
      paymentsSvc.confirm.mockResolvedValueOnce(bad);
      expect(await service.checkout(TOKEN)).toEqual({ state: 'processing' });
    });
  });

  describe('the create outcome', () => {
    it('a synchronously captured payment is "paid"', async () => {
      const { service, paymentsSvc } = build();
      paymentsSvc.create.mockResolvedValueOnce(
        created({ status: PaymentStatus.PAID, redirectUrl: undefined }),
      );
      expect(await service.checkout(TOKEN)).toEqual({ state: 'paid' });
    });

    it('a rejected create (FAILED row, e.g. a payer Tap cannot be given) is "failed" — no gateway wording', async () => {
      const { service, paymentsSvc } = build();
      paymentsSvc.create.mockResolvedValueOnce(
        created({
          status: PaymentStatus.FAILED,
          redirectUrl: undefined,
          payment: payment({ failure_reason: 'Payer details are required' }),
        }),
      );
      const out = await service.checkout(TOKEN);
      expect(out).toEqual({ state: 'failed' });
      expect(JSON.stringify(out)).not.toContain('Payer details');
    });

    it('a lost race / uncertain create (PENDING with no URL yet) is "processing" so the page retries', async () => {
      const { service, paymentsSvc } = build();
      paymentsSvc.create.mockResolvedValueOnce(
        created({ redirectUrl: undefined }),
      );
      expect(await service.checkout(TOKEN)).toEqual({ state: 'processing' });
    });

    it('never hands back a non-https redirect', async () => {
      const { service, paymentsSvc } = build();
      paymentsSvc.create.mockResolvedValueOnce(
        created({ redirectUrl: 'http://evil.test/x' }),
      );
      expect(await service.checkout(TOKEN)).toEqual({ state: 'processing' });
    });

    it('"already paid" (409 from the create guard) means another request won: paid', async () => {
      const { service, paymentsSvc } = build();
      paymentsSvc.create.mockRejectedValueOnce(
        new AppError(ErrorCode.CONFLICT, {
          message: 'This booking is already paid',
        }),
      );
      expect(await service.checkout(TOKEN)).toEqual({ state: 'paid' });
    });

    it('any other domain refusal is "unavailable" — and the server\'s wording stays in the log', async () => {
      const { service, paymentsSvc } = build();
      paymentsSvc.create.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message:
            'This clinic cannot accept online payments yet: its Tap merchant account is not approved.',
        }),
      );
      const out = await service.checkout(TOKEN);
      expect(out).toEqual({ state: 'unavailable' });
    });

    it('an unexpected error is NOT swallowed', async () => {
      const { service, paymentsSvc } = build();
      paymentsSvc.create.mockRejectedValueOnce(new Error('db down'));
      await expect(service.checkout(TOKEN)).rejects.toThrow('db down');
    });
  });
});

describe('PublicPaymentService.confirmReturn', () => {
  const CHARGE = 'chg_TS05A4120230736x9K22710693';

  it.each([
    [''],
    ['pay_123'],
    ['chg_'],
    ['chg_a b'],
    ['chg_../x'],
    [undefined as never],
    [{} as never],
  ])(
    'a malformed charge id (%p) is the uniform 404 — no database probe',
    async (bad) => {
      const { service, paymentRepo } = build();
      expect(isNotFound(await service.confirmReturn(bad).catch((e) => e))).toBe(
        true,
      );
      expect(paymentRepo.findOne).not.toHaveBeenCalled();
    },
  );

  it('an UNKNOWN charge — or one that is not a booking payment on Tap — is the same 404', async () => {
    const { service } = build({ byCharge: null });
    expect(
      isNotFound(await service.confirmReturn(CHARGE).catch((e) => e)),
    ).toBe(true);
  });

  it('looks the charge up among Tap BOOKING/MANUAL payments only (never a billing or add-on charge)', async () => {
    const { service, paymentRepo } = build({
      byCharge: payment({ status: PaymentStatus.PAID }),
    });
    await service.confirmReturn(CHARGE);
    const where = (paymentRepo.findOne.mock.calls[0][0] as any).where;
    expect(where.gateway).toBe('tap');
    expect(where.gateway_payment_id).toBe(CHARGE);
    expect(JSON.stringify(where.purpose)).toContain('BOOKING');
    expect(JSON.stringify(where.purpose)).not.toContain('ADDON');
    expect(JSON.stringify(where.purpose)).not.toContain('BILLING_UPGRADE');
  });

  it('an already-PAID payment is reported paid WITHOUT re-asking the gateway, with a receipt', async () => {
    const { service, paymentsSvc } = build({
      byCharge: payment({ status: PaymentStatus.PAID }),
    });
    const out = await service.confirmReturn(CHARGE);
    expect(out).toEqual({
      state: 'paid',
      amount: 250,
      currency: 'SAR',
      clinicName: 'Noor Clinic',
      startAt: '2026-11-01T10:00:00.000Z',
      timezone: 'Asia/Riyadh',
    });
    expect(paymentsSvc.confirm).not.toHaveBeenCalled();
  });

  it('a PENDING payment is verified through the same finalizer the webhook path uses', async () => {
    const { service, paymentsSvc } = build({ byCharge: payment() });
    paymentsSvc.confirm.mockResolvedValueOnce(
      payment({ status: PaymentStatus.PAID }),
    );
    const out = await service.confirmReturn(CHARGE);
    expect(paymentsSvc.confirm).toHaveBeenCalledWith(TENANT, 'p1', {});
    expect(out.state).toBe('paid');
  });

  it('still PENDING after the gateway answered → "pending" (no receipt facts)', async () => {
    const { service, paymentsSvc } = build({ byCharge: payment() });
    paymentsSvc.confirm.mockResolvedValueOnce(payment());
    const out = await service.confirmReturn(CHARGE);
    expect(out).toEqual({ state: 'pending', amount: 250, currency: 'SAR' });
  });

  it('a FAILED payment → "failed" (no receipt facts)', async () => {
    const { service, paymentsSvc } = build({ byCharge: payment() });
    paymentsSvc.confirm.mockResolvedValueOnce(
      payment({ status: PaymentStatus.FAILED }),
    );
    expect(await service.confirmReturn(CHARGE)).toEqual({
      state: 'failed',
      amount: 250,
      currency: 'SAR',
    });
  });

  it('a verification that throws (e.g. captured amount ≠ expected) leaves it for an operator and says "pending" — it never books PAID', async () => {
    const { service, paymentsSvc } = build({ byCharge: payment() });
    paymentsSvc.confirm.mockRejectedValueOnce(
      new Error('Captured amount does not match'),
    );
    expect(await service.confirmReturn(CHARGE)).toEqual({
      state: 'pending',
      amount: 250,
      currency: 'SAR',
    });
  });

  it('receipt facts are NEVER returned for a payment that is not confirmed — a leaked charge id reveals nothing', async () => {
    const { service } = build({
      byCharge: payment({ status: PaymentStatus.FAILED }),
    });
    const out = await service.confirmReturn(CHARGE);
    expect(out).not.toHaveProperty('clinicName');
    expect(out).not.toHaveProperty('startAt');
  });
});
