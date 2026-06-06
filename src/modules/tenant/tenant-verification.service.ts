import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TenantVerificationDocument } from '../../entities/SaaS-Core/TenantVerificationDocument';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { VerificationDocStatus } from '../../entities/enums';
import { CreateVerificationDocumentDto } from './dto/create-verification-document.dto';
import { ReviewVerificationDocumentDto } from './dto/review-verification-document.dto';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Manages clinic verification documents.
 *  - Tenants (owners) submit and list THEIR OWN documents (scoped by tenantId).
 *  - Super-admins list a given tenant's documents and review them.
 */
@Injectable()
export class TenantVerificationService {
  constructor(
    @InjectRepository(TenantVerificationDocument)
    private readonly documents: Repository<TenantVerificationDocument>,
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

  /** Super-admin: approve or reject a submitted document. */
  async review(
    documentId: string,
    reviewerId: string,
    dto: ReviewVerificationDocumentDto,
  ): Promise<TenantVerificationDocument> {
    const doc = await this.documents.findOne({ where: { id: documentId } });
    if (!doc) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Verification document not found',
      });
    }
    doc.status = dto.status;
    doc.reviewed_by = reviewerId;
    doc.review_note = dto.reviewNote;
    return this.documents.save(doc);
  }
}
