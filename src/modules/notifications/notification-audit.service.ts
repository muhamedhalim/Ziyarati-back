import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

/** FND-013 — additive action values only; never repurpose an existing one (Principle XX). */
export const NOTIFICATION_AUDIT_ACTION = {
  RETRY_OVERRIDE: 'notification.retry_override',
} as const;

export type NotificationAuditAction =
  (typeof NOTIFICATION_AUDIT_ACTION)[keyof typeof NOTIFICATION_AUDIT_ACTION];

/**
 * Records notification-lifecycle operator overrides to the shared
 * `audit_logs` table, mirroring `ApiKeyAuditService`'s pattern. Best-effort:
 * a logging failure never blocks the retry it accompanies.
 *
 * AD-03: an operator's explicit `retry()` on a notification whose
 * `send_attempted` guard was already set is a deliberate human override of
 * the platform's at-most-once send guarantee — the operator is asserting
 * (typically after checking the provider console) that the prior attempt did
 * not actually reach the customer. That override is exactly the kind of
 * sensitive action constitution Principle XXVI requires be audited.
 */
@Injectable()
export class NotificationAuditService {
  private readonly logger = new Logger(NotificationAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async record(
    action: NotificationAuditAction,
    tenantId: string,
    userId: string | undefined,
    notificationId: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: tenantId } as Tenant,
          user: userId ? ({ id: userId } as User) : undefined,
          action,
          entity_type: 'ScheduledNotification',
          entity_id: notificationId,
          new_values: details,
        }),
      );
    } catch (err) {
      this.logger.warn(`Notification audit write failed (${action}): ${(err as Error)?.message}`);
    }
  }
}
