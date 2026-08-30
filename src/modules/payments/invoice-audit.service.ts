import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';

/** Additive only — mirrors `APPOINTMENT_AUDIT_ACTION`'s convention. */
export const INVOICE_AUDIT_ACTION = {
  DOCUMENT_DOWNLOADED: 'invoice.document_downloaded',
} as const;

export type InvoiceAuditAction =
  (typeof INVOICE_AUDIT_ACTION)[keyof typeof INVOICE_AUDIT_ACTION];

/**
 * Spec 014 (Clinic Platform Completion) — T097 (US12, FR-I014). Records
 * invoice-domain actions to the shared `audit_logs` table, mirroring
 * `AppointmentAuditService`'s pattern. Best-effort: a logging failure never
 * blocks the download it accompanies.
 */
@Injectable()
export class InvoiceAuditService {
  private readonly logger = new Logger(InvoiceAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async record(
    action: InvoiceAuditAction,
    tenantId: string,
    invoiceId: string,
    actorUserId?: string,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: tenantId } as Tenant,
          user: actorUserId ? ({ id: actorUserId } as User) : undefined,
          action,
          entity_type: 'Invoice',
          entity_id: invoiceId,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Invoice audit write failed (${action}): ${(err as Error)?.message}`,
      );
    }
  }
}
