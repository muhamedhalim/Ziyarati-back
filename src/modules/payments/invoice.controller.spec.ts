import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';
import { InvoiceAuditService } from './invoice-audit.service';
import { StorageService } from '../storage/storage.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ErrorCode } from '../../common/errors';

const TENANT = 'tenant-1';

/**
 * T096 (spec 014, US12) — the document routes' state machine (200 ready /
 * 202 pending / 409 draft) and T097's download audit.
 */
describe('InvoiceController — document routes (T096, T097)', () => {
  let controller: InvoiceController;
  let invoices: {
    getDocumentState: jest.Mock;
    regenerateDocument: jest.Mock;
  };
  let storage: { getSignedDownloadUrl: jest.Mock };
  let audit: { record: jest.Mock };
  let ctx: { requireTenantId: jest.Mock; getUser: jest.Mock };
  let res: { status: jest.Mock };

  beforeEach(() => {
    invoices = {
      getDocumentState: jest.fn(),
      regenerateDocument: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      getSignedDownloadUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example/x.pdf'),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    ctx = {
      requireTenantId: jest.fn().mockReturnValue(TENANT),
      getUser: jest.fn().mockReturnValue({ id: 'user-1' }),
    };
    res = { status: jest.fn() };
    controller = new InvoiceController(
      invoices as unknown as InvoiceService,
      ctx as unknown as TenantContextService,
      storage as unknown as StorageService,
      audit as unknown as InvoiceAuditService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('returns a signed URL and records the download audit when ready', async () => {
    invoices.getDocumentState.mockResolvedValueOnce({
      state: 'ready',
      documentKey: 'tenant-1/invoices/x.pdf',
    });

    const result = await controller.getDocument('inv-1', res as any);

    expect(result).toEqual({
      status: 'ready',
      url: 'https://signed.example/x.pdf',
    });
    expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith(
      'tenant-1/invoices/x.pdf',
      TENANT,
    );
    expect(audit.record).toHaveBeenCalledWith(
      'invoice.document_downloaded',
      TENANT,
      'inv-1',
      'user-1',
    );
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 202 pending and never touches storage or the audit trail', async () => {
    invoices.getDocumentState.mockResolvedValueOnce({ state: 'pending' });

    const result = await controller.getDocument('inv-1', res as any);

    expect(result).toEqual({ status: 'pending' });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a DRAFT invoice with 409 (FR-I007)', async () => {
    invoices.getDocumentState.mockResolvedValueOnce({ state: 'draft' });

    await expect(
      controller.getDocument('inv-1', res as any),
    ).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
    expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('regenerateDocument delegates to the service and returns pending', async () => {
    const result = await controller.regenerateDocument('inv-1');
    expect(invoices.regenerateDocument).toHaveBeenCalledWith(TENANT, 'inv-1');
    expect(result).toEqual({ status: 'pending' });
  });
});
