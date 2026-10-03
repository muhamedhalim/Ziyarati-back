import { PaymentLinkService } from './payment-link.service';

/**
 * T067 (US4) — the payment-link decision the deterministic public booking
 * flow (and the AI conversational one, via its own equivalent) both need:
 * issue a link only when the clinic requires payment AND the booking has an
 * amount due, and never let a failure here fail the booking that already
 * succeeded.
 */
const TENANT = 't1';
const appointment = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'appt-1',
    total_amount: 200,
    currency: 'SAR',
    ...overrides,
  }) as never;

function build(opts: {
  settings?: Record<string, unknown> | null;
  createImpl?: jest.Mock;
} = {}) {
  const tenantSettings = {
    findOne: jest.fn().mockResolvedValue(
      opts.settings === undefined ? { payment_required: true } : opts.settings,
    ),
  };
  const service = new PaymentLinkService(
    {} as never,
    tenantSettings as never,
    {} as never,
    {} as never,
    {} as never,
    {
      patientPayPageServed: true,
      payLinkUrl: (t: string) => `https://app.test/pay/${t}`,
    } as never,
  );
  if (opts.createImpl) {
    (service as unknown as { create: jest.Mock }).create = opts.createImpl;
  } else {
    (service as unknown as { create: jest.Mock }).create = jest.fn().mockResolvedValue({
      link_token: 'tok-1',
      amount: 200,
      expires_at: new Date('2026-09-01T00:00:00.000Z'),
    });
  }
  return { service, tenantSettings };
}

describe('PaymentLinkService.createIfDue (T067, US4)', () => {
  it('creates a link when payment is required and an amount is due', async () => {
    const { service } = build();
    const link = await service.createIfDue(TENANT, appointment());
    expect(link).toEqual({
      token: 'tok-1',
      amount: 200,
      currency: 'SAR',
      expiresAt: '2026-09-01T00:00:00.000Z',
      // The durable public page the patient opens — built by the payments module.
      payUrl: 'https://app.test/pay/tok-1',
    });
  });

  it('creates nothing when the clinic does not require payment', async () => {
    const { service } = build({ settings: { payment_required: false } });
    const link = await service.createIfDue(TENANT, appointment());
    expect(link).toBeUndefined();
  });

  it('creates nothing when the appointment has no amount due', async () => {
    const { service } = build();
    const link = await service.createIfDue(TENANT, appointment({ total_amount: 0 }));
    expect(link).toBeUndefined();
  });

  it('defaults to payment-required when the clinic has no settings row yet', async () => {
    const { service } = build({ settings: null });
    const link = await service.createIfDue(TENANT, appointment());
    expect(link).toBeDefined();
  });

  it('swallows a failure and returns undefined — never fails the booking', async () => {
    const { service } = build({
      createImpl: jest.fn().mockRejectedValue(new Error('merchant not chargeable')),
    });
    await expect(service.createIfDue(TENANT, appointment())).resolves.toBeUndefined();
  });
});
