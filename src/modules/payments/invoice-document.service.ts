import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Invoice } from '../../entities/Payments/Invoice';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { InvoiceStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import type { InvoiceDocumentData } from '../documents/templates/invoice.template';

import { InvoiceItemService } from './invoice-item.service';

/**
 * Spec 014 (Clinic Platform Completion) — T091/T094 (US12, FR-I001, FR-I002,
 * FR-I007).
 *
 * Assembles `InvoiceDocumentData` for the invoice template — pure data
 * composition, no PDF rendering. Deliberately does NOT depend on
 * `DocumentRendererService` (worker-role-only, see its own docblock): this
 * service lives in `payments`, a module used by BOTH the API and worker
 * processes, so it must stay constructible in either. The actual render call
 * (`DocumentRendererService.render(new InvoiceTemplate(), data, locale)`)
 * happens only in `AnalyticsProcessor` (T095), the one place PDF rendering
 * is allowed to run.
 *
 * `Invoice.currency` is the ONLY identity field this service reads from a
 * value snapshotted at issue time (T092/T093, FR-I005) — the clinic's
 * name/legal name/registration number and the patient's name/contact are
 * read LIVE from `Tenant`/`Customer` (no snapshot column exists for them;
 * FR-I003's broader "reflects clinic/patient identity at issue time" claim
 * is therefore only partially satisfied — see the spec-014 execution report
 * for this documented gap).
 */
@Injectable()
export class InvoiceDocumentService {
  constructor(
    @InjectRepository(Invoice)
    private readonly invoices: Repository<Invoice>,
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
    private readonly itemsService: InvoiceItemService,
  ) {}

  /** The clinic's own document locale (FR-I011) — never a caller-supplied value. */
  async localeFor(tenantId: string): Promise<'ar' | 'en'> {
    const settings = await this.tenantSettings.findOne({
      where: { tenant: { id: tenantId } },
    });
    return settings?.default_language === 'en' ? 'en' : 'ar';
  }

  /** Throws NOT_FOUND (cross-tenant-indistinguishable, FR-I008) or 409 for a DRAFT invoice (FR-I007). */
  async buildDocumentData(
    tenantId: string,
    invoiceId: string,
  ): Promise<InvoiceDocumentData> {
    const invoice = await this.invoices.findOne({
      where: { id: invoiceId, tenant: { id: tenantId } },
      relations: { tenant: true, customer: true },
    });
    if (!invoice) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Invoice not found' });
    }
    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A draft invoice cannot be rendered as a document',
      });
    }

    const items = await this.itemsService.listForInvoice(tenantId, invoiceId);

    return {
      clinic: {
        name: invoice.tenant.name,
        legalName: invoice.tenant.legal_name,
        registrationNumber: invoice.tenant.commercial_registration_number,
        contactEmail: invoice.tenant.contact_email,
        contactPhone: invoice.tenant.contact_phone,
      },
      patient: invoice.customer
        ? {
            name: invoice.customer.full_name,
            phone: invoice.customer.phone,
            email: invoice.customer.email,
          }
        : null,
      invoiceNumber: invoice.invoice_number,
      issuedAt: (invoice.issued_at ?? invoice.created_at).toISOString(),
      currency: invoice.currency,
      status: invoice.status,
      items: items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: Number(item.unit_price),
        lineTotal: Number(item.total_price),
      })),
      total: Number(invoice.total_amount),
    };
  }

  /**
   * T095 — persists a successful render. Guarded on `documentVersion >=
   * document_rendered_version`: a redelivered/stale job for an OLDER
   * version must never regress an already-rendered NEWER one (the version
   * that "wins" a race is whichever is highest, not whichever writes last).
   */
  async markRendered(
    tenantId: string,
    invoiceId: string,
    documentVersion: number,
    documentKey: string,
  ): Promise<void> {
    await this.invoices
      .createQueryBuilder()
      .update(Invoice)
      .set({
        document_key: documentKey,
        document_rendered_version: documentVersion,
      })
      .where('id = :invoiceId AND "tenantId" = :tenantId', {
        invoiceId,
        tenantId,
      })
      .andWhere(
        '(document_rendered_version IS NULL OR document_rendered_version <= :documentVersion)',
        { documentVersion },
      )
      .execute();
  }
}
