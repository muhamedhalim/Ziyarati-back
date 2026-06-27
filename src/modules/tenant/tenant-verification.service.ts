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

/**
 * Manages clinic verification documents.
 *  - Tenants (owners) submit and list THEIR OWN documents (scoped by tenantId).
 *  - Super-admins list a given tenant's documents and review them.
 *
 * Auto-advance: when a super-admin reviews the last PENDING document for a tenant
 * that is still in PENDING_VERIFICATION, the tenant is automatically transitioned
 * to PENDING_APPROVAL so the admin can make the final approve/reject decision.
 */
@Injectable()
export class TenantVerificationService {
  private readonly logger = new Logger(TenantVerificationService.name);

  constructor(
    @InjectRepository(TenantVerificationDocument)
    private readonly documents: Repository<TenantVerificationDocument>,
    private readonly tenantService: TenantService,
  ) {}

  submit(
    tenantId: string,
    dto: CreateVerificationDocumentDto,
  ): Promise<TenantVerificationDocument> {
    const doc = this.documents.create({
      tenant: { id: tenantId } as Tenant,
      doc_type: dto.docType,
      file_url: dto.fileUrl,
      status: VerificationDocStatus.PENDING,
    });
    return this.documents.save(doc);
  }

  /** Lists documents for a tenant (used both for self-service and admin). */
  listForTenant(tenantId: string): Promise<TenantVerificationDocument[]> {
    return this.documents.find({
      where: { tenant: { id: tenantId } },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Super-admin: approve or reject a submitted document.
   *
   * Side-effect: when this review eliminates the last PENDING document for
   * a tenant still in PENDING_VERIFICATION, the tenant is automatically
   * transitioned to PENDING_APPROVAL so the final approve/reject action
   * can be taken via POST /tenants/:id/approve|reject.
   */
  async review(
    documentId: string,
    reviewerId: string,
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
    doc.reviewed_by = reviewerId;
    doc.review_note = dto.reviewNote;
    const saved = await this.documents.save(doc);

    await this.maybeAdvanceToPendingApproval(doc.tenant.id, reviewerId);

    return saved;
  }

  // ─────────────────────────── Private helpers ──────────────────────────── //

  /**
   * Transitions the tenant from PENDING_VERIFICATION → PENDING_APPROVAL when
   * every submitted document has been reviewed (none left in PENDING state).
   *
   * Conditions:
   *  1. Tenant is still in PENDING_VERIFICATION.
   *  2. At least one document was submitted (implied — we just reviewed one).
   *  3. No remaining PENDING documents for this tenant.
   *
   * Errors here are logged but never propagated — the document review must
   * succeed even if the auto-advance fails (e.g. race condition where another
   * reviewer already advanced the tenant).
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
      // Log and swallow — the review succeeded; the auto-advance is best-effort.
      // A failed transition (e.g. tenant already PENDING_APPROVAL) is harmless.
      this.logger.warn(
        `Auto-advance to PENDING_APPROVAL skipped for tenant ${tenantId}: ${(err as Error)?.message}`,
      );
    }
  }
}
