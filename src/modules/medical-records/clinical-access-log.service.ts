import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClinicalAccessLog } from '../../entities/Clinical/ClinicalAccessLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Customer } from '../../entities/CRM/Customer';
import { User } from '../../entities/Auth&RBAC/User';
import { ClinicalEntry } from '../../entities/Clinical/ClinicalEntry';

/**
 * What was read. The first three are the clinical record proper; the rest are
 * the other places health data (D4) is readable from — added by the residency
 * plan (P14) so a read of a patient's profile, notes or documents leaves the
 * same who / which patient / when trail a clinical entry does. `export` and
 * `erasure` record a data-subject request being fulfilled.
 */
export type ClinicalAccessScope =
  | 'timeline'
  | 'summary'
  | 'entry'
  | 'profile'
  | 'notes'
  | 'files'
  | 'export'
  | 'erasure';

/**
 * Spec 014 (Clinic Platform Completion) — T110 (US6, FR-H011, FR-H012).
 *
 * Appends a row to `clinical_access_logs` on every clinical READ — who read
 * which patient's record, when, and at what scope. Best-effort (a logging
 * failure never blocks the read it accompanies, mirroring
 * `AppointmentAuditService`/`InvoiceAuditService`) — BUT a persistent
 * failure must stay visible: logged at `error`, not silently swallowed,
 * since a read this service fails to log is a read with no accountability
 * trail (FR-H011's entire purpose).
 *
 * Deliberately writes to `clinical_access_logs`, NEVER `audit_logs` —
 * clinical reads are high-volume and must never surface in the Audit UI
 * (FR-H012, FR-U008).
 */
@Injectable()
export class ClinicalAccessLogService {
  private readonly logger = new Logger(ClinicalAccessLogService.name);

  constructor(
    @InjectRepository(ClinicalAccessLog)
    private readonly accessLogs: Repository<ClinicalAccessLog>,
  ) {}

  async record(
    tenantId: string,
    customerId: string,
    userId: string,
    scope: ClinicalAccessScope,
    entryId?: string,
  ): Promise<void> {
    try {
      await this.accessLogs.save(
        this.accessLogs.create({
          tenant: { id: tenantId } as Tenant,
          customer: { id: customerId } as Customer,
          user: { id: userId } as User,
          scope,
          entry: entryId ? ({ id: entryId } as ClinicalEntry) : undefined,
        }),
      );
    } catch (err) {
      this.logger.error(
        `CLINICAL_ACCESS_LOG_WRITE_FAILED: Clinical access log write FAILED (tenant=${tenantId}, customer=${customerId}, ` +
          `user=${userId}, scope=${scope}): ${(err as Error)?.message}`,
      );
    }
  }
}
