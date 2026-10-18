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
  // Marketplace BE-1 (T056) — specialty correction surface, contract C9.
  SPECIALTY_TENANT_ASSERT: 'platform_admin.specialty.tenant_assert',
  SPECIALTY_TENANT_REMOVE: 'platform_admin.specialty.tenant_remove',
  SPECIALTY_STAFF_ASSERT: 'platform_admin.specialty.staff_assert',
  SPECIALTY_STAFF_REMOVE: 'platform_admin.specialty.staff_remove',
  // FND-031 — system-initiated (userId undefined) subscription grace-lifecycle
  // transitions, reusing this seam per T016/T085 rather than a parallel one.
  SUBSCRIPTION_ENTERED_GRACE: 'subscription.entered_grace',
  SUBSCRIPTION_GRACE_EXPIRED: 'subscription.grace_expired',
  // T085 (spec 014, US5) — the renewal cycle's own attempt/outcome trail,
  // same system-initiated (userId undefined) seam as the two rows above.
  SUBSCRIPTION_RENEWAL_ATTEMPTED: 'subscription.renewal_attempted',
  SUBSCRIPTION_RENEWAL_DECLINED: 'subscription.renewal_declined',
  SUBSCRIPTION_RENEWAL_SETTLED: 'subscription.renewal_settled',
  // Tap migration (Phase 3) — ANY subscription invoice settling (initial
  // payment, upgrade, reactivation), recorded by the single settle path.
  SUBSCRIPTION_PAYMENT_SETTLED: 'subscription.payment_settled',
  // A captured payment that could NOT be applied to its subscription (invoice
  // void/refunded, or the subscription is cancelled/suspended). Money moved;
  // an operator must decide — usually a refund.
  SUBSCRIPTION_PAYMENT_UNAPPLIED: 'subscription.payment_unapplied',
  // A paid-plan subscription cancelled by the system because its first payment never came.
  SUBSCRIPTION_PENDING_PAYMENT_EXPIRED: 'subscription.pending_payment_expired',
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
  SUPPORT_NOTIFICATION_RETRY_REJECTED:
    'platform_support.notification_retry_rejected',
  SUPPORT_INTEGRATION_RECHECKED: 'platform_support.integration_rechecked',
  // Sales Staff Management. `platform_admin.%` so they surface in the Super
  // Admin activity feed automatically; deliberately NOT added to the support
  // desk's allow-list. `tenantId` on the assignment rows is the CLINIC.
  SALES_ASSIGNMENT_CREATED: 'platform_admin.sales.assignment_created',
  SALES_ASSIGNMENT_ENDED: 'platform_admin.sales.assignment_ended',
  SALES_ASSIGNMENT_TRANSFERRED: 'platform_admin.sales.assignment_transferred',
  SALES_IMPORT_COMMITTED: 'platform_admin.sales.import_committed',
  SALES_TARGET_SET: 'platform_admin.sales.target_set',
  SALES_TARGET_DELETED: 'platform_admin.sales.target_deleted',
  SALES_BONUS_APPROVED: 'platform_admin.sales.bonus_approved',
  SALES_BONUS_MARKED_PAID: 'platform_admin.sales.bonus_marked_paid',
  SALES_BONUS_VOIDED: 'platform_admin.sales.bonus_voided',
  SALES_ACTIVITY_LOGGED: 'platform_admin.sales.activity_logged',
  SALES_ACTIVITY_DELETED: 'platform_admin.sales.activity_deleted',
  // Tap migration (Phase 5) — the platform's own refunds and the reconciliation
  // queue. `platform_admin.%` so they surface in the Super Admin activity feed.
  SUBSCRIPTION_REFUND_REQUESTED: 'platform_admin.subscription.refund_requested',
  SUBSCRIPTION_REFUNDED: 'platform_admin.subscription.refunded',
  SUBSCRIPTION_REFUND_FAILED: 'platform_admin.subscription.refund_failed',
  RECONCILIATION_EXCEPTION_RESOLVED:
    'platform_admin.reconciliation.exception_resolved',
  RECONCILIATION_EXCEPTION_IGNORED:
    'platform_admin.reconciliation.exception_ignored',
  RECONCILIATION_REPORT_IMPORTED:
    'platform_admin.reconciliation.report_imported',
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
          tenant: input.tenantId
            ? ({ id: input.tenantId } as Tenant)
            : undefined,
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
