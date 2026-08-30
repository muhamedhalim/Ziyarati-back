import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

/** Mirrors `APPOINTMENT_AUDIT_ACTION`'s convention — additive only. Both
 *  values are already seeded in `activity-allowlist.ts`'s
 *  `ACTIVITY_VISIBLE_AUDIT_ACTIONS` (T023). */
export const CAMPAIGN_AUDIT_ACTION = {
  LAUNCHED: 'campaign.launched',
  UNSUBSCRIBED: 'campaign.unsubscribed',
} as const;

export type CampaignAuditAction =
  (typeof CAMPAIGN_AUDIT_ACTION)[keyof typeof CAMPAIGN_AUDIT_ACTION];

/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T139).
 *
 * Records campaign-domain marketing actions to the shared `audit_logs`
 * table, mirroring `AppointmentAuditService`'s pattern. Best-effort: a
 * logging failure never blocks the campaign launch or unsubscribe it
 * accompanies.
 *
 * SECURITY (T139's own requirement): `details` must record the campaign id
 * and clinic ONLY — never a recipient email address or any other PII. Every
 * call site is responsible for not passing one; this service does not
 * attempt to scrub `details` itself (there is nothing address-shaped to
 * strip generically without risking silently dropping legitimate fields).
 */
@Injectable()
export class CampaignAuditService {
  private readonly logger = new Logger(CampaignAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async record(
    action: CampaignAuditAction,
    tenantId: string,
    entityId: string | undefined,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: tenantId } as Tenant,
          action,
          entity_type: 'Campaign',
          entity_id: entityId,
          new_values: details,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Campaign audit write failed (${action}): ${(err as Error)?.message}`,
      );
    }
  }
}
