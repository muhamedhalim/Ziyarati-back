import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { InvoiceDocumentService } from './invoice-document.service';
import { InvoiceItemService } from './invoice-item.service';
import { Invoice } from '../../entities/Payments/Invoice';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { InvoiceStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';

/**
 * T091 (spec 014, US12) — pins FR-I002's field list and the currency
 * snapshot's immutability (FR-I005). Written before T094/T095's
 * template/worker wiring exist, per the TDD ordering the task calls for.
 */
describe('InvoiceDocumentService (T091 — FR-I002, FR-I005, FR-I007, FR-I008)', () => {
  let service: InvoiceDocumentService;
  let invoices: MockRepository;
  let tenantSettings: MockRepository;
  let itemsService: { listForInvoice: jest.Mock };

  const finalizedInvoice = (overrides: Record<string, unknown> = {}) => ({
    id: 'inv-1',
    invoice_number: 'INV-2026-000001',
    status: InvoiceStatus.OPEN,
    issued_at: new Date('2026-01-15T00:00:00.000Z'),
    created_at: new Date('2026-01-10T00:00:00.000Z'),
    currency: 'SAR',
    total_amount: 215.72,
    tenant: {
      id: TENANT,
      name: 'Ziyarati Clinic',
      legal_name: 'Ziyarati Medical Co.',
      commercial_registration_number: 'CR-12345',
      contact_email: 'clinic@example.test',
      contact_phone: '+966500000000',
    },
    customer: {
      full_name: 'محمد العتيبي',
      phone: '+966511111111',
      email: 'patient@example.test',
    },
    ...overrides,
  });

  beforeEach(async () => {
    invoices = createMockRepository();
    tenantSettings = createMockRepository();
    itemsService = { listForInvoice: jest.fn().mockResolvedValue([]) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceDocumentService,
        { provide: getRepositoryToken(Invoice), useValue: invoices },
        {
          provide: getRepositoryToken(TenantSetting),
          useValue: tenantSettings,
        },
        { provide: InvoiceItemService, useValue: itemsService },
      ],
    }).compile();
    service = moduleRef.get(InvoiceDocumentService);
  });

  afterEach(() => jest.clearAllMocks());

  it('assembles every FR-I002 field: clinic identity, patient identity, number, issue date, items, total, currency, status', async () => {
    invoices.findOne.mockResolvedValueOnce(finalizedInvoice());
    itemsService.listForInvoice.mockResolvedValueOnce([
      {
        description: 'Consultation',
        quantity: 1,
        unit_price: 150,
        total_price: 150,
      },
      {
        description: 'X-Ray',
        quantity: 1,
        unit_price: 65.72,
        total_price: 65.72,
      },
    ]);

    const data = await service.buildDocumentData(TENANT, 'inv-1');

    expect(data.clinic).toEqual({
      name: 'Ziyarati Clinic',
      legalName: 'Ziyarati Medical Co.',
      registrationNumber: 'CR-12345',
      contactEmail: 'clinic@example.test',
      contactPhone: '+966500000000',
    });
    expect(data.patient).toEqual({
      name: 'محمد العتيبي',
      phone: '+966511111111',
      email: 'patient@example.test',
    });
    expect(data.invoiceNumber).toBe('INV-2026-000001');
    expect(data.issuedAt).toBe('2026-01-15T00:00:00.000Z');
    expect(data.currency).toBe('SAR');
    expect(data.status).toBe(InvoiceStatus.OPEN);
    expect(data.items).toEqual([
      {
        description: 'Consultation',
        quantity: 1,
        unitPrice: 150,
        lineTotal: 150,
      },
      { description: 'X-Ray', quantity: 1, unitPrice: 65.72, lineTotal: 65.72 },
    ]);
    expect(data.total).toBe(215.72);
  });

  it("uses the INVOICE's own snapshotted currency, never re-reading the tenant's current setting (FR-I005)", async () => {
    // The invoice was issued at SAR; the tenant's setting has since moved to
    // USD — the mock repo simply never being asked for tenant_settings at
    // all proves this reads only `invoice.currency`.
    invoices.findOne.mockResolvedValueOnce(
      finalizedInvoice({ currency: 'SAR' }),
    );
    const data = await service.buildDocumentData(TENANT, 'inv-1');
    expect(data.currency).toBe('SAR');
  });

  it('refuses a DRAFT invoice with 409 (FR-I007)', async () => {
    invoices.findOne.mockResolvedValueOnce(
      finalizedInvoice({ status: InvoiceStatus.DRAFT }),
    );
    await expect(
      service.buildDocumentData(TENANT, 'inv-1'),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it("a foreign tenant's invoice is indistinguishable from a non-existent one — 404, never leaked (FR-I008)", async () => {
    invoices.findOne.mockResolvedValueOnce(null);
    await expect(
      service.buildDocumentData(TENANT, 'someone-elses-invoice'),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(invoices.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'someone-elses-invoice', tenant: { id: TENANT } },
      }),
    );
  });

  it('produces no discount or tax field — none is recorded, none is invented (FR-I006)', async () => {
    invoices.findOne.mockResolvedValueOnce(finalizedInvoice());
    const data = await service.buildDocumentData(TENANT, 'inv-1');
    expect(data).not.toHaveProperty('tax');
    expect(data).not.toHaveProperty('discount');
  });

  describe('markRendered (T095 — never regresses a newer already-rendered version)', () => {
    it('updates document_key and document_rendered_version, guarded by version', async () => {
      const qb = createMockQueryBuilder();
      invoices.createQueryBuilder.mockReturnValueOnce(qb);

      await service.markRendered(TENANT, 'inv-1', 2, 'tenant-1/invoices/x.pdf');

      expect(qb.set).toHaveBeenCalledWith({
        document_key: 'tenant-1/invoices/x.pdf',
        document_rendered_version: 2,
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('document_rendered_version <='),
        { documentVersion: 2 },
      );
      expect(qb.execute).toHaveBeenCalled();
    });
  });

  describe('localeFor (FR-I011)', () => {
    it("returns the tenant's configured document language", async () => {
      tenantSettings.findOne.mockResolvedValueOnce({ default_language: 'en' });
      await expect(service.localeFor(TENANT)).resolves.toBe('en');
    });

    it('defaults to Arabic when the tenant has no settings row or an unrecognized value', async () => {
      tenantSettings.findOne.mockResolvedValueOnce(null);
      await expect(service.localeFor(TENANT)).resolves.toBe('ar');
    });
  });

  it('handles a walk-in invoice with no linked customer (patient is null, not a crash)', async () => {
    invoices.findOne.mockResolvedValueOnce(
      finalizedInvoice({ customer: undefined }),
    );
    const data = await service.buildDocumentData(TENANT, 'inv-1');
    expect(data.patient).toBeNull();
  });
});
