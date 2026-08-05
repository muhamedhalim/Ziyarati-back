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

  // ─────────────────────────────── review() ────────────────────────────────── //
  //
  // NOTE (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.11): this file
  // used to have a large "review() auto-advance to PENDING_APPROVAL" suite
  // here, covering a `maybeAdvanceToPendingApproval` private method that
  // called `tenantService.markPendingApproval` directly from `review()`. That
  // method was deliberately REMOVED in commit 57c0eac ("update", 2026-07-21),
  // which replaced it with the stricter `assertReadyForApproval` gate above
  // (checks every required doc is actually APPROVED, not just present) — a
  // real, intentional redesign, confirmed via `git show 57c0eac`. The
  // auto-advance tests were never deleted alongside it: several (asserting
  // `markPendingApproval` WAS called) failed outright, and the rest
  // (asserting it was NOT called) passed only vacuously, since `review()`
  // never touches `tenantService` at all anymore. Removed rather than
  // resurrecting dead functionality to make stale tests pass.

  describe('review()', () => {
    it('updates the document status and records an audit entry, without touching tenant approval state', async () => {
      documents.findOne.mockResolvedValueOnce({
        id: 'doc-1',
        doc_type: TYPE_A,
        tenant: { id: 'tenant-1' },
        status: VerificationDocStatus.PENDING,
      });

      const saved = await service.review('doc-1', { id: 'admin-1' } as any, {
        status: VerificationDocStatus.APPROVED,
      } as any);

      expect(saved.status).toBe(VerificationDocStatus.APPROVED);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'APPROVED', documentId: 'doc-1' }),
      );
      expect(tenantService.markPendingApproval).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND for an unknown document id', async () => {
      documents.findOne.mockResolvedValueOnce(null);

      await expect(
        service.review('missing', { id: 'admin-1' } as any, {
          status: VerificationDocStatus.APPROVED,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    // ── GAP-001 — re-deciding an already-decided document ──────────────────
    describe('GAP-001 — refuses a re-decision on an already-decided document', () => {
      it('refuses to re-decide an already-APPROVED document, and audits the attempt', async () => {
        documents.findOne.mockResolvedValueOnce({
          id: 'doc-1',
          doc_type: TYPE_A,
          tenant: { id: 'tenant-1' },
          status: VerificationDocStatus.APPROVED,
        });

        await expect(
          service.review('doc-1', { id: 'admin-1' } as any, {
            status: VerificationDocStatus.REJECTED,
          } as any),
        ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });

        expect(documents.save).not.toHaveBeenCalled();
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'RE_DECISION_REFUSED',
            documentId: 'doc-1',
            tenantId: 'tenant-1',
          }),
        );
      });

      it('refuses to re-decide an already-REJECTED document (not just APPROVED → * )', async () => {
        documents.findOne.mockResolvedValueOnce({
          id: 'doc-2',
          doc_type: TYPE_B,
          tenant: { id: 'tenant-1' },
          status: VerificationDocStatus.REJECTED,
        });

        await expect(
          service.review('doc-2', { id: 'admin-1' } as any, {
            status: VerificationDocStatus.APPROVED,
          } as any),
        ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
        expect(documents.save).not.toHaveBeenCalled();
      });

      it('still allows deciding a genuinely PENDING document (the guard is not overly broad)', async () => {
        documents.findOne.mockResolvedValueOnce({
          id: 'doc-3',
          doc_type: TYPE_C,
          tenant: { id: 'tenant-1' },
          status: VerificationDocStatus.PENDING,
        });
        documents.save.mockImplementationOnce(async (d: unknown) => d);

        const saved = await service.review('doc-3', { id: 'admin-1' } as any, {
          status: VerificationDocStatus.APPROVED,
        } as any);
        expect(saved.status).toBe(VerificationDocStatus.APPROVED);
      });
    });
  });
});
