import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TenantVerificationDocument } from '../../entities/SaaS-Core/TenantVerificationDocument';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantApprovalStatus, VerificationDocStatus } from '../../entities/enums';
import { CreateVerificationDocumentDto } from './dto/create-verification-document.dto';
import { ReviewVerificationDocumentDto } from './dto/review-verification-document.dto';
import { AppError, ErrorCode } from '../../common/errors';
import { TenantService } from './tenant.service';
import { StorageService } from '../storage/storage.service';
import {
  VerificationAuditService,
  type AuditActor,
} from '../verification-audit/verification-audit.service';
import { AdminNotificationService } from '../admin-notifications/admin-notification.service';
import {
  REQUIRED_DOC_TYPES,
  labelForDocType,
} from './verification.constants';

/**
 * Manages clinic verification documents end-to-end.
 *
 *  - One ACTIVE document per `doc_type`: re-submitting a type REPLACES the record
 *    and deletes the previous R2 object (no duplicates, no orphans).
 *  - SHA-256 dedup: re-uploading byte-identical content for the same type reuses
 *    the existing object and discards the duplicate upload.
 *  - Required-document enforcement: a clinic can only submit-for-review / be
 *    approved once every REQUIRED_DOC_TYPES is present. The backend is the
 *    source of truth — the frontend list is advisory.
 *  - Every privileged action is written to the immutable verification audit log.
 */
@Injectable()
export class TenantVerificationService {
  private readonly logger = new Logger(TenantVerificationService.name);

  constructor(
    @InjectRepository(TenantVerificationDocument)
    private readonly documents: Repository<TenantVerificationDocument>,
    private readonly tenantService: TenantService,
    private readonly storage: StorageService,
    private readonly audit: VerificationAuditService,
    private readonly adminNotifications: AdminNotificationService,
  ) {}

