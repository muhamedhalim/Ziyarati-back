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
import { InvoiceStatus } from '../../entities/enums';
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
  let payment: { charge: jest.Mock };
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let claimQb: MockQueryBuilder;

  const lockedRepo = () =>
    manager.getRepository(SubscriptionInvoice) as unknown as MockRepository;

  beforeEach(async () => {
    invoices = createMockRepository();
    tenants = createMockRepository();
    payment = { charge: jest.fn() };
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
    it('claims the invoice, charges the provider, and finalizes PAID with the provider reference', async () => {
      claimQb.execute.mockResolvedValueOnce({ affected: 1, raw: [] });
      invoices.findOne.mockResolvedValueOnce({
        id: 'inv1',
        status: InvoiceStatus.OPEN,
        amount: '100',
        currency: 'SAR',
      });
      payment.charge.mockResolvedValueOnce({
        success: true,
        reference: 'gw-ref-1',
      });
      lockedRepo().findOne.mockResolvedValueOnce({
        id: 'inv1',
        status: InvoiceStatus.OPEN,
        amount: '100',
      });

      const res = await service.payInvoice(TENANT, 'inv1');
      expect(res.status).toBe(InvoiceStatus.PAID);
      expect(res.paid_at).toBeInstanceOf(Date);
      expect(res.provider_reference).toBe('gw-ref-1');
      // T079/T081 — the charge uses the INVOICE's own currency (snapshotted
      // at issue time from the platform default), never a hardcoded value.
      expect(payment.charge).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'SAR' }),
      );
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
      });
      expect(payment.charge).not.toHaveBeenCalled();
    });

    it('surfaces a provider decline as 422, records the reason, and releases the claim', async () => {
      claimQb.execute.mockResolvedValueOnce({ affected: 1, raw: [] });
      invoices.findOne.mockResolvedValueOnce({
        id: 'inv1',
        status: InvoiceStatus.OPEN,
        amount: '100',
      });
      payment.charge.mockResolvedValueOnce({
        success: false,
        failureReason: 'card declined',
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
      expect(locked.charge_started_at).toBeNull();
      expect(lockedRepo().save).toHaveBeenCalledWith(locked);
    });

    it('is idempotent: an invoice already PAID at finalize is returned untouched', async () => {
      claimQb.execute.mockResolvedValueOnce({ affected: 1, raw: [] });
      invoices.findOne.mockResolvedValueOnce({
        id: 'inv1',
        status: InvoiceStatus.OPEN,
        amount: '100',
      });
      payment.charge.mockResolvedValueOnce({
        success: true,
        reference: 'gw-ref-2',
      });
      const alreadyPaid = {
        id: 'inv1',
        status: InvoiceStatus.PAID,
        provider_reference: 'gw-ref-1',
      };
      lockedRepo().findOne.mockResolvedValueOnce(alreadyPaid);

      const res = await service.payInvoice(TENANT, 'inv1');
      expect(res).toBe(alreadyPaid);
      expect(lockedRepo().save).not.toHaveBeenCalled();
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
