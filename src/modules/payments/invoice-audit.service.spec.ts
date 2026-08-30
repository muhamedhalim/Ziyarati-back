import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  InvoiceAuditService,
  INVOICE_AUDIT_ACTION,
} from './invoice-audit.service';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('InvoiceAuditService (T097 — FR-I014)', () => {
  let service: InvoiceAuditService;
  let auditLogs: MockRepository;

  beforeEach(async () => {
    auditLogs = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceAuditService,
        { provide: getRepositoryToken(AuditLog), useValue: auditLogs },
      ],
    }).compile();
    service = moduleRef.get(InvoiceAuditService);
  });

  afterEach(() => jest.clearAllMocks());

  it('records a download with the invoice id and the acting user', async () => {
    await service.record(
      INVOICE_AUDIT_ACTION.DOCUMENT_DOWNLOADED,
      'tenant-1',
      'inv-1',
      'user-1',
    );
    expect(auditLogs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: { id: 'tenant-1' },
        user: { id: 'user-1' },
        action: 'invoice.document_downloaded',
        entity_type: 'Invoice',
        entity_id: 'inv-1',
      }),
    );
  });

  it('is best-effort — a write failure never throws to the caller', async () => {
    auditLogs.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record(
        INVOICE_AUDIT_ACTION.DOCUMENT_DOWNLOADED,
        'tenant-1',
        'inv-1',
      ),
    ).resolves.toBeUndefined();
  });
});
