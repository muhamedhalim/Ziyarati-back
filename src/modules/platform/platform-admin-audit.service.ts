import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

/** FND-015 — additive action values only; never repurpose an existing one (Principle XX). */
export const PLATFORM_ADMIN_AUDIT_ACTION = {
  BILLING_MODE_SET: 'platform_admin.billing_mode.set',
  PLAN_CREATE: 'platform_admin.plan.create',
  PLAN_UPDATE: 'platform_admin.plan.update',
  PLAN_UPDATE_REJECTED: 'platform_admin.plan.update_rejected',
  PLAN_ACTIVATE: 'platform_admin.plan.activate',
  PLAN_DEACTIVATE: 'platform_admin.plan.deactivate',
  OVERRIDE_GRANT: 'platform_admin.override.grant',
  OVERRIDE_GRANT_REJECTED: 'platform_admin.override.grant_rejected',
  OVERRIDE_EXTEND: 'platform_admin.override.extend',
  OVERRIDE_REVOKE: 'platform_admin.override.revoke',
  SETTING_CREATE: 'platform_admin.system_setting.create',
  SETTING_CREATE_REJECTED: 'platform_admin.system_setting.create_rejected',
  SETTING_UPDATE: 'platform_admin.system_setting.update',
  SETTING_DELETE: 'platform_admin.system_setting.delete',
  SETTING_UPSERT: 'platform_admin.system_setting.upsert',
  GATEWAY_CREATE: 'platform_admin.payment_gateway.create',
  GATEWAY_UPDATE: 'platform_admin.payment_gateway.update',
  // FND-031 — system-initiated (userId undefined) subscription grace-lifecycle
  // transitions, reusing this seam per T016/T085 rather than a parallel one.
  SUBSCRIPTION_ENTERED_GRACE: 'subscription.entered_grace',
  SUBSCRIPTION_GRACE_EXPIRED: 'subscription.grace_expired',
  // Platform Customer Service staff provisioning (PlatformStaffService).
  STAFF_CREATE: 'platform_admin.staff.create',
  STAFF_UPDATE: 'platform_admin.staff.update',
  STAFF_ACTIVATE: 'platform_admin.staff.activate',
  STAFF_DEACTIVATE: 'platform_admin.staff.deactivate',
  STAFF_ROLES_SET: 'platform_admin.staff.roles_set',
  STAFF_INVITATION_RESENT: 'platform_admin.staff.invitation_resent',
  STAFF_MUTATION_REJECTED: 'platform_admin.staff.mutation_rejected',
  // Support Operations Console safe actions. Recorded through this same
  // writer rather than a parallel one so every platform-side action a human
  // takes on a clinic's behalf lands in one trail — and so `tenantId` (the
  // TARGET clinic, not the actor's tenant, which is always null for platform
  // staff) is populated by the mechanism that already handles that case.
  SUPPORT_EMAIL_RESENT: 'platform_support.email_resent',
  SUPPORT_EMAIL_RESEND_REJECTED: 'platform_support.email_resend_rejected',
  SUPPORT_NOTIFICATION_RETRIED: 'platform_support.notification_retried',
  SUPPORT_NOTIFICATION_RETRY_REJECTED: 'platform_support.notification_retry_rejected',
  SUPPORT_INTEGRATION_RECHECKED: 'platform_support.integration_rechecked',
} as const;

export type PlatformAdminAuditAction =
  (typeof PLATFORM_ADMIN_AUDIT_ACTION)[keyof typeof PLATFORM_ADMIN_AUDIT_ACTION];

export interface PlatformAdminAuditInput {
  action: PlatformAdminAuditAction;
  /** The acting super admin. Undefined only for a system-initiated call (no HTTP caller). */
  userId?: string | null;
  entityType: string;
  entityId?: string | null;
  /** The tenant this mutation concerns (free-access overrides only) — NOT the actor's tenant. */
  tenantId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * Records platform-admin financial/config mutations to the shared `audit_logs`
 * table, mirroring `ApiKeyAuditService`'s pattern (same file shape, same
 * best-effort save-and-log-on-failure). Covers the 5 mutation groups FND-015
 * found unaudited: global billing mode, plan CRUD, system settings (incl.
 * maintenance mode), free-access overrides, and payment-gateway config.
 *
 * Called from the SERVICE layer (never the controller) so no caller — existing
 * or future, HTTP or internal — can bypass it (AD-14). Best-effort: a logging
 * failure never blocks the mutation it accompanies; these routes are already
 * super-admin-gated, so this trail is for accountability and incident review,
 * not access control.
 */
@Injectable()
export class PlatformAdminAuditService {
  private readonly logger = new Logger(PlatformAdminAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async record(input: PlatformAdminAuditInput): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: input.tenantId ? ({ id: input.tenantId } as Tenant) : undefined,
          user: input.userId ? ({ id: input.userId } as User) : undefined,
          action: input.action,
          entity_type: input.entityType,
          entity_id: input.entityId ?? undefined,
          old_values: input.before ?? undefined,
          new_values: input.after ?? undefined,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Platform-admin audit write failed (${input.action}): ${(err as Error)?.message}`,
      );
    }
  }
}
