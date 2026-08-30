import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';

/** Additive only — mirrors `INVOICE_AUDIT_ACTION`'s convention. */
export const REPORT_EXPORT_AUDIT_ACTION = {
  EXPORTED: 'report.exported',
} as const;

export type ReportExportAuditAction =
  (typeof REPORT_EXPORT_AUDIT_ACTION)[keyof typeof REPORT_EXPORT_AUDIT_ACTION];

/**
 * Spec 014 (Clinic Platform Completion) — T185 (US13, FR-X012). Records
 * export requests and completions to the shared `audit_logs` table,
 * mirroring `InvoiceAuditService`'s pattern exactly.
 *
 * `'report.exported'` is already on the T023 allow-list
 * (`activity-log/activity-allowlist.ts`) — this service is what actually
 * writes it. ONE action string covers both lifecycle points (request and
 * completion); they are told apart by `new_values.stage` ('requested' vs
 * 'completed'), never by a second action string, so the clinic-facing
 * activity log surfaces both without needing a second allow-list entry.
 *
 * Records the report key and filters only — NEVER the exported row data
 * (FR-X012's own security note: export is a data-egress action, and the
 * audit trail of it must not become a second copy of the data it egressed).
 * Best-effort: a logging failure never blocks the export it accompanies.
 */
@Injectable()
export class ReportExportAuditService {
  private readonly logger = new Logger(ReportExportAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async recordRequested(
    tenantId: string,
    exportJobId: string,
    report: string,
    filters: Record<string, unknown>,
    actorUserId?: string,
  ): Promise<void> {
    await this.write(tenantId, exportJobId, actorUserId, {
      stage: 'requested',
      report,
      filters,
    });
  }

  async recordCompleted(
    tenantId: string,
    exportJobId: string,
    report: string,
    filters: Record<string, unknown>,
    rowCount: number,
    actorUserId?: string,
  ): Promise<void> {
    await this.write(tenantId, exportJobId, actorUserId, {
      stage: 'completed',
      report,
      filters,
      rowCount,
    });
  }

  private async write(
    tenantId: string,
    exportJobId: string,
    actorUserId: string | undefined,
    new_values: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: tenantId } as Tenant,
          user: actorUserId ? ({ id: actorUserId } as User) : undefined,
          action: REPORT_EXPORT_AUDIT_ACTION.EXPORTED,
          entity_type: 'ExportJob',
          entity_id: exportJobId,
          new_values,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Report-export audit write failed (${new_values.stage}): ${(err as Error)?.message}`,
      );
    }
  }
}
