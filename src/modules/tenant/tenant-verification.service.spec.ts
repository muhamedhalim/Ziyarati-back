import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { TenantVerificationService } from './tenant-verification.service';
import { TenantVerificationDocument } from '../../entities/SaaS-Core/TenantVerificationDocument';
import { TenantApprovalStatus, VerificationDocStatus } from '../../entities/enums';
import { TenantService } from './tenant.service';
import { StorageService } from '../storage/storage.service';
import { VerificationAuditService } from '../verification-audit/verification-audit.service';
import { AdminNotificationService } from '../admin-notifications/admin-notification.service';
import { REQUIRED_DOC_TYPES } from './verification.constants';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

// REQUIRED_DOC_TYPES = ['commercial_registration', 'national_id', 'license']
const [TYPE_A, TYPE_B, TYPE_C] = REQUIRED_DOC_TYPES;

function doc(type: string, status: VerificationDocStatus) {
  return { doc_type: type, status };
}

describe('TenantVerificationService', () => {
  let service: TenantVerificationService;
  let documents: MockRepository;
  let tenantService: {
    findById: jest.Mock;
    markPendingApproval: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let adminNotifications: { create: jest.Mock };

  beforeEach(async () => {
    documents = createMockRepository();
    tenantService = {
      findById: jest.fn(),
      markPendingApproval: jest.fn(async (id: string) => ({
        id,
        approval_status: TenantApprovalStatus.PENDING_APPROVAL,
      })),
    };
    audit = { record: jest.fn(async () => undefined) };
    adminNotifications = { create: jest.fn(async () => undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TenantVerificationService,
        {
          provide: getRepositoryToken(TenantVerificationDocument),
          useValue: documents,
        },
        { provide: TenantService, useValue: tenantService },
        { provide: StorageService, useValue: {} },
        { provide: VerificationAuditService, useValue: audit },
        { provide: AdminNotificationService, useValue: adminNotifications },
      ],
    }).compile();

    service = moduleRef.get(TenantVerificationService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─────────────────────────── assertReadyForApproval ─────────────────────── //

  describe('assertReadyForApproval', () => {
    it('rejects when some required documents are missing', async () => {
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.APPROVED),
        // TYPE_B, TYPE_C never submitted
      ]);

      await expect(service.assertReadyForApproval('tenant-1')).rejects.toMatchObject(
        { code: ErrorCode.BAD_REQUEST },
      );
    });

    it('rejects when a required document is still PENDING', async () => {
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.APPROVED),
        doc(TYPE_B, VerificationDocStatus.PENDING),
        doc(TYPE_C, VerificationDocStatus.APPROVED),
      ]);

      await expect(
        service.assertReadyForApproval('tenant-1'),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('rejects when a required document was REJECTED', async () => {
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.APPROVED),
        doc(TYPE_B, VerificationDocStatus.REJECTED),
        doc(TYPE_C, VerificationDocStatus.APPROVED),
      ]);

      await expect(
        service.assertReadyForApproval('tenant-1'),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('resolves when every required document is APPROVED', async () => {
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.APPROVED),
        doc(TYPE_B, VerificationDocStatus.APPROVED),
        doc(TYPE_C, VerificationDocStatus.APPROVED),
      ]);

      await expect(
        service.assertReadyForApproval('tenant-1'),
      ).resolves.toBeUndefined();
    });

    it('rejects when no documents exist at all', async () => {
      documents.find.mockResolvedValueOnce([]);

      await expect(service.assertReadyForApproval('tenant-1')).rejects.toMatchObject(
        { code: ErrorCode.BAD_REQUEST },
      );
    });
  });

  // ─────────────────────────── review() → auto-advance ─────────────────────── //

  describe('review() auto-advance to PENDING_APPROVAL', () => {
    const baseDoc = {
      id: 'doc-1',
      doc_type: TYPE_A,
      tenant: { id: 'tenant-1' },
    };

    function mockReviewTarget(docType: string) {
      documents.findOne.mockResolvedValueOnce({
        ...baseDoc,
        doc_type: docType,
      });
    }

    it('does not advance the tenant when a required type is still missing', async () => {
      tenantService.findById.mockResolvedValue({
        id: 'tenant-1',
        approval_status: TenantApprovalStatus.PENDING_VERIFICATION,
      });
      mockReviewTarget(TYPE_A);
      // Only TYPE_A exists post-review; TYPE_B/TYPE_C were never uploaded, so
      // there is nothing PENDING (empty set), but required types are missing.
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.APPROVED),
      ]);
      documents.exists.mockResolvedValueOnce(false);

      await service.review('doc-1', { id: 'admin-1' } as any, {
        status: VerificationDocStatus.APPROVED,
      } as any);

      expect(tenantService.markPendingApproval).not.toHaveBeenCalled();
    });

    it('does not advance when all present required documents are REJECTED but a required type is entirely missing', async () => {
      tenantService.findById.mockResolvedValue({
        id: 'tenant-1',
        approval_status: TenantApprovalStatus.PENDING_VERIFICATION,
      });
      mockReviewTarget(TYPE_A);
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.REJECTED),
        // TYPE_B, TYPE_C missing entirely
      ]);
      documents.exists.mockResolvedValueOnce(false);

      await service.review('doc-1', { id: 'admin-1' } as any, {
        status: VerificationDocStatus.REJECTED,
      } as any);

      expect(tenantService.markPendingApproval).not.toHaveBeenCalled();
    });

    it('advances once every required type is present and none are PENDING (even if REJECTED)', async () => {
      tenantService.findById.mockResolvedValue({
        id: 'tenant-1',
        approval_status: TenantApprovalStatus.PENDING_VERIFICATION,
      });
      mockReviewTarget(TYPE_B);
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.APPROVED),
        doc(TYPE_B, VerificationDocStatus.REJECTED),
        doc(TYPE_C, VerificationDocStatus.APPROVED),
      ]);
      documents.exists.mockResolvedValueOnce(false); // no PENDING remaining

      await service.review('doc-1', { id: 'admin-1' } as any, {
        status: VerificationDocStatus.REJECTED,
      } as any);

      expect(tenantService.markPendingApproval).toHaveBeenCalledWith(
        'tenant-1',
        'admin-1',
      );
    });

    it('does not advance while a required document remains PENDING', async () => {
      tenantService.findById.mockResolvedValue({
        id: 'tenant-1',
        approval_status: TenantApprovalStatus.PENDING_VERIFICATION,
      });
      mockReviewTarget(TYPE_A);
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.APPROVED),
        doc(TYPE_B, VerificationDocStatus.PENDING),
        doc(TYPE_C, VerificationDocStatus.APPROVED),
      ]);
      documents.exists.mockResolvedValueOnce(true); // TYPE_B still pending

      await service.review('doc-1', { id: 'admin-1' } as any, {
        status: VerificationDocStatus.APPROVED,
      } as any);

      expect(tenantService.markPendingApproval).not.toHaveBeenCalled();
    });

    it('never advances when there are no documents at all', async () => {
      tenantService.findById.mockResolvedValue({
        id: 'tenant-1',
        approval_status: TenantApprovalStatus.PENDING_VERIFICATION,
      });
      mockReviewTarget(TYPE_A);
      documents.find.mockResolvedValueOnce([]); // nothing on file
      documents.exists.mockResolvedValueOnce(false);

      await service.review('doc-1', { id: 'admin-1' } as any, {
        status: VerificationDocStatus.APPROVED,
      } as any);

      expect(tenantService.markPendingApproval).not.toHaveBeenCalled();
    });

    it('does not re-attempt the transition once the tenant has already left PENDING_VERIFICATION', async () => {
      // Simulates the second of two concurrent reviews landing after the
      // first one already advanced the tenant.
      tenantService.findById.mockResolvedValue({
        id: 'tenant-1',
        approval_status: TenantApprovalStatus.PENDING_APPROVAL,
      });
      mockReviewTarget(TYPE_C);

      await service.review('doc-1', { id: 'admin-1' } as any, {
        status: VerificationDocStatus.APPROVED,
      } as any);

      expect(tenantService.markPendingApproval).not.toHaveBeenCalled();
      // Guard returns before ever touching document status/count.
      expect(documents.find).not.toHaveBeenCalled();
    });

    it('two simultaneous reviews of the last two documents: only the call that observes full completion advances the tenant', async () => {
      // Reviewer 1 reviews TYPE_B while TYPE_C is still PENDING (concurrent
      // reviewer 2 hasn't committed yet) — must NOT advance.
      tenantService.findById.mockResolvedValueOnce({
        id: 'tenant-1',
        approval_status: TenantApprovalStatus.PENDING_VERIFICATION,
      });
      mockReviewTarget(TYPE_B);
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.APPROVED),
        doc(TYPE_B, VerificationDocStatus.APPROVED),
        doc(TYPE_C, VerificationDocStatus.PENDING),
      ]);
      documents.exists.mockResolvedValueOnce(true);

      await service.review('doc-b', { id: 'admin-1' } as any, {
        status: VerificationDocStatus.APPROVED,
      } as any);
      expect(tenantService.markPendingApproval).not.toHaveBeenCalled();

      // Reviewer 2 reviews TYPE_C after reviewer 1's write has landed — must
      // advance exactly once.
      tenantService.findById.mockResolvedValueOnce({
        id: 'tenant-1',
        approval_status: TenantApprovalStatus.PENDING_VERIFICATION,
      });
      mockReviewTarget(TYPE_C);
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.APPROVED),
        doc(TYPE_B, VerificationDocStatus.APPROVED),
        doc(TYPE_C, VerificationDocStatus.APPROVED),
      ]);
      documents.exists.mockResolvedValueOnce(false);

      await service.review('doc-c', { id: 'admin-2' } as any, {
        status: VerificationDocStatus.APPROVED,
      } as any);

      expect(tenantService.markPendingApproval).toHaveBeenCalledTimes(1);
      expect(tenantService.markPendingApproval).toHaveBeenCalledWith(
        'tenant-1',
        'admin-2',
      );
    });

    it('swallows an invalid-transition error from a redundant concurrent advance attempt', async () => {
      tenantService.findById.mockResolvedValue({
        id: 'tenant-1',
        approval_status: TenantApprovalStatus.PENDING_VERIFICATION,
      });
      mockReviewTarget(TYPE_A);
      documents.find.mockResolvedValueOnce([
        doc(TYPE_A, VerificationDocStatus.APPROVED),
        doc(TYPE_B, VerificationDocStatus.APPROVED),
        doc(TYPE_C, VerificationDocStatus.APPROVED),
      ]);
      documents.exists.mockResolvedValueOnce(false);
      tenantService.markPendingApproval.mockRejectedValueOnce(
        new Error('Invalid transition: PENDING_APPROVAL -> PENDING_APPROVAL'),
      );

      // review() must not throw even though the underlying transition failed.
      await expect(
        service.review('doc-1', { id: 'admin-1' } as any, {
          status: VerificationDocStatus.APPROVED,
        } as any),
      ).resolves.toBeDefined();
    });
  });
});
