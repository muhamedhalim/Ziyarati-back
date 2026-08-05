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
  let audit: { record: jest.Mock; listForTenant: jest.Mock };
  let adminNotifications: { create: jest.Mock };
  let storage: {
    assertKeyBelongsToTenant: jest.Mock;
    objectExists: jest.Mock;
    getSignedDownloadUrl: jest.Mock;
    deleteObject: jest.Mock;
    signedUrlTtlSeconds: number;
  };

  const TENANT_ID = 'tenant-1';
  const OTHER_TENANT_ID = 'tenant-2';

  beforeEach(async () => {
    documents = createMockRepository();
    tenantService = {
      findById: jest.fn(),
      markPendingApproval: jest.fn(async (id: string) => ({
        id,
        name: 'Al-Noor Clinic',
        approval_status: TenantApprovalStatus.PENDING_APPROVAL,
      })),
    };
    audit = { record: jest.fn(async () => undefined), listForTenant: jest.fn(async () => []) };
    adminNotifications = { create: jest.fn(async () => undefined) };
    storage = {
      assertKeyBelongsToTenant: jest.fn(),
      objectExists: jest.fn().mockResolvedValue(true),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://r2.example.com/signed?x=1'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      signedUrlTtlSeconds: 300,
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TenantVerificationService,
        {
          provide: getRepositoryToken(TenantVerificationDocument),
          useValue: documents,
        },
        { provide: TenantService, useValue: tenantService },
        { provide: StorageService, useValue: storage },
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

  // ─────────────────────────────── submit() (VER-001) ─────────────────────── //

  describe('submit (VER-001 — REQ-TEN-001)', () => {
    const actor = { id: 'owner-1', ip: '1.2.3.4', userAgent: 'jest' };

    it('rejects when neither storageKey nor fileUrl is provided', async () => {
      await expect(
        service.submit(TENANT_ID, actor, { docType: TYPE_A } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(documents.save).not.toHaveBeenCalled();
    });

    it('creates a new document via storageKey: validates tenant ownership + existence, records it PENDING, audits UPLOADED', async () => {
      documents.findOne.mockResolvedValueOnce(null); // no existing doc of this type
      documents.save.mockImplementationOnce(async (d: any) => ({ id: 'doc-new', ...d }));

      const created = await service.submit(TENANT_ID, actor, {
        docType: TYPE_A,
        storageKey: `${TENANT_ID}/cr.pdf`,
        sha256: 'abc123',
      } as any);

      expect(storage.assertKeyBelongsToTenant).toHaveBeenCalledWith(`${TENANT_ID}/cr.pdf`, TENANT_ID);
      expect(storage.objectExists).toHaveBeenCalledWith(`${TENANT_ID}/cr.pdf`);
      expect(created.status).toBe(VerificationDocStatus.PENDING);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID, action: 'UPLOADED', docType: TYPE_A, actor }),
      );
    });

    it('rejects when the storageKey object does not actually exist in storage', async () => {
      storage.objectExists.mockResolvedValueOnce(false);
      documents.findOne.mockResolvedValueOnce(null);

      await expect(
        service.submit(TENANT_ID, actor, { docType: TYPE_A, storageKey: 'missing.pdf' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(documents.save).not.toHaveBeenCalled();
    });

    it('a foreign storageKey (belongs to a different tenant) is rejected by the storage boundary check, not silently accepted', async () => {
      storage.assertKeyBelongsToTenant.mockImplementationOnce(() => {
        throw new Error('key does not belong to this tenant');
      });
      await expect(
        service.submit(TENANT_ID, actor, { docType: TYPE_A, storageKey: `${OTHER_TENANT_ID}/cr.pdf` } as any),
      ).rejects.toThrow();
      expect(documents.save).not.toHaveBeenCalled();
    });

    it('REPLACES an existing document of the same type (new content) and deletes the old R2 object, audits REPLACED', async () => {
      documents.findOne.mockResolvedValueOnce({
        id: 'doc-old', doc_type: TYPE_A, storage_key: 'old-key.pdf', content_hash: 'old-hash',
        status: VerificationDocStatus.APPROVED, tenant: { id: TENANT_ID },
      });
      documents.save.mockImplementationOnce(async (d: any) => d);

      const replaced = await service.submit(TENANT_ID, actor, {
        docType: TYPE_A, storageKey: 'new-key.pdf', sha256: 'new-hash',
      } as any);

      expect(replaced.status).toBe(VerificationDocStatus.PENDING); // re-submission resets review state
      expect(storage.deleteObject).toHaveBeenCalledWith('old-key.pdf', TENANT_ID);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'REPLACED', docType: TYPE_A }));
    });

    it('DEDUPES byte-identical re-upload (same sha256): reuses the existing object, discards the new one, does not delete anything', async () => {
      documents.findOne.mockResolvedValueOnce({
        id: 'doc-dup', doc_type: TYPE_A, storage_key: 'existing-key.pdf', content_hash: 'same-hash',
        status: VerificationDocStatus.APPROVED, tenant: { id: TENANT_ID },
      });
      documents.save.mockImplementationOnce(async (d: any) => d);

      const reused = await service.submit(TENANT_ID, actor, {
        docType: TYPE_A, storageKey: 'freshly-uploaded-duplicate.pdf', sha256: 'same-hash',
      } as any);

      expect(reused.status).toBe(VerificationDocStatus.PENDING);
      // The freshly-uploaded duplicate object is discarded (deleteObject called with the NEW key)...
      expect(storage.deleteObject).toHaveBeenCalledWith('freshly-uploaded-duplicate.pdf', TENANT_ID);
      // ...never the pre-existing, still-referenced object.
      expect(storage.deleteObject).not.toHaveBeenCalledWith('existing-key.pdf', TENANT_ID);
    });
  });

  // ────────────────────────── submitForReview() (VER-002) ──────────────────── //

  describe('submitForReview (VER-002 — REQ-TEN-002)', () => {
    const actor = { id: 'owner-1', ip: '1.2.3.4', userAgent: 'jest' };

    it('refuses (400) with the exact missing types when required documents are incomplete, and does NOT advance the tenant', async () => {
      documents.find.mockResolvedValueOnce([{ doc_type: TYPE_A }]); // only 1 of 3 required types present

      await expect(service.submitForReview(TENANT_ID, actor)).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
        publicContext: { missing: [TYPE_B, TYPE_C] },
      });
      expect(tenantService.markPendingApproval).not.toHaveBeenCalled();
      expect(adminNotifications.create).not.toHaveBeenCalled();
    });

    it('advances the tenant to PENDING_APPROVAL, notifies platform admins, and audits SUBMITTED once every required type is present', async () => {
      documents.find.mockResolvedValueOnce(REQUIRED_DOC_TYPES.map((t) => ({ doc_type: t })));

      const result = await service.submitForReview(TENANT_ID, actor);

      expect(result).toEqual({ status: TenantApprovalStatus.PENDING_APPROVAL, missing: [] });
      expect(tenantService.markPendingApproval).toHaveBeenCalledWith(TENANT_ID, actor.id);
      expect(adminNotifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'VERIFICATION_SUBMITTED', tenantId: TENANT_ID }),
      );
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID, action: 'SUBMITTED' }));
    });

    it('presence alone is sufficient here — a REJECTED or still-PENDING document still counts as "present" for submitForReview (that stricter approved-only gate is assertReadyForApproval\'s job, not this one\'s)', async () => {
      documents.find.mockResolvedValueOnce(REQUIRED_DOC_TYPES.map((t) => ({ doc_type: t })));
      const result = await service.submitForReview(TENANT_ID, actor);
      expect(result.missing).toEqual([]);
    });
  });

  // ─────────────────────── getFileUrl() (VER-003, ownership-scoped) ────────── //

  describe('getFileUrl (VER-003 — REQ-TEN-003, ownership-scoped)', () => {
    const actor = { id: 'owner-1', ip: '1.2.3.4', userAgent: 'jest' };

    it('returns a signed URL for the caller\'s OWN tenant\'s document and audits VIEWED', async () => {
      documents.findOne.mockResolvedValueOnce({
        id: 'doc-1', doc_type: TYPE_A, storage_key: 'k.pdf', tenant: { id: TENANT_ID },
      });

      const result = await service.getFileUrl('doc-1', TENANT_ID, actor);

      expect(result).toEqual({ url: 'https://r2.example.com/signed?x=1', expiresIn: 300 });
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith('k.pdf', TENANT_ID);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'VIEWED', tenantId: TENANT_ID }));
    });

    it('CROSS-TENANT: a document belonging to a DIFFERENT tenant than scopeTenantId is refused as NOT_FOUND — no existence oracle, no signed URL issued', async () => {
      documents.findOne.mockResolvedValueOnce({
        id: 'doc-foreign', doc_type: TYPE_A, storage_key: 'k.pdf', tenant: { id: OTHER_TENANT_ID },
      });

      await expect(service.getFileUrl('doc-foreign', TENANT_ID, actor)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('a genuinely missing document id is ALSO NOT_FOUND — identical to the cross-tenant case (same non-distinguishable error, by design)', async () => {
      documents.findOne.mockResolvedValueOnce(null);
      await expect(service.getFileUrl('nonexistent', TENANT_ID, actor)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('a platform operator (scopeTenantId = null) may resolve ANY tenant\'s document', async () => {
      documents.findOne.mockResolvedValueOnce({
        id: 'doc-any', doc_type: TYPE_A, storage_key: 'k.pdf', tenant: { id: OTHER_TENANT_ID },
      });
      const result = await service.getFileUrl('doc-any', null, actor);
      expect(result.url).toBe('https://r2.example.com/signed?x=1');
    });

    it('a legacy file_url document returns the stored URL directly, with no signed-URL call and no expiresIn', async () => {
      documents.findOne.mockResolvedValueOnce({
        id: 'doc-legacy', doc_type: TYPE_A, storage_key: null, file_url: 'https://legacy.example.com/x.pdf', tenant: { id: TENANT_ID },
      });
      const result = await service.getFileUrl('doc-legacy', TENANT_ID, actor);
      expect(result).toEqual({ url: 'https://legacy.example.com/x.pdf' });
      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('a document with neither storage_key nor file_url is NOT_FOUND ("no associated file")', async () => {
      documents.findOne.mockResolvedValueOnce({
        id: 'doc-empty', doc_type: TYPE_A, storage_key: null, file_url: null, tenant: { id: TENANT_ID },
      });
      await expect(service.getFileUrl('doc-empty', TENANT_ID, actor)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  // ─────────────────── listForTenant() / listMine() (VER-004) ─────────────── //

  describe('listForTenant (VER-004 — REQ-TEN-004, list own documents)', () => {
    it('queries scoped to exactly the given tenant — the query shape a caller\'s listMine()/admin listForTenant() both rely on', async () => {
      await service.listForTenant(TENANT_ID);
      expect(documents.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenant: { id: TENANT_ID } } }),
      );
    });

    it('never leaks another tenant\'s documents into the result (the repository call carries no OR/global clause)', async () => {
      documents.find.mockResolvedValueOnce([
        { id: 'd1', tenant: { id: TENANT_ID } },
        { id: 'd2', tenant: { id: TENANT_ID } },
      ]);
      const result = await service.listForTenant(TENANT_ID);
      expect(result.every((d) => d.tenant.id === TENANT_ID)).toBe(true);
    });
  });

  // ───────────────────────────── listAudit() (VER-005) ─────────────────────── //

  describe('listAudit (VER-005 — REQ-TEN-006, audit trail)', () => {
    it('delegates to VerificationAuditService.listForTenant with the given tenant and a default limit of 100', async () => {
      audit.listForTenant.mockResolvedValueOnce([{ id: 'a1' }]);

      const result = await service.listAudit(TENANT_ID);

      expect(audit.listForTenant).toHaveBeenCalledWith(TENANT_ID, 100);
      expect(result).toEqual([{ id: 'a1' }]);
    });

    it('honors an explicit limit override', async () => {
      await service.listAudit(TENANT_ID, 25);
      expect(audit.listForTenant).toHaveBeenCalledWith(TENANT_ID, 25);
    });
  });
});
