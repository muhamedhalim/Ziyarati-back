import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BillingService } from './billing.service';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import {
  FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
  PAYMENT_PROVIDER,
} from './payment/payment-provider.interface';
import { InvoiceStatus, SubscriptionInvoiceKind } from '../../entities/enums';
import { InvoiceSettlementService } from './invoice-settlement.service';
import { PaymentMethodService } from './payment-method.service';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockQueryBuilder,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
  MockQueryBuilder,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('BillingService', () => {
  let service: BillingService;
  let invoices: MockRepository;
  let tenants: MockRepository;
  let payment: {
    name: string;
    supportsCheckout: boolean;
    checkoutWindowMinutes: number;
    charge: jest.Mock;
  };
  let settlement: { settleInvoicePaid: jest.Mock };
  let methods: { resolveForCharge: jest.Mock };
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let claimQb: MockQueryBuilder;

  const lockedRepo = () =>
    manager.getRepository(SubscriptionInvoice) as unknown as MockRepository;

  beforeEach(async () => {
    invoices = createMockRepository();
    tenants = createMockRepository();
    payment = {
      name: 'tap',
      supportsCheckout: true,
      checkoutWindowMinutes: 30,
      charge: jest.fn(),
    };
    settlement = { settleInvoicePaid: jest.fn() };
    methods = { resolveForCharge: jest.fn().mockResolvedValue(null) };
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    claimQb = createMockQueryBuilder();
    invoices.createQueryBuilder.mockReturnValue(claimQb);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        {
          provide: getRepositoryToken(SubscriptionInvoice),
          useValue: invoices,
        },
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: PAYMENT_PROVIDER, useValue: payment },
        { provide: DataSource, useValue: dataSource },
        { provide: InvoiceSettlementService, useValue: settlement },
        { provide: PaymentMethodService, useValue: methods },
      ],
    }).compile();
    service = moduleRef.get(BillingService);
  });

  afterEach(() => jest.clearAllMocks());

  it('generates an OPEN invoice with a 2-dp amount', async () => {
    invoices.save.mockImplementationOnce(async (i: any) => i);
    const periodStart = new Date('2026-01-01T00:00:00.000Z');
    const periodEnd = new Date('2026-02-01T00:00:00.000Z');
    const inv = await service.generateInvoice(
      TENANT,
      'sub1',
      99.5,
      periodStart,
      periodEnd,
      'SAR',
    );
    expect(inv).toMatchObject({
      amount: '99.50',
      status: InvoiceStatus.OPEN,
      period_start: periodStart,
      period_end: periodEnd,
      currency: 'SAR',
    });
  });

  // VER-013 (REQ-BILL-013) — only the NOT_FOUND case had coverage; the happy
  // path and the tenant-scoping guarantee itself were unproven.
  describe('getInvoice (VER-013 — REQ-BILL-013)', () => {
    it("returns the invoice when it belongs to the caller's tenant", async () => {
      invoices.findOne.mockResolvedValueOnce({
        id: 'inv1',
        tenant_id: TENANT,
        status: InvoiceStatus.OPEN,
        amount: '99.50',
      });
      const result = await service.getInvoice(TENANT, 'inv1');
      expect(result).toMatchObject({ id: 'inv1', amount: '99.50' });
    });

    it('throws when not found', async () => {
      invoices.findOne.mockResolvedValueOnce(null);
      await expect(service.getInvoice(TENANT, 'x')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it("the query is tenant-scoped by construction — a foreign tenant's invoice id can never be returned", async () => {
      invoices.findOne.mockResolvedValueOnce(null);
      await service
        .getInvoice(TENANT, 'foreign-invoice')
        .catch(() => undefined);
      expect(invoices.findOne).toHaveBeenCalledWith({
        where: { id: 'foreign-invoice', tenant_id: TENANT },
      });
    });
  });

  describe('listInvoices (adjacent to VER-013 — same read path, previously untested)', () => {
    it('is tenant-scoped, newest first', async () => {
      invoices.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.listInvoices(TENANT, { page: 1, limit: 20 } as any);
      expect(invoices.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenant_id: TENANT },
          order: { issued_at: 'DESC' },
        }),
      );
    });

    it('applies an optional status filter as an additional predicate, not a replacement of the tenant scope', async () => {
      invoices.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.listInvoices(TENANT, {
        status: InvoiceStatus.PAID,
        page: 1,
        limit: 20,
      } as any);
      expect(invoices.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenant_id: TENANT, status: InvoiceStatus.PAID },
        }),
      );
    });
  });

  describe('payInvoice (atomic charge claim)', () => {
    const claimed = () =>
      claimQb.execute.mockResolvedValueOnce({ affected: 1, raw: [] });
    const openInvoice = (over: Record<string, unknown> = {}) => ({
      id: 'inv1',
      status: InvoiceStatus.OPEN,
      amount: '100',
      currency: 'SAR',
      retry_count: 0,
      ...over,
    });

    it('claims the invoice, charges the provider, and books the capture through the single settle path', async () => {
      claimed();
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      payment.charge.mockResolvedValueOnce({
        success: true,
        reference: 'gw-ref-1',
      });
      const settledInvoice = {
        ...openInvoice(),
        status: InvoiceStatus.PAID,
        provider_reference: 'gw-ref-1',
      };
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'settled',
        invoice: settledInvoice,
      });

      const res = await service.payInvoice(TENANT, 'inv1');

      expect(res).toBe(settledInvoice);
      expect(settlement.settleInvoicePaid).toHaveBeenCalledWith('inv1', {
        source: 'charge',
        provider: 'tap',
        reference: 'gw-ref-1',
        paymentMethodId: undefined,
        savedPaymentMethod: undefined,
      });
      // T079/T081 — the charge uses the INVOICE's own currency (snapshotted
      // at issue time from the platform default), never a hardcoded value.
      expect(payment.charge).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'SAR' }),
      );
    });

    it("charges the clinic's saved card and records which one", async () => {
      claimed();
      invoices.findOne.mockResolvedValueOnce(openInvoice({ retry_count: 2 }));
      const ref = {
        customerId: 'cus_1',
        cardId: 'card_1',
        agreementId: 'agr_1',
      };
      methods.resolveForCharge.mockResolvedValueOnce({ id: 'pm-1', ref });
      payment.charge.mockResolvedValueOnce({
        success: true,
        reference: 'gw-1',
      });
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'settled',
        invoice: { id: 'inv1', status: InvoiceStatus.PAID },
      });

      await service.payInvoice(TENANT, 'inv1');

      expect(methods.resolveForCharge).toHaveBeenCalledWith(TENANT);
      expect(payment.charge).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethod: ref, attempt: 2 }),
      );
      expect(settlement.settleInvoicePaid).toHaveBeenCalledWith(
        'inv1',
        expect.objectContaining({ paymentMethodId: 'pm-1' }),
      );
    });

    it('falls back to a synthetic reference when a provider reports success without one', async () => {
      claimed();
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      payment.charge.mockResolvedValueOnce({ success: true });
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'settled',
        invoice: { id: 'inv1', status: InvoiceStatus.PAID },
      });
      await service.payInvoice(TENANT, 'inv1');
      expect(settlement.settleInvoicePaid).toHaveBeenCalledWith(
        'inv1',
        expect.objectContaining({ reference: 'tap:inv1' }),
      );
    });

    it('returns the invoice untouched when the settle path says it was already paid (idempotent)', async () => {
      claimed();
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      payment.charge.mockResolvedValueOnce({
        success: true,
        reference: 'gw-ref-2',
      });
      const alreadyPaid = {
        id: 'inv1',
        status: InvoiceStatus.PAID,
        provider_reference: 'gw-ref-1',
      };
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'already_paid',
        invoice: alreadyPaid,
      });
      expect(await service.payInvoice(TENANT, 'inv1')).toBe(alreadyPaid);
    });

    it('answers 409 when the capture cannot be booked (invoice voided under the charge) — the settle path raised the ALERT', async () => {
      claimed();
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      payment.charge.mockResolvedValueOnce({
        success: true,
        reference: 'gw-ref-1',
      });
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'rejected',
        reason: 'invoice_void',
        invoice: { id: 'inv1', status: InvoiceStatus.VOID },
      });
      await expect(service.payInvoice(TENANT, 'inv1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('rejects an already-paid invoice (409, no charge attempted)', async () => {
      claimQb.execute.mockResolvedValueOnce({ affected: 0, raw: [] });
      invoices.findOne.mockResolvedValueOnce({
        id: 'inv1',
        status: InvoiceStatus.PAID,
      });
      await expect(service.payInvoice(TENANT, 'inv1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(payment.charge).not.toHaveBeenCalled();
    });

    it('rejects a void/refunded invoice with 422 (no charge attempted)', async () => {
      claimQb.execute.mockResolvedValueOnce({ affected: 0, raw: [] });
      invoices.findOne.mockResolvedValueOnce({
        id: 'inv1',
        status: InvoiceStatus.VOID,
      });
      await expect(service.payInvoice(TENANT, 'inv1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(payment.charge).not.toHaveBeenCalled();
    });

    it('returns 409 when another charge attempt holds a fresh claim (double-charge protection)', async () => {
      claimQb.execute.mockResolvedValueOnce({ affected: 0, raw: [] });
      invoices.findOne.mockResolvedValueOnce({
        id: 'inv1',
        status: InvoiceStatus.OPEN,
        charge_started_at: new Date(),
      });
      await expect(service.payInvoice(TENANT, 'inv1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
        message: expect.stringContaining('already in progress'),
      });
      expect(payment.charge).not.toHaveBeenCalled();
    });

    it('returns 409 — and says why — when the clinic has a hosted checkout open (never double-captured by the renewal job)', async () => {
      claimQb.execute.mockResolvedValueOnce({ affected: 0, raw: [] });
      invoices.findOne.mockResolvedValueOnce({
        id: 'inv1',
        status: InvoiceStatus.OPEN,
        checkout_started_at: new Date(),
      });
      await expect(service.payInvoice(TENANT, 'inv1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
        message: expect.stringContaining('checkout'),
      });
      expect(payment.charge).not.toHaveBeenCalled();
    });

    it('the claim itself refuses an invoice whose hosted checkout is younger than the checkout window', async () => {
      claimed();
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      payment.charge.mockResolvedValueOnce({
        success: false,
        failureReason: 'x',
      });
      lockedRepo().findOne.mockResolvedValueOnce({
        id: 'inv1',
        status: InvoiceStatus.OPEN,
      });
      await service.payInvoice(TENANT, 'inv1').catch(() => undefined);

      const predicates = claimQb.andWhere.mock.calls.map((c: unknown[]) =>
        String(c[0]),
      );
      expect(
        predicates.some((p: string) =>
          p.includes('checkout_started_at IS NULL OR checkout_started_at <'),
        ),
      ).toBe(true);
      const params = claimQb.andWhere.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('checkout_started_at'),
      )![1] as { checkoutStaleBefore: Date };
      const windowMs = Date.now() - params.checkoutStaleBefore.getTime();
      expect(windowMs).toBeGreaterThanOrEqual(29 * 60_000);
      expect(windowMs).toBeLessThan(31 * 60_000);
    });

    it('surfaces a provider decline as 422, records the reason and class, and releases the claim', async () => {
      claimed();
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      payment.charge.mockResolvedValueOnce({
        success: false,
        failureReason: 'card declined',
        failureClass: FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
      });
      const locked: any = {
        id: 'inv1',
        status: InvoiceStatus.OPEN,
        amount: '100',
        charge_started_at: new Date(),
      };
      lockedRepo().findOne.mockResolvedValueOnce(locked);

      await expect(service.payInvoice(TENANT, 'inv1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(locked.failure_reason).toBe('card declined');
      expect(locked.failure_class).toBe(FAILURE_CLASS_TOKENIZATION_UNAVAILABLE);
      expect(locked.charge_started_at).toBeNull();
      expect(lockedRepo().save).toHaveBeenCalledWith(locked);
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('a decline whose invoice turned PAID meanwhile is returned untouched (idempotent finalize)', async () => {
      claimed();
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      payment.charge.mockResolvedValueOnce({
        success: false,
        failureReason: 'late',
      });
      const alreadyPaid = { id: 'inv1', status: InvoiceStatus.PAID };
      lockedRepo().findOne.mockResolvedValueOnce(alreadyPaid);

      expect(await service.payInvoice(TENANT, 'inv1')).toBe(alreadyPaid);
      expect(lockedRepo().save).not.toHaveBeenCalled();
    });

    it('PENDING with a charge id: keeps the claim, remembers the charge, returns the OPEN invoice, throws nothing', async () => {
      claimed();
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      payment.charge.mockResolvedValueOnce({
        success: false,
        status: 'pending',
        reference: 'chg_pending_1',
      });
      const locked: any = {
        id: 'inv1',
        status: InvoiceStatus.OPEN,
        charge_started_at: new Date(),
        checkout_charge_id: null,
      };
      lockedRepo().findOne.mockResolvedValueOnce(locked);
      lockedRepo().save.mockImplementationOnce(async (i: any) => i);

      const res = await service.payInvoice(TENANT, 'inv1');

      expect(res.status).toBe(InvoiceStatus.OPEN);
      expect(locked.charge_started_at).toBeInstanceOf(Date); // claim KEPT — reconcile/webhook settles it
      expect(locked.checkout_charge_id).toBe('chg_pending_1');
      expect(locked.failure_reason ?? null).toBeNull(); // not a decline
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('PENDING with no charge id: releases the claim (nothing to verify — the retry reuses the same idempotency key)', async () => {
      claimed();
      invoices.findOne.mockResolvedValueOnce(openInvoice());
      payment.charge.mockResolvedValueOnce({
        success: false,
        status: 'pending',
      });
      const locked: any = {
        id: 'inv1',
        status: InvoiceStatus.OPEN,
        charge_started_at: new Date(),
      };
      lockedRepo().findOne.mockResolvedValueOnce(locked);
      lockedRepo().save.mockImplementationOnce(async (i: any) => i);

      const res = await service.payInvoice(TENANT, 'inv1');

      expect(res.status).toBe(InvoiceStatus.OPEN);
      expect(locked.charge_started_at).toBeNull();
      expect(locked.failure_reason ?? null).toBeNull();
    });
  });

  describe('Tap migration helpers (Phase 3)', () => {
    it('generateInvoice stamps kind / target plan / provider, and leaves them NULL for a legacy caller', async () => {
      invoices.save.mockImplementation(async (i: any) => i);
      const t = new Date('2026-01-01T00:00:00.000Z');
      const withExtra = await service.generateInvoice(
        TENANT,
        's',
        10,
        t,
        t,
        'SAR',
        InvoiceStatus.OPEN,
        {
          kind: SubscriptionInvoiceKind.UPGRADE,
          targetPlanId: 'plan-2',
          provider: 'tap',
        },
      );
      expect(withExtra).toMatchObject({
        kind: 'UPGRADE',
        target_plan_id: 'plan-2',
        provider: 'tap',
      });

      const legacy = await service.generateInvoice(
        TENANT,
        's',
        10,
        t,
        t,
        'SAR',
      );
      expect(legacy).toMatchObject({
        kind: null,
        target_plan_id: null,
        provider: null,
      });
    });

    it('exposes whether the bound provider can take a checkout, and its name', () => {
      expect(service.supportsCheckout).toBe(true);
      expect(service.providerName).toBe('tap');
    });

    it('voidOpenInvoices voids only OPEN invoices of ONE subscription and reports how many', async () => {
      const qb = createMockQueryBuilder();
      qb.execute.mockResolvedValueOnce({ affected: 2, raw: [] });
      invoices.createQueryBuilder.mockReturnValueOnce(qb);

      const n = await service.voidOpenInvoices('sub-1', 'Superseded');

      expect(n).toBe(2);
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: InvoiceStatus.VOID,
          failure_reason: 'Superseded',
        }),
      );
      expect(qb.where).toHaveBeenCalledWith(
        'subscription_id = :subscriptionId',
        { subscriptionId: 'sub-1' },
      );
      expect(qb.andWhere).toHaveBeenCalledWith('status = :open', {
        open: InvoiceStatus.OPEN,
      });
    });

    it('voidSupersededOpenInvoices touches only legacy/upgrade invoices that nobody is paying right now', async () => {
      const qb = createMockQueryBuilder();
      qb.execute.mockResolvedValueOnce({ affected: 1, raw: [] });
      invoices.createQueryBuilder.mockReturnValueOnce(qb);

      await service.voidSupersededOpenInvoices(
        'sub-1',
        'Superseded by renewal',
      );

      const predicates = qb.andWhere.mock.calls.map((c: unknown[]) =>
        String(c[0]),
      );
      expect(predicates).toEqual(
        expect.arrayContaining([
          'status = :open',
          '(kind IS NULL OR kind = :upgrade)',
          expect.stringContaining('charge_started_at'),
          expect.stringContaining('checkout_started_at'),
        ]),
      );
      // a RENEWAL / INITIAL / REACTIVATION invoice is never in that set
      const kindParams = qb.andWhere.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('kind'),
      )![1];
      expect(kindParams).toEqual({ upgrade: SubscriptionInvoiceKind.UPGRADE });
    });

    it("findOpenInvoice looks up the subscription's single OPEN invoice", async () => {
      invoices.findOne.mockResolvedValueOnce({ id: 'inv-9' });
      expect(await service.findOpenInvoice('sub-1')).toEqual({ id: 'inv-9' });
      expect(invoices.findOne).toHaveBeenCalledWith({
        where: { subscription_id: 'sub-1', status: InvoiceStatus.OPEN },
      });
    });

    it('isPaymentInFlight: a fresh claim or an open checkout counts; stale or absent ones do not', () => {
      const now = Date.now();
      const mins = (m: number) => new Date(now - m * 60_000);
      expect(
        service.isPaymentInFlight({ charge_started_at: mins(2) } as any, now),
      ).toBe(true);
      expect(
        service.isPaymentInFlight(
          { checkout_started_at: mins(10) } as any,
          now,
        ),
      ).toBe(true);
      expect(
        service.isPaymentInFlight({ charge_started_at: mins(11) } as any, now),
      ).toBe(false);
      expect(
        service.isPaymentInFlight(
          { checkout_started_at: mins(31) } as any,
          now,
        ),
      ).toBe(false);
      expect(service.isPaymentInFlight({} as any, now)).toBe(false);
    });

    it('settleInvoicePaid delegates to the settle service unchanged', async () => {
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'settled',
        invoice: null,
      });
      const evidence = {
        source: 'webhook',
        provider: 'tap',
        reference: 'chg_1',
      } as const;
      await service.settleInvoicePaid('inv-1', evidence);
      expect(settlement.settleInvoicePaid).toHaveBeenCalledWith(
        'inv-1',
        evidence,
      );
    });
  });

  describe('listTokenizationDeclines (T089 — FR-B005e)', () => {
    it('returns the affected clinics with their retry state, newest-due first', async () => {
      invoices.find.mockResolvedValueOnce([
        {
          id: 'inv1',
          tenant_id: 'tenant-a',
          subscription_id: 'sub-a',
          amount: '99.00',
          retry_count: 2,
          next_retry_at: new Date('2026-09-01T00:00:00.000Z'),
        },
        {
          id: 'inv2',
          tenant_id: 'tenant-b',
          subscription_id: 'sub-b',
          amount: '49.00',
          retry_count: 1,
          next_retry_at: new Date('2026-09-05T00:00:00.000Z'),
        },
      ]);
      tenants.find.mockResolvedValueOnce([
        { id: 'tenant-a', name: 'Clinic A' },
        { id: 'tenant-b', name: 'Clinic B' },
      ]);

      const result = await service.listTokenizationDeclines();

      expect(invoices.find).toHaveBeenCalledWith({
        where: {
          status: InvoiceStatus.OPEN,
          failure_class: FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
        },
        order: { next_retry_at: 'ASC' },
      });
      expect(result).toEqual([
        {
          tenantId: 'tenant-a',
          tenantName: 'Clinic A',
          invoiceId: 'inv1',
          subscriptionId: 'sub-a',
          amount: '99.00',
          retryCount: 2,
          nextRetryAt: new Date('2026-09-01T00:00:00.000Z'),
        },
        {
          tenantId: 'tenant-b',
          tenantName: 'Clinic B',
          invoiceId: 'inv2',
          subscriptionId: 'sub-b',
          amount: '49.00',
          retryCount: 1,
          nextRetryAt: new Date('2026-09-05T00:00:00.000Z'),
        },
      ]);
    });

    it('never confuses an ordinary decline with a tokenization decline — the query filters on the exact failure_class', async () => {
      invoices.find.mockResolvedValueOnce([]);
      const result = await service.listTokenizationDeclines();
      expect(result).toEqual([]);
      expect(tenants.find).not.toHaveBeenCalled();
    });
  });

  it('getSummary aggregates invoices by status', async () => {
    const qb = createMockQueryBuilder();
    qb.getRawMany.mockResolvedValueOnce([
      { status: InvoiceStatus.PAID, count: '2', total: '200' },
      { status: InvoiceStatus.OPEN, count: '1', total: '50' },
    ]);
    invoices.createQueryBuilder.mockReturnValueOnce(qb);
    const summary = await service.getSummary(TENANT);
    expect(summary.totalInvoices).toBe(3);
    expect(summary.totalPaid).toBe(200);
    expect(summary.totalOutstanding).toBe(50);
  });
});