  /**
   * Records (or replaces) the ACTIVE document for a `doc_type`. Requires exactly
   * one file source:
   *  - `storageKey` (preferred): must belong to the tenant AND exist in R2.
   *  - `fileUrl` (legacy/external): stored as-is.
   *
   * Replace semantics: if an active document of the same type already exists,
   * its record is updated in place and its old R2 object is deleted — except
   * when the new file is byte-identical (same SHA-256), in which case the freshly
   * uploaded duplicate object is discarded and the existing object is reused.
   */
  async submit(
    tenantId: string,
    actor: AuditActor,
    dto: CreateVerificationDocumentDto,
  ): Promise<TenantVerificationDocument> {
    const storageKey = dto.storageKey?.trim() || undefined;
    const fileUrl = dto.fileUrl?.trim() || undefined;

    if (!storageKey && !fileUrl) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Provide an uploaded file (storageKey) or a fileUrl.',
      });
    }

    if (storageKey) {
      this.storage.assertKeyBelongsToTenant(storageKey, tenantId);
      const exists = await this.storage.objectExists(storageKey);
      if (!exists) {
        throw new AppError(ErrorCode.BAD_REQUEST, {
          message:
            'Uploaded file was not found in storage. Re-upload the document and try again.',
        });
      }
    }

    const existing = await this.documents.findOne({
      where: { tenant: { id: tenantId }, doc_type: dto.docType },
      order: { created_at: 'DESC' },
    });

    // ── Dedup: identical content for the same type ─────────────────────────
    if (
      existing &&
      storageKey &&
      dto.sha256 &&
      existing.content_hash === dto.sha256 &&
      existing.storage_key
    ) {
      // Discard the duplicate object we just uploaded; reuse the existing one.
      if (storageKey !== existing.storage_key) {
        await this.safeDeleteObject(storageKey);
      }
      existing.status = VerificationDocStatus.PENDING;
      existing.review_note = undefined;
      existing.reviewed_by = undefined;
      const reused = await this.documents.save(existing);
      await this.audit.record({
        tenantId,
        action: 'UPLOADED',
        documentId: reused.id,
        docType: dto.docType,
        actor,
        metadata: { deduped: true, sha256: dto.sha256 },
      });
      return reused;
    }

    // ── Replace: same type, different content ──────────────────────────────
    if (existing) {
      const oldKey = existing.storage_key;
      existing.storage_key = storageKey;
      existing.file_url = fileUrl;
      existing.original_filename = dto.originalFilename;
      existing.mime_type = dto.mimeType;
      existing.size_bytes = dto.sizeBytes;
      existing.content_hash = dto.sha256;
      existing.uploaded_by = actor.id;
      existing.status = VerificationDocStatus.PENDING;
      existing.review_note = undefined;
      existing.reviewed_by = undefined;
      const replaced = await this.documents.save(existing);

      if (oldKey && oldKey !== storageKey) {
        await this.safeDeleteObject(oldKey);
      }
      await this.audit.record({
        tenantId,
        action: 'REPLACED',
        documentId: replaced.id,
        docType: dto.docType,
        actor,
        metadata: { newKey: storageKey, oldKey, sha256: dto.sha256 },
      });
      return replaced;
    }

    // ── Create: first document of this type ────────────────────────────────
    const created = await this.documents.save(
      this.documents.create({
        tenant: { id: tenantId } as Tenant,
        doc_type: dto.docType,
        storage_key: storageKey,
        file_url: fileUrl,
        original_filename: dto.originalFilename,
        mime_type: dto.mimeType,
        size_bytes: dto.sizeBytes,
        content_hash: dto.sha256,
        uploaded_by: actor.id,
        status: VerificationDocStatus.PENDING,
      }),
    );
    await this.audit.record({
      tenantId,
      action: 'UPLOADED',
      documentId: created.id,
      docType: dto.docType,
      actor,
      metadata: { storageKey, sha256: dto.sha256 },
    });
    return created;
  }

  /**
   * Owner finalises submission. Validates that EVERY required document type is
   * present; if any are missing returns 400 with the exact missing types and
   * never advances the tenant. On success, transitions the tenant to
   * PENDING_APPROVAL and notifies super-admins.
   */
  async submitForReview(
    tenantId: string,
    actor: AuditActor,
  ): Promise<{ status: string; missing: string[] }> {
    const missing = await this.missingRequiredTypes(tenantId);
    if (missing.length > 0) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Missing required documents: ${missing
          .map(labelForDocType)
          .join(', ')}.`,
        context: { missing },
      });
    }

    const tenant = await this.tenantService.markPendingApproval(
      tenantId,
      actor.id ?? 'system',
    );

    await this.audit.record({
      tenantId,
      action: 'SUBMITTED',
      actor,
      metadata: { requiredTypes: REQUIRED_DOC_TYPES },
    });

    await this.adminNotifications.create({
      type: 'VERIFICATION_SUBMITTED',
      title: `${tenant.name} submitted verification`,
      body: `${tenant.name} has uploaded all required documents and is awaiting review.`,
      tenantId,
      data: { tenantId, tenantName: tenant.name },
    });

    return { status: tenant.approval_status, missing: [] };
  }

  /**
   * Guard for clinic-level approval: throws 400 if any required document type
   * is missing. Called by the tenant approve action so the platform can't
   * approve a clinic that hasn't supplied its mandatory paperwork.
   */
  async assertReadyForApproval(tenantId: string): Promise<void> {
    const missing = await this.missingRequiredTypes(tenantId);
    if (missing.length > 0) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Cannot approve: missing required documents: ${missing
          .map(labelForDocType)
          .join(', ')}.`,
        context: { missing },
      });
    }
  }

  /**
   * Resolves a viewable URL for a document's file (audited as VIEWED). Private
   * R2 objects yield a short-lived presigned GET; legacy `file_url` rows return
   * their stored URL. `scopeTenantId` is the caller's tenant (null for
   * super-admins) — a mismatch is reported as NOT_FOUND (no cross-tenant leak).
   */
  async getFileUrl(
    documentId: string,
    scopeTenantId: string | null,
    actor: AuditActor,
  ): Promise<{ url: string; expiresIn?: number }> {
    const doc = await this.documents.findOne({
      where: { id: documentId },
      relations: { tenant: true },
    });
    if (!doc || (scopeTenantId && doc.tenant.id !== scopeTenantId)) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Verification document not found',
      });
    }

    await this.audit.record({
      tenantId: doc.tenant.id,
      action: 'VIEWED',
      documentId: doc.id,
      docType: doc.doc_type,
      actor,
      metadata: { storageKey: doc.storage_key },
    });

    if (doc.storage_key) {
      const url = await this.storage.getSignedDownloadUrl(doc.storage_key);
      return { url, expiresIn: this.storage.signedUrlTtlSeconds };
    }
    if (doc.file_url) {
      return { url: doc.file_url };
    }
    throw new AppError(ErrorCode.NOT_FOUND, {
      message: 'This document has no associated file',
    });
  }

  /** Lists documents for a tenant (used both for self-service and admin). */
  listForTenant(tenantId: string): Promise<TenantVerificationDocument[]> {
    return this.documents.find({
      where: { tenant: { id: tenantId } },
      order: { created_at: 'DESC' },
    });
  }

  /** Audit trail for a tenant (super-admin review). */
  listAudit(tenantId: string, limit?: number) {
    return this.audit.listForTenant(tenantId, limit ?? 100);
  }

  /**
   * Super-admin: approve or reject a single document (audited). Granular review
   * remains available for requesting a re-upload of a specific document, but
   * clinic approval is gated separately by {@link assertReadyForApproval}.
   */
  async review(
    documentId: string,
    reviewer: AuditActor,
    dto: ReviewVerificationDocumentDto,
  ): Promise<TenantVerificationDocument> {
    const doc = await this.documents.findOne({
      where: { id: documentId },
      relations: { tenant: true },
    });
    if (!doc) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Verification document not found',
      });
    }

    doc.status = dto.status;
    doc.reviewed_by = reviewer.id;
    doc.review_note = dto.reviewNote;
    const saved = await this.documents.save(doc);

    await this.audit.record({
      tenantId: doc.tenant.id,
      action: dto.status === VerificationDocStatus.APPROVED ? 'APPROVED' : 'REJECTED',
      documentId: doc.id,
      docType: doc.doc_type,
      actor: reviewer,
      metadata: { reviewNote: dto.reviewNote ?? null },
    });

    await this.maybeAdvanceToPendingApproval(doc.tenant.id, reviewer.id ?? 'system');

    return saved;
  }

  // ─────────────────────────── Private helpers ──────────────────────────── //

  /** Required types that have NO active document for this tenant. */
  private async missingRequiredTypes(tenantId: string): Promise<string[]> {
    const docs = await this.documents.find({
      where: { tenant: { id: tenantId } },
      select: { doc_type: true },
    });
    const present = new Set(docs.map((d) => d.doc_type));
    return REQUIRED_DOC_TYPES.filter((t) => !present.has(t));
  }

  /** Deletes an R2 object, swallowing failures (cleanup must not block flow). */
  private async safeDeleteObject(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (err) {
      this.logger.warn(
        `Failed to delete replaced/duplicate object ${key}: ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * Best-effort PENDING_VERIFICATION → PENDING_APPROVAL when no PENDING docs
   * remain after a review. Redundant with the owner's explicit submit-for-review
   * but harmless, and covers clinics reviewed before finalising. Never throws.
   */
  private async maybeAdvanceToPendingApproval(
    tenantId: string,
    actorId: string,
  ): Promise<void> {
    try {
      const tenant = await this.tenantService.findById(tenantId);
      if (tenant.approval_status !== TenantApprovalStatus.PENDING_VERIFICATION) {
        return;
      }
      const hasPending = await this.documents.exists({
        where: {
          tenant: { id: tenantId },
          status: VerificationDocStatus.PENDING,
        },
      });
      if (!hasPending) {
        await this.tenantService.markPendingApproval(tenantId, actorId);
      }
    } catch (err) {
      this.logger.warn(
        `Auto-advance to PENDING_APPROVAL skipped for tenant ${tenantId}: ${(err as Error)?.message}`,
      );
    }
  }
}
