import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SubscriptionCheckoutService } from './subscription-checkout.service';
import { InvoiceSettlementService } from './invoice-settlement.service';
import { PAYMENT_PROVIDER } from './payment/payment-provider.interface';
import { PaymentsConfig } from '../payments/payments.config';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { InvoiceStatus, SubscriptionStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import { chargeClaimFree } from './charge-claim';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';
const INVOICE = 'inv-1';
const CHARGE = 'chg_checkout_1';
const RETURN_URL = 'https://app.test/app/billing?checkout=return';

describe('SubscriptionCheckoutService', () => {
  let service: SubscriptionCheckoutService;
  let invoices: MockRepository;
  let subscriptions: MockRepository;
  let tenants: MockRepository;
  let payment: {
    name: string;
    supportsCheckout: boolean;
    checkoutWindowMinutes: number;
    createCheckout: jest.Mock;
    verifyCheckout: jest.Mock;
  };
  let settlement: { settleInvoicePaid: jest.Mock };
  let claimQb: ReturnType<typeof createMockQueryBuilder>;
  let writeQb: ReturnType<typeof createMockQueryBuilder>;

  const openInvoice = (over: Record<string, unknown> = {}) => ({
    id: INVOICE,
    tenant_id: TENANT,
    subscription_id: 'sub-1',
    status: InvoiceStatus.OPEN,
    amount: '299.00',
    currency: 'SAR',
    checkout_charge_id: null as string | null,
    checkout_started_at: null as Date | null,
    provider_reference: null as string | null,
    ...over,
  });

  /** The claim UPDATE ... RETURNING checkout_attempts. */
  const claimsAs = (attempts: number | null) =>
    claimQb.execute.mockResolvedValueOnce(
      attempts === null
        ? { affected: 0, raw: [] }
        : { affected: 1, raw: [{ checkout_attempts: attempts }] },
    );

  beforeEach(async () => {
    invoices = createMockRepository();
    subscriptions = createMockRepository();
    tenants = createMockRepository();
    claimQb = createMockQueryBuilder();
    writeQb = createMockQueryBuilder();
    // 1st query builder = the claim; any later one = a plain write.
    invoices.createQueryBuilder.mockReset();
    invoices.createQueryBuilder
      .mockReturnValueOnce(claimQb)
      .mockReturnValue(writeQb);
    payment = {
      name: 'tap',
      supportsCheckout: true,
      checkoutWindowMinutes: 30,
      createCheckout: jest.fn().mockResolvedValue({
        status: 'created',
        chargeId: CHARGE,
        redirectUrl: 'https://checkout.tap.test/?token=T',
      }),
      verifyCheckout: jest.fn(),
    };
    settlement = {
      settleInvoicePaid: jest.fn().mockResolvedValue({
        outcome: 'settled',
        invoice: { id: INVOICE, status: InvoiceStatus.PAID },
      }),
    };
    tenants.findOne.mockResolvedValue({
      id: TENANT,
      name: 'Noor Clinic',
      contact_email: 'owner@clinic.test',
      contact_phone: '0501234567',
    });
    subscriptions.findOne.mockResolvedValue({
      id: 'sub-1',
      status: SubscriptionStatus.PENDING_PAYMENT,
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionCheckoutService,
        {
          provide: getRepositoryToken(SubscriptionInvoice),
          useValue: invoices,
        },
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: PAYMENT_PROVIDER, useValue: payment },
        { provide: InvoiceSettlementService, useValue: settlement },
        {
          provide: PaymentsConfig,
          useValue: { paymentReturnUrl: jest.fn().mockReturnValue(RETURN_URL) },
        },
      ],
    }).compile();
    service = moduleRef.get(SubscriptionCheckoutService);
  });

  afterEach(() => jest.clearAllMocks());

  // ───────────────────────────── createCheckout ─────────────────────────── //

  describe('createCheckout', () => {
    it('opens a hosted checkout from SERVER-derived values and remembers the charge on the invoice', async () => {
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      claimsAs(1);

      const out = await service.createCheckout(TENANT, INVOICE);

      expect(out).toEqual({
        status: 'redirect',
        invoiceId: INVOICE,
        redirectUrl: 'https://checkout.tap.test/?token=T',
      });
      // amount / currency / return URL come from OUR rows and config, never the client
      expect(payment.createCheckout).toHaveBeenCalledWith({
        tenantId: TENANT,
        invoiceId: INVOICE,
        amount: 299,
        currency: 'SAR',
        attempt: 1,
        saveCard: true,
        returnUrl: RETURN_URL,
        payer: expect.objectContaining({
          firstName: 'Noor',
          email: 'owner@clinic.test',
          phone: { countryCode: '966', number: '501234567' },
        }),
      });
      expect(invoices.update).toHaveBeenCalledWith(
        { id: INVOICE },
        { checkout_charge_id: CHARGE, provider: 'tap' },
      );
    });

    it("is tenant-scoped: another clinic's invoice is a plain 404 and nothing is opened", async () => {
      invoices.findOne.mockResolvedValueOnce(null);
      await expect(
        service.createCheckout(TENANT, 'foreign'),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(invoices.findOne).toHaveBeenCalledWith({
        where: { id: 'foreign', tenant_id: TENANT },
      });
      expect(payment.createCheckout).not.toHaveBeenCalled();
    });

    it('is refused when no provider can take a checkout', async () => {
      payment.supportsCheckout = false;
      await expect(
        service.createCheckout(TENANT, INVOICE),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(invoices.findOne).not.toHaveBeenCalled();
    });

    it.each([
      [InvoiceStatus.PAID, ErrorCode.CONFLICT],
      [InvoiceStatus.VOID, ErrorCode.UNPROCESSABLE_ENTITY],
      [InvoiceStatus.REFUNDED, ErrorCode.UNPROCESSABLE_ENTITY],
    ])(
      'an invoice that is %s cannot be checked out (%s)',
      async (status, code) => {
        invoices.findOne.mockResolvedValueOnce(openInvoice({ status }));
        await expect(
          service.createCheckout(TENANT, INVOICE),
        ).rejects.toMatchObject({ code });
        expect(payment.createCheckout).not.toHaveBeenCalled();
      },
    );

    it.each([SubscriptionStatus.CANCELLED, SubscriptionStatus.SUSPENDED])(
      'never takes money for a %s subscription — there is nothing to apply it to',
      async (status) => {
        invoices.findOne.mockResolvedValueOnce(openInvoice());
        subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', status });
        await expect(
          service.createCheckout(TENANT, INVOICE),
        ).rejects.toMatchObject({
          code: ErrorCode.CONFLICT,
        });
        expect(payment.createCheckout).not.toHaveBeenCalled();
      },
    );

    it('refuses before claiming when the clinic has neither a usable email nor phone', async () => {
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      tenants.findOne.mockResolvedValueOnce({
        name: 'Noor Clinic',
        contact_email: 'whatsapp+t-1@bot.internal', // a placeholder, not a mailbox
        contact_phone: '12345',
      });
      await expect(
        service.createCheckout(TENANT, INVOICE),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(invoices.createQueryBuilder).not.toHaveBeenCalled();
      expect(payment.createCheckout).not.toHaveBeenCalled();
    });

    describe('the atomic claim', () => {
      it('only claims an invoice that is payable, with no merchant-initiated charge in flight and no fresh checkout', async () => {
        invoices.findOne.mockResolvedValueOnce(openInvoice());
        claimsAs(1);
        await service.createCheckout(TENANT, INVOICE);

        const predicates = claimQb.andWhere.mock.calls.map((c: unknown[]) =>
          String(c[0]),
        );
        expect(predicates).toEqual(
          expect.arrayContaining([
            'status IN (:...payable)',
            chargeClaimFree().sql,
            '(checkout_started_at IS NULL OR checkout_started_at < :checkoutStale)',
          ]),
        );
        expect(claimQb.where).toHaveBeenCalledWith(
          'id = :invoiceId AND tenant_id = :tenantId',
          { invoiceId: INVOICE, tenantId: TENANT },
        );
      });

      it('the claim takes the slot: it clears the id of a dead earlier checkout, so an unknown outcome can hand the attempt number back (D4)', async () => {
        invoices.findOne.mockResolvedValueOnce(openInvoice());
        claimsAs(2);
        await service.createCheckout(TENANT, INVOICE);
        expect(claimQb.set).toHaveBeenCalledWith(
          expect.objectContaining({
            checkout_charge_id: null,
            checkout_started_at: expect.any(Date),
          }),
        );
      });

      it('an unresolved saved-card charge (stale claim, id known) is never reclaimed by a hosted checkout — the claim SQL refuses it', async () => {
        invoices.findOne.mockResolvedValueOnce(openInvoice());
        claimsAs(1);
        await service.createCheckout(TENANT, INVOICE);
        const sql = chargeClaimFree().sql;
        expect(claimQb.andWhere.mock.calls.map((c: unknown[]) => c[0])).toContain(
          sql,
        );
        expect(sql).toContain('checkout_charge_id IS NULL');
      });

      it("numbers each NEW checkout from the invoice's own counter (the provider idempotency key)", async () => {
        invoices.findOne.mockResolvedValueOnce(openInvoice());
        claimsAs(3);
        await service.createCheckout(TENANT, INVOICE);
        expect(payment.createCheckout).toHaveBeenCalledWith(
          expect.objectContaining({ attempt: 3 }),
        );
      });

      it('two clicks cannot open two hosted charges: the loser of the claim gets a 409 and the provider is never called', async () => {
        invoices.findOne.mockResolvedValueOnce(openInvoice());
        claimsAs(null);
        await expect(
          service.createCheckout(TENANT, INVOICE),
        ).rejects.toMatchObject({
          code: ErrorCode.CONFLICT,
        });
        expect(payment.createCheckout).not.toHaveBeenCalled();
      });
    });

    describe('resuming an open checkout', () => {
      const fresh = () =>
        openInvoice({
          checkout_charge_id: CHARGE,
          checkout_started_at: new Date(Date.now() - 5 * 60_000),
        });

      it('hands back the SAME hosted page while it is still payable — no second charge, no claim', async () => {
        invoices.findOne.mockResolvedValueOnce(fresh());
        payment.verifyCheckout.mockResolvedValueOnce({
          status: 'pending',
          redirectUrl: 'https://checkout.tap.test/?token=SAME',
        });

        const out = await service.createCheckout(TENANT, INVOICE);

        expect(out).toEqual({
          status: 'redirect',
          invoiceId: INVOICE,
          redirectUrl: 'https://checkout.tap.test/?token=SAME',
        });
        expect(payment.verifyCheckout).toHaveBeenCalledWith(CHARGE);
        expect(payment.createCheckout).not.toHaveBeenCalled();
        expect(invoices.createQueryBuilder).not.toHaveBeenCalled();
      });

      it('settles instead when the open checkout turns out to be PAID already (the clinic paid, then clicked again)', async () => {
        invoices.findOne.mockResolvedValueOnce(fresh());
        payment.verifyCheckout.mockResolvedValueOnce({
          status: 'paid',
          capturedMinorUnits: 29900,
          capturedCurrency: 'SAR',
        });

        const out = await service.createCheckout(TENANT, INVOICE);

        expect(out).toEqual({ status: 'paid', invoiceId: INVOICE });
        expect(settlement.settleInvoicePaid).toHaveBeenCalledWith(
          INVOICE,
          expect.objectContaining({
            source: 'checkout_verify',
            reference: CHARGE,
            provider: 'tap',
            capturedMinorUnits: 29900,
          }),
        );
        expect(payment.createCheckout).not.toHaveBeenCalled();
      });

      it('a checkout whose charge the provider no longer KNOWS is dead: cleared, and a new one is opened (not a 503 loop)', async () => {
        invoices.findOne.mockResolvedValueOnce(fresh());
        payment.verifyCheckout.mockResolvedValueOnce({
          status: 'unknown',
          notFound: true,
        });
        invoices.createQueryBuilder.mockReset();
        const clearQb = createMockQueryBuilder();
        invoices.createQueryBuilder
          .mockReturnValueOnce(clearQb)
          .mockReturnValueOnce(claimQb);
        claimsAs(2);

        const out = await service.createCheckout(TENANT, INVOICE);

        expect(clearQb.set).toHaveBeenCalledWith({ checkout_started_at: null });
        expect(out.status).toBe('redirect');
        expect(payment.createCheckout).toHaveBeenCalledWith(
          expect.objectContaining({ attempt: 2 }),
        );
      });

      it('answers 503 — and opens nothing — when the provider cannot be asked (it may still be payable)', async () => {
        invoices.findOne.mockResolvedValueOnce(fresh());
        payment.verifyCheckout.mockResolvedValueOnce({ status: 'unknown' });
        await expect(
          service.createCheckout(TENANT, INVOICE),
        ).rejects.toMatchObject({
          code: ErrorCode.SERVICE_UNAVAILABLE,
        });
        expect(payment.createCheckout).not.toHaveBeenCalled();
      });

      it('a DEAD checkout (declined / expired) is cleared and a NEW one is opened', async () => {
        invoices.findOne.mockResolvedValueOnce(fresh());
        payment.verifyCheckout.mockResolvedValueOnce({ status: 'failed' });
        // clearCheckout uses the 1st query builder; the claim then uses the 2nd
        invoices.createQueryBuilder.mockReset();
        const clearQb = createMockQueryBuilder();
        invoices.createQueryBuilder
          .mockReturnValueOnce(clearQb)
          .mockReturnValueOnce(claimQb);
        claimsAs(2);

        const out = await service.createCheckout(TENANT, INVOICE);

        expect(clearQb.set).toHaveBeenCalledWith({ checkout_started_at: null });
        expect(clearQb.where).toHaveBeenCalledWith(
          'id = :invoiceId AND checkout_charge_id = :chargeId',
          { invoiceId: INVOICE, chargeId: CHARGE },
        );
        expect(out.status).toBe('redirect');
        expect(payment.createCheckout).toHaveBeenCalledWith(
          expect.objectContaining({ attempt: 2 }),
        );
      });

      it('a checkout older than the payable window is not resumed — it is just claimed afresh', async () => {
        invoices.findOne.mockResolvedValueOnce(
          openInvoice({
            checkout_charge_id: CHARGE,
            checkout_started_at: new Date(Date.now() - 45 * 60_000),
          }),
        );
        claimsAs(2);
        await service.createCheckout(TENANT, INVOICE);
        expect(payment.verifyCheckout).not.toHaveBeenCalled();
        expect(payment.createCheckout).toHaveBeenCalled();
      });
    });

    describe('when the provider cannot start it', () => {
      it('UNKNOWN (timeout / 5xx): 503, and the counter is handed BACK so a retry reuses the same idempotency key', async () => {
        invoices.findOne.mockResolvedValueOnce(openInvoice());
        claimsAs(2);
        payment.createCheckout.mockResolvedValueOnce({
          status: 'unknown',
          failureCode: 'TIMEOUT',
        });

        await expect(
          service.createCheckout(TENANT, INVOICE),
        ).rejects.toMatchObject({
          code: ErrorCode.SERVICE_UNAVAILABLE,
        });

        expect(writeQb.set).toHaveBeenCalledWith(
          expect.objectContaining({ checkout_started_at: null }),
        );
        const setArg = writeQb.set.mock.calls[0][0] as {
          checkout_attempts: () => string;
        };
        expect(setArg.checkout_attempts()).toBe(
          'GREATEST(checkout_attempts - 1, 0)',
        );
        // only rolled back while no charge id was recorded
        expect(writeQb.where).toHaveBeenCalledWith(
          'id = :id AND checkout_charge_id IS NULL',
          { id: INVOICE },
        );
      });

      it("FAILED (nothing created): 422 with the provider's user-safe text, and the invoice is freed", async () => {
        invoices.findOne.mockResolvedValueOnce(openInvoice());
        claimsAs(1);
        payment.createCheckout.mockResolvedValueOnce({
          status: 'failed',
          failureCode: '1117',
          failureReason: 'Payment could not be started',
        });

        await expect(
          service.createCheckout(TENANT, INVOICE),
        ).rejects.toMatchObject({
          code: ErrorCode.UNPROCESSABLE_ENTITY,
          message: 'Payment could not be started',
        });
        expect(invoices.update).toHaveBeenCalledWith(
          { id: INVOICE },
          { checkout_started_at: null },
        );
      });

      it('a "created" answer that lacks the charge id or page is NOT treated as success', async () => {
        invoices.findOne.mockResolvedValueOnce(openInvoice());
        claimsAs(1);
        payment.createCheckout.mockResolvedValueOnce({ status: 'created' });
        await expect(
          service.createCheckout(TENANT, INVOICE),
        ).rejects.toBeDefined();
        expect(invoices.update).not.toHaveBeenCalledWith(
          { id: INVOICE },
          expect.objectContaining({ checkout_charge_id: expect.anything() }),
        );
      });
    });
  });

  // ───────────────────────────── verifyCheckout ─────────────────────────── //

  describe('verifyCheckout (the return page)', () => {
    const paid = (over: Record<string, unknown> = {}) => ({
      status: 'paid',
      chargeId: CHARGE,
      invoiceId: INVOICE,
      capturedMinorUnits: 29900,
      capturedCurrency: 'SAR',
      savedPaymentMethod: {
        provider: 'tap',
        customerId: 'cus_1',
        cardId: 'card_1',
        agreementId: 'agr_1',
        recurringCapable: true,
      },
      ...over,
    });
    const mine = () => openInvoice({ checkout_charge_id: CHARGE });

    it("settles a captured charge for the caller's own invoice, passing the saved card and captured figures", async () => {
      payment.verifyCheckout.mockResolvedValueOnce(paid());
      invoices.findOne.mockResolvedValueOnce(mine());
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
      });

      const out = await service.verifyCheckout(TENANT, CHARGE);

      expect(out).toEqual({
        status: 'paid',
        invoiceId: INVOICE,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
      });
      expect(settlement.settleInvoicePaid).toHaveBeenCalledWith(INVOICE, {
        source: 'checkout_verify',
        provider: 'tap',
        reference: CHARGE,
        capturedMinorUnits: 29900,
        capturedCurrency: 'SAR',
        amountRequired: true,
        savedPaymentMethod: expect.objectContaining({ cardId: 'card_1' }),
      });
      expect(invoices.findOne).toHaveBeenCalledWith({
        where: { id: INVOICE, tenant_id: TENANT },
      });
    });

    it("IDOR: a charge that belongs to ANOTHER clinic's invoice is a plain 404 and settles nothing", async () => {
      payment.verifyCheckout.mockResolvedValueOnce(
        paid({ invoiceId: 'other-tenants-invoice' }),
      );
      invoices.findOne.mockResolvedValueOnce(null); // tenant-scoped lookup finds nothing

      await expect(
        service.verifyCheckout(TENANT, CHARGE),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(invoices.findOne).toHaveBeenCalledWith({
        where: { id: 'other-tenants-invoice', tenant_id: TENANT },
      });
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('a charge that is not one of OUR invoice charges at all (no invoice id echoed) is a plain 404', async () => {
      payment.verifyCheckout.mockResolvedValueOnce(
        paid({ invoiceId: undefined }),
      );
      await expect(
        service.verifyCheckout(TENANT, CHARGE),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(invoices.findOne).not.toHaveBeenCalled();
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('the charge must be the one WE issued for that invoice: a different (even genuine) charge is a 404', async () => {
      payment.verifyCheckout.mockResolvedValueOnce(
        paid({ chargeId: 'chg_someone_elses' }),
      );
      invoices.findOne.mockResolvedValueOnce(
        openInvoice({ checkout_charge_id: 'chg_ours' }),
      );
      await expect(
        service.verifyCheckout(TENANT, 'chg_someone_elses'),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('accepts the recorded provider_reference too (an already-settled invoice re-verified)', async () => {
      payment.verifyCheckout.mockResolvedValueOnce(paid());
      invoices.findOne.mockResolvedValueOnce(
        openInvoice({
          status: InvoiceStatus.PAID,
          checkout_charge_id: 'older',
          provider_reference: CHARGE,
        }),
      );
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'already_paid',
        invoice: { id: INVOICE, status: InvoiceStatus.PAID },
      });
      expect((await service.verifyCheckout(TENANT, CHARGE)).status).toBe(
        'paid',
      );
    });

    it('unknown (provider UNREACHABLE) answers "unknown" without revealing or touching anything', async () => {
      payment.verifyCheckout.mockResolvedValueOnce({ status: 'unknown' });
      expect(await service.verifyCheckout(TENANT, CHARGE)).toEqual({
        status: 'unknown',
      });
      expect(invoices.findOne).not.toHaveBeenCalled();
    });

    it("a charge the provider DEFINITIVELY does not know is the SAME plain 404 as another clinic's — no existence oracle", async () => {
      payment.verifyCheckout.mockResolvedValueOnce({
        status: 'unknown',
        notFound: true,
      });
      const unknown = await service
        .verifyCheckout(TENANT, 'chg_made_up')
        .catch((e) => e);

      payment.verifyCheckout.mockResolvedValueOnce(
        paid({ invoiceId: 'other-tenants-invoice' }),
      );
      invoices.findOne.mockResolvedValueOnce(null);
      const foreign = await service
        .verifyCheckout(TENANT, CHARGE)
        .catch((e) => e);

      expect(unknown.code).toBe(ErrorCode.NOT_FOUND);
      expect(foreign.code).toBe(ErrorCode.NOT_FOUND);
      expect(unknown.message).toBe(foreign.message);
      expect(unknown.statusCode).toBe(foreign.statusCode);
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('pending: nothing is settled, the page keeps polling', async () => {
      payment.verifyCheckout.mockResolvedValueOnce(paid({ status: 'pending' }));
      invoices.findOne.mockResolvedValueOnce(mine());
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        status: SubscriptionStatus.PENDING_PAYMENT,
      });
      const out = await service.verifyCheckout(TENANT, CHARGE);
      expect(out).toMatchObject({
        status: 'pending',
        subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
      });
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('failed: the dead checkout is cleared so the clinic can start another at once', async () => {
      payment.verifyCheckout.mockResolvedValueOnce(paid({ status: 'failed' }));
      invoices.findOne.mockResolvedValueOnce(mine());
      invoices.createQueryBuilder.mockReset();
      const clearQb = createMockQueryBuilder();
      invoices.createQueryBuilder.mockReturnValue(clearQb);

      const out = await service.verifyCheckout(TENANT, CHARGE);

      expect(out.status).toBe('failed');
      expect(clearQb.set).toHaveBeenCalledWith({ checkout_started_at: null });
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('a capture the settle path refuses (amount mismatch / void invoice) is a 409, never a silent success', async () => {
      payment.verifyCheckout.mockResolvedValueOnce(
        paid({ capturedMinorUnits: 1 }),
      );
      invoices.findOne.mockResolvedValueOnce(mine());
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'rejected',
        reason: 'amount_mismatch',
        invoice: mine(),
      });
      await expect(
        service.verifyCheckout(TENANT, CHARGE),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });
  });
});
