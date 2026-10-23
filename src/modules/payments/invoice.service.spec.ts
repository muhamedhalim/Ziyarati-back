import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { InvoiceService } from './invoice.service';
import { InvoiceItemService } from './invoice-item.service';
import { Invoice } from '../../entities/Payments/Invoice';
import { Customer } from '../../entities/CRM/Customer';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { InvoiceStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import { QueueService } from '../../queue/queue.service';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';

describe('InvoiceService — currency snapshot (T093, FR-I005)', () => {
  let service: InvoiceService;
  let invoices: MockRepository;
  let tenantSettings: MockRepository;
  let itemsService: {
    addItems: jest.Mock;
    recalcTotal: jest.Mock;
    listForInvoice: jest.Mock;
  };
  let dataSource: MockDataSource;
  let manager: MockEntityManager;

  const invoiceRepoInTx = () =>
    manager.getRepository(Invoice) as unknown as MockRepository;
  const settingsRepoInTx = () =>
    manager.getRepository(TenantSetting) as unknown as MockRepository;

  beforeEach(async () => {
    invoices = createMockRepository();
    tenantSettings = createMockRepository();
    itemsService = {
      addItems: jest.fn(),
      recalcTotal: jest.fn(),
      listForInvoice: jest.fn().mockResolvedValue([]),
    };
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceService,
        { provide: getRepositoryToken(Invoice), useValue: invoices },
        {
          provide: getRepositoryToken(TenantSetting),
          useValue: tenantSettings,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: InvoiceItemService, useValue: itemsService },
        {
          provide: QueueService,
          useValue: {
            enqueueAnalyticsInvoiceDocument: jest
              .fn()
              .mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(InvoiceService);
  });

  afterEach(() => jest.clearAllMocks());

  it("snapshots the tenant's CURRENT currency onto a new invoice at creation", async () => {
    settingsRepoInTx().findOne.mockResolvedValueOnce({ currency: 'SAR' });
    invoiceRepoInTx().save.mockImplementationOnce(async (i: any) => ({
      ...i,
      id: 'inv-1',
    }));
    invoices.findOne.mockResolvedValueOnce({
      id: 'inv-1',
      status: InvoiceStatus.DRAFT,
      currency: 'SAR',
    });

    await service.create(TENANT, {});

    expect(invoiceRepoInTx().save).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'SAR' }),
    );
  });

  it('a later change to tenant_settings.currency never rewrites an already-created invoice', async () => {
    settingsRepoInTx().findOne.mockResolvedValueOnce({ currency: 'SAR' });
    invoiceRepoInTx().save.mockImplementationOnce(async (i: any) => ({
      ...i,
      id: 'inv-1',
    }));
    invoices.findOne.mockResolvedValueOnce({
      id: 'inv-1',
      status: InvoiceStatus.DRAFT,
      currency: 'SAR',
    });
    await service.create(TENANT, {});

    // The setting changes AFTER the invoice was created — a re-read of the
    // SAME invoice must still report its originally snapshotted currency,
    // never the tenant's now-current one.
    invoices.findOne.mockResolvedValueOnce({
      id: 'inv-1',
      status: InvoiceStatus.DRAFT,
      currency: 'SAR',
    });
    const reloaded = await service.getOne(TENANT, 'inv-1');
    expect(reloaded.currency).toBe('SAR');
    expect(settingsRepoInTx().findOne).toHaveBeenCalledTimes(1); // never re-read on a later get
  });

  describe('document render triggering (T095/T096)', () => {
    let queue: { enqueueAnalyticsInvoiceDocument: jest.Mock };
    let moduleRef: TestingModule;

    beforeEach(async () => {
      queue = {
        enqueueAnalyticsInvoiceDocument: jest.fn().mockResolvedValue(undefined),
      };
      moduleRef = await Test.createTestingModule({
        providers: [
          InvoiceService,
          { provide: getRepositoryToken(Invoice), useValue: invoices },
          {
            provide: getRepositoryToken(TenantSetting),
            useValue: tenantSettings,
          },
          { provide: DataSource, useValue: dataSource },
          { provide: InvoiceItemService, useValue: itemsService },
          { provide: QueueService, useValue: queue },
        ],
      }).compile();
      service = moduleRef.get(InvoiceService);
    });

    it('finalize() bumps document_version to 1 and enqueues a render for that version', async () => {
      const invoice = {
        id: 'inv-1',
        status: InvoiceStatus.DRAFT,
        document_version: 0,
      };
      invoices.findOne.mockResolvedValueOnce(invoice);
      invoices.save.mockImplementation(async (i: any) => i);
      invoices.findOne.mockResolvedValueOnce({
        ...invoice,
        status: InvoiceStatus.OPEN,
        document_version: 1,
      });

      await service.finalize(TENANT, 'inv-1');

      expect(invoice.document_version).toBe(1);
      expect(queue.enqueueAnalyticsInvoiceDocument).toHaveBeenCalledWith({
        tenantId: TENANT,
        invoiceId: 'inv-1',
        documentVersion: 1,
      });
    });

    it('regenerateDocument() bumps the version again and re-enqueues', async () => {
      const invoice = {
        id: 'inv-1',
        status: InvoiceStatus.OPEN,
        document_version: 1,
      };
      invoices.findOne.mockResolvedValueOnce(invoice);
      invoices.save.mockImplementation(async (i: any) => i);
      invoices.findOne.mockResolvedValueOnce({
        ...invoice,
        document_version: 2,
      });

      await service.regenerateDocument(TENANT, 'inv-1');

      expect(invoice.document_version).toBe(2);
      expect(queue.enqueueAnalyticsInvoiceDocument).toHaveBeenCalledWith({
        tenantId: TENANT,
        invoiceId: 'inv-1',
        documentVersion: 2,
      });
    });

    it('regenerateDocument() rejects a DRAFT invoice (nothing to regenerate)', async () => {
      invoices.findOne.mockResolvedValueOnce({
        id: 'inv-1',
        status: InvoiceStatus.DRAFT,
        document_version: 0,
      });
      await expect(
        service.regenerateDocument(TENANT, 'inv-1'),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(queue.enqueueAnalyticsInvoiceDocument).not.toHaveBeenCalled();
    });

    it('getDocumentState() reports draft/pending/ready correctly', async () => {
      invoices.findOne.mockResolvedValueOnce({
        status: InvoiceStatus.DRAFT,
      });
      await expect(service.getDocumentState(TENANT, 'x')).resolves.toEqual({
        state: 'draft',
      });

      invoices.findOne.mockResolvedValueOnce({
        status: InvoiceStatus.OPEN,
        document_version: 2,
        document_rendered_version: 1,
        document_key: 'old-key',
      });
      await expect(service.getDocumentState(TENANT, 'x')).resolves.toEqual({
        state: 'pending',
      });

      invoices.findOne.mockResolvedValueOnce({
        status: InvoiceStatus.OPEN,
        document_version: 2,
        document_rendered_version: 2,
        document_key: 'current-key',
      });
      await expect(service.getDocumentState(TENANT, 'x')).resolves.toEqual({
        state: 'ready',
        documentKey: 'current-key',
      });
    });
  });

  describe('create() - foreign ids (CR-38)', () => {
    const repoInTx = (e: unknown) => manager.getRepository(e as never) as unknown as MockRepository;

    it('refuses a customer that belongs to another tenant and creates nothing', async () => {
      repoInTx(Customer).count.mockResolvedValueOnce(0);

      await expect(
        service.create(TENANT, { customerId: '00000000-0000-4000-8000-0000000000aa' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });

      expect(repoInTx(Customer).count).toHaveBeenCalledWith({
        where: { id: '00000000-0000-4000-8000-0000000000aa', tenant: { id: TENANT } },
      });
      expect(invoiceRepoInTx().save).not.toHaveBeenCalled();
    });

    it('refuses an appointment that belongs to another tenant and creates nothing', async () => {
      repoInTx(Appointment).count.mockResolvedValueOnce(0);

      await expect(
        service.create(TENANT, { appointmentId: '00000000-0000-4000-8000-0000000000bb' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });

      expect(repoInTx(Appointment).count).toHaveBeenCalledWith({
        where: { id: '00000000-0000-4000-8000-0000000000bb', tenant: { id: TENANT } },
      });
      expect(invoiceRepoInTx().save).not.toHaveBeenCalled();
    });

    it('accepts a customer and appointment that belong to the caller tenant', async () => {
      repoInTx(Customer).count.mockResolvedValueOnce(1);
      repoInTx(Appointment).count.mockResolvedValueOnce(1);
      settingsRepoInTx().findOne.mockResolvedValueOnce({ currency: 'SAR' });
      invoiceRepoInTx().save.mockImplementationOnce(async (i: any) => ({ ...i, id: 'inv-9' }));
      invoices.findOne.mockResolvedValueOnce({ id: 'inv-9', status: InvoiceStatus.DRAFT, currency: 'SAR' });

      await service.create(TENANT, {
        customerId: '00000000-0000-4000-8000-0000000000aa',
        appointmentId: '00000000-0000-4000-8000-0000000000bb',
      } as any);

      expect(invoiceRepoInTx().save).toHaveBeenCalled();
    });
  });

  it('falls back to USD when the tenant has no tenant_settings row yet', async () => {
    settingsRepoInTx().findOne.mockResolvedValueOnce(null);
    invoiceRepoInTx().save.mockImplementationOnce(async (i: any) => ({
      ...i,
      id: 'inv-2',
    }));
    invoices.findOne.mockResolvedValueOnce({
      id: 'inv-2',
      status: InvoiceStatus.DRAFT,
      currency: 'USD',
    });

    await service.create(TENANT, {});

    expect(invoiceRepoInTx().save).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD' }),
    );
  });
});
